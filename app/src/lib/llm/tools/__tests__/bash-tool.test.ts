// bash 工具单测（v0.7 阶段4b：安全闸 + 执行）
//
// L6 安全网收拢（2026-07-09）：checkCommand 现在由 executor 按 tool.security 声明统一跑，
// 工具自己不再调用——测试改走 executeTool（跟生产路径一致）。
//
// 引擎化阶段 1a：executor-security 在调 checkCommand 前会先 await resolveAllowedPrograms
// 从 PolicyStore 拿 builtin ∪ project/global override。本测试不关心 override 行为，
// 只关心安全闸主路径，所以把 PolicyStore mock 掉：get 永远返回 null（无 override，
// resolveAllowedPrograms 直接回 builtin）。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { setShellAdapter, type ShellAdapter } from "../shell-adapter";
import { bashTool } from "../bash-tool";
import { executeTool } from "../executor";
import type { ToolContext } from "../types";
import { invalidateAllowlistResolveCache } from "@/lib/policy/command-allowlist";

const dbMocks = vi.hoisted(() => ({
  create: vi.fn().mockResolvedValue("id"),
}));
vi.mock("../../../db", () => ({
  toolExecutions: { create: dbMocks.create },
}));

const policyStoreMocks = vi.hoisted(() => ({
  get: vi.fn().mockResolvedValue(null),
  set: vi.fn().mockResolvedValue(undefined),
  clear: vi.fn().mockResolvedValue(false),
  reset: vi.fn().mockResolvedValue(undefined),
  listOverrides: vi.fn().mockResolvedValue([]),
  listConfiguredKeys: vi.fn().mockResolvedValue([]),
  history: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/policy/policy-store", () => ({
  PolicyStore: class {},
  PolicyStoreError: class extends Error {},
  policyStore: policyStoreMocks,
}));

let runArgsSpy: ReturnType<typeof vi.fn>;
let runSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  invalidateAllowlistResolveCache();
  policyStoreMocks.get.mockResolvedValue(null);
  runArgsSpy = vi.fn().mockResolvedValue({ stdout: "ok", stderr: "", code: 0 });
  // run（sh -c）保留但 AI 工具不应再调用它——D2 强保证：所有执行都走 runArgs。
  runSpy = vi.fn().mockResolvedValue({ stdout: "", stderr: "", code: 0 });
  const adapter: ShellAdapter = {
    run: runSpy as any,
    runArgs: runArgsSpy as any,
  };
  setShellAdapter(adapter);
});

function ctx(
  confirm?: ToolContext["confirm"],
  blocked?: string[],
  withCommandAuthorization = true,
): ToolContext {
  // 阶段2（2026-07-11）：每个测试用独立 messageId 隔离 doom-loop 状态，
  // 避免模块级 doomLoopGlobal/ByMessage 在测试间互相污染——同 messageId + 同 tool+input 连续 3 次才会触发拦截。
  return {
    workspacePath: "/ws",
    messageId: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ...(confirm ? { confirm } : {}),
    ...(withCommandAuthorization && confirm
      ? { commandAuthorization: { permissionMode: "confirm" as const, requestHumanConfirm: confirm } }
      : {}),
    ...(blocked ? { blockedCommands: blocked } : {}),
  };
}

describe("bash 工具 — 安全闸", () => {
  it("只有 generic confirm 没有 commandAuthorization 时，命令仍拒绝且不执行", async () => {
    const confirm = vi.fn().mockResolvedValue(true);
    const r = await executeTool(bashTool, { command: "pnpm test" }, ctx(confirm, undefined, false));
    expect(r.status).toBe("denied");
    expect(confirm).not.toHaveBeenCalled();
    expect(runArgsSpy).not.toHaveBeenCalled();
  });
  it("危险命令被拦截，不弹确认、不执行", async () => {
    const confirm = vi.fn().mockResolvedValue(true);
    const r = await executeTool(bashTool, { command: "rm -rf /" }, ctx(confirm));
    expect(r.status).toBe("denied");
    expect(confirm).not.toHaveBeenCalled();
    expect(runSpy).not.toHaveBeenCalled();
  });

  it("非白名单命令被拦截", async () => {
    const r = await executeTool(bashTool, { command: "brew install x" }, ctx(vi.fn().mockResolvedValue(true)));
    expect(r.status).toBe("denied");
    expect(runSpy).not.toHaveBeenCalled();
  });

  it.each(["env", "printenv"])("环境变量读取包装器被拦截，不弹确认、不执行：%s", async (command) => {
    const confirm = vi.fn().mockResolvedValue(true);
    const r = await executeTool(bashTool, { command }, ctx(confirm));
    expect(r.status).toBe("denied");
    expect(confirm).not.toHaveBeenCalled();
    expect(runArgsSpy).not.toHaveBeenCalled();
    expect(runSpy).not.toHaveBeenCalled();
  });

  it.each([
    ["/usr/bin/env", "/usr/bin/env"],
    ["'C:\\Windows\\System32\\env.exe'", "C:\\Windows\\System32\\env.exe"],
  ])("真实 override 链仍硬拒绝精确覆盖命令：%s", async (command, token) => {
    policyStoreMocks.get.mockImplementation(async (_key: string, scope: { level: string }) => {
      if (scope.level === "global") return JSON.stringify(["env", token]);
      return null;
    });
    invalidateAllowlistResolveCache();
    const confirm = vi.fn().mockResolvedValue(true);
    const r = await executeTool(bashTool, { command }, ctx(confirm));
    expect(r.status).toBe("denied");
    expect(r.output).toContain("被安全策略禁止");
    expect(r.error?.rootCauseHint).toContain("被安全策略禁止");
    expect(confirm).not.toHaveBeenCalled();
    expect(runArgsSpy).not.toHaveBeenCalled();
    expect(runSpy).not.toHaveBeenCalled();
  });

  it("项目黑名单命中拦截", async () => {
    const r = await executeTool(bashTool, { command: "pnpm deploy" }, ctx(vi.fn().mockResolvedValue(true), ["deploy"]));
    expect(r.status).toBe("denied");
  });

  it("无确认通道 → 拒绝，不执行", async () => {
    const r = await executeTool(bashTool, { command: "pnpm test" }, ctx());
    expect(r.status).toBe("denied");
    expect(runSpy).not.toHaveBeenCalled();
  });

  it("用户拒绝 → 不执行", async () => {
    const confirm = vi.fn().mockResolvedValue(false);
    const r = await executeTool(bashTool, { command: "pnpm test" }, ctx(confirm));
    expect(r.status).toBe("denied");
    expect(runSpy).not.toHaveBeenCalled();
  });

  it.each(["git status", "ls"])('只读命令缺 commandAuthorization 也拒绝且不执行：%s', async (command) => {
    const r = await executeTool(bashTool, { command }, ctx());
    expect(r.status).toBe("denied");
    expect(runArgsSpy).not.toHaveBeenCalled();
  });

  it.each(["git status", "ls"])('只读命令 read 档即使有 callback 也拒绝且不回调：%s', async (command) => {
    const requestHumanConfirm = vi.fn().mockResolvedValue(true);
    const r = await executeTool(bashTool, { command }, {
      ...ctx(undefined, undefined, false),
      commandAuthorization: { permissionMode: "read", requestHumanConfirm },
    });
    expect(r.status).toBe("denied");
    expect(requestHumanConfirm).not.toHaveBeenCalled();
    expect(runArgsSpy).not.toHaveBeenCalled();
  });

  it.each([["confirm", "git status"], ["auto", "ls"]] as const)(
    '只读命令 confirm/auto 有完整授权对象时成功且不回调：%s %s',
    async (permissionMode, command) => {
      const requestHumanConfirm = vi.fn().mockResolvedValue(true);
      const r = await executeTool(bashTool, { command }, {
        ...ctx(undefined, undefined, false),
        commandAuthorization: { permissionMode, requestHumanConfirm },
      });
      expect(r.status).toBe("success");
      expect(requestHumanConfirm).not.toHaveBeenCalled();
      expect(runArgsSpy).toHaveBeenCalledWith(command === "git status" ? ["git", "status"] : ["ls"], "/ws");
    },
  );

  it.each(["confirm", "auto"] as const)(
    '只读命令授权对象缺 callback 时拒绝且不执行：%s',
    async (permissionMode) => {
      const r = await executeTool(bashTool, { command: "git status" }, {
        ...ctx(undefined, undefined, false),
        commandAuthorization: { permissionMode },
      });
      expect(r.status).toBe("denied");
      expect(runArgsSpy).not.toHaveBeenCalled();
    },
  );
});

describe("bash 工具 — 执行", () => {
  it.each(["pnpm test", "node -e 'console.log(1)'", "bash -c 'echo ok'", "curl https://example.com"])(
    "confirm 命令走独立真人确认：%s",
    async (command) => {
      const requestHumanConfirm = vi.fn().mockResolvedValue(true);
      const genericConfirm = vi.fn().mockResolvedValue(true);
      const r = await executeTool(
        bashTool,
        { command },
        {
          ...ctx(genericConfirm, undefined, false),
          commandAuthorization: { permissionMode: "confirm", requestHumanConfirm },
        },
      );
      expect(r.status).toBe("success");
      expect(requestHumanConfirm).toHaveBeenCalledTimes(1);
      expect(genericConfirm).not.toHaveBeenCalled();
    },
  );

  it("auto 命令仍走独立真人确认，不复用自动写入确认", async () => {
    const requestHumanConfirm = vi.fn().mockResolvedValue(true);
    const genericConfirm = vi.fn().mockResolvedValue(true);
    const r = await executeTool(
      bashTool,
      { command: "pnpm test" },
      {
        ...ctx(genericConfirm, undefined, false),
        commandAuthorization: { permissionMode: "auto", requestHumanConfirm },
      },
    );
    expect(r.status).toBe("success");
    expect(requestHumanConfirm).toHaveBeenCalledTimes(1);
    expect(genericConfirm).not.toHaveBeenCalled();
  });

  it("独立真人确认拒绝时不执行", async () => {
    const requestHumanConfirm = vi.fn().mockResolvedValue(false);
    const r = await executeTool(bashTool, { command: "pnpm test" }, {
      ...ctx(vi.fn().mockResolvedValue(true), undefined, false),
      commandAuthorization: { permissionMode: "confirm", requestHumanConfirm },
    });
    expect(r.status).toBe("denied");
    expect(runArgsSpy).not.toHaveBeenCalled();
  });

  it("独立真人确认抛错时不执行", async () => {
    const requestHumanConfirm = vi.fn().mockRejectedValue(new Error("dialog closed"));
    const r = await executeTool(bashTool, { command: "pnpm test" }, {
      ...ctx(undefined, undefined, false),
      commandAuthorization: { permissionMode: "confirm", requestHumanConfirm },
    });
    expect(r.status).toBe("denied");
    expect(runArgsSpy).not.toHaveBeenCalled();
  });

  it("read 权限档即使存在 callback 也拒绝命令", async () => {
    const requestHumanConfirm = vi.fn().mockResolvedValue(true);
    const r = await executeTool(bashTool, { command: "pnpm test" }, {
      ...ctx(undefined, undefined, false),
      commandAuthorization: { permissionMode: "read", requestHumanConfirm },
    });
    expect(r.status).toBe("denied");
    expect(requestHumanConfirm).not.toHaveBeenCalled();
    expect(runArgsSpy).not.toHaveBeenCalled();
  });

  it("白名单 + 确认 → 走 runArgs（program+args，不经 sh -c），返回 stdout + exit", async () => {
    const confirm = vi.fn().mockResolvedValue(true);
    const r = await executeTool(bashTool, { command: "pnpm test" }, ctx(confirm));
    expect(r.status).toBe("success");
    expect(runArgsSpy).toHaveBeenCalledWith(["pnpm", "test"], "/ws");
    // D2 强保证：AI 工具不再走 sh -c
    expect(runSpy).not.toHaveBeenCalled();
    expect(r.output).toContain("ok");
    expect(r.output).toContain("exit code: 0");
  });

  // 2026-07-15 review 修复回归测试：userConfirmed 必须反映"是不是真的弹过确认框"，
  // 不能靠 status/tool.readOnly 反推——bash 工具整体 readOnly=false，但只读命令
  // （git status 这类）会跳过 requireApprovalAsV2，旧的反推逻辑会把这种"系统免确认"
  // 误记成"用户确认过"。
  it("只读命令免确认执行 → userConfirmed 应为 false（系统判定安全免确认，不是用户点了同意），且落库的审计记录也如实记这个 false", async () => {
    dbMocks.create.mockClear();
    const confirm = vi.fn();
    const r = await executeTool(bashTool, { command: "git status" }, ctx(confirm));
    expect(r.status).toBe("success");
    expect(confirm).not.toHaveBeenCalled();
    expect(r.userConfirmed).toBe(false);
    // 真正的 bug 点在这里：persistToolExecution 落库前不能靠 status/tool.readOnly 反推，
    // 必须原样透传工具自己报的 userConfirmed，不能被"bash 整体 readOnly=false"污染成 true。
    expect(dbMocks.create).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "bash", userConfirmed: false }),
    );
  });

  it("写命令真的弹过确认框并被同意 → userConfirmed 应为 true，落库审计记录也一致", async () => {
    dbMocks.create.mockClear();
    const confirm = vi.fn().mockResolvedValue(true);
    const r = await executeTool(bashTool, { command: "pnpm install" }, ctx(confirm));
    expect(r.status).toBe("success");
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(r.userConfirmed).toBe(true);
    expect(dbMocks.create).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "bash", userConfirmed: true }),
    );
  });

  it("非零退出码 → status=error", async () => {
    runArgsSpy.mockResolvedValue({ stdout: "", stderr: "test failed", code: 1 });
    const r = await executeTool(bashTool, { command: "pnpm test" }, ctx(vi.fn().mockResolvedValue(true)));
    expect(r.status).toBe("error");
    expect(r.output).toContain("stderr");
    expect(r.output).toContain("exit code: 1");
  });

  it("执行抛错 → status=error", async () => {
    runArgsSpy.mockRejectedValue(new Error("spawn failed"));
    const r = await executeTool(bashTool, { command: "git status" }, ctx(vi.fn().mockResolvedValue(true)));
    expect(r.status).toBe("error");
    expect(r.output).toMatch(/spawn failed/);
  });
});

describe("D2：bash 工具走 program+args，组合/注入命令被拦截", () => {
  it("合法简单命令：参数里的 shell 元字符被当普通字符串，不触发第二条命令", async () => {
    // echo 是只读命令，免确认；参数 "a && b | c" 含 shell 元字符但被引号包住，
    // runArgs 原样传给 echo，绝不会被解释成第二条命令。
    const r = await executeTool(bashTool, { command: 'echo "a && b | c"' }, ctx(vi.fn().mockResolvedValue(true)));
    expect(r.status).toBe("success");
    expect(runArgsSpy).toHaveBeenCalledWith(["echo", "a && b | c"], "/ws");
    expect(runSpy).not.toHaveBeenCalled();
  });

  it("组合命令 echo hi; rm -rf ~ 被拦截（含 ; 运算符 → 不走 sh -c）", async () => {
    const confirm = vi.fn().mockResolvedValue(true);
    const r = await executeTool(bashTool, { command: "echo hi; rm -rf ~" }, ctx(confirm));
    expect(r.status).toBe("denied");
    expect(runArgsSpy).not.toHaveBeenCalled();
    expect(runSpy).not.toHaveBeenCalled();
  });

  it("管道组合命令 pnpm test | grep foo 被拦截（| 是 shell 运算符，bash 工具层拒绝）", async () => {
    // pnpm 与 grep 都在白名单 → executor 的 checkCommand 会放行；
    // 但 bash 工具层按 D2 拒绝任何需要 shell 解释的组合命令。
    const confirm = vi.fn().mockResolvedValue(true);
    const r = await executeTool(bashTool, { command: "pnpm test | grep foo" }, ctx(confirm));
    expect(r.status).toBe("denied");
    expect(runArgsSpy).not.toHaveBeenCalled();
    expect(runSpy).not.toHaveBeenCalled();
  });

  it("含命令替换 $() 的命令被拦截", async () => {
    const confirm = vi.fn().mockResolvedValue(true);
    const r = await executeTool(bashTool, { command: "echo $(whoami)" }, ctx(confirm));
    expect(r.status).toBe("denied");
    expect(runArgsSpy).not.toHaveBeenCalled();
  });

  it("含重定向 > 的命令被拦截", async () => {
    const confirm = vi.fn().mockResolvedValue(true);
    const r = await executeTool(bashTool, { command: "echo hi > out.txt" }, ctx(confirm));
    expect(r.status).toBe("denied");
    expect(runArgsSpy).not.toHaveBeenCalled();
  });
});
