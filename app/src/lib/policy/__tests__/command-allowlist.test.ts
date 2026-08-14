import { describe, it, expect, beforeEach } from "vitest";

import {
  BUILTIN_ALLOWED_PROGRAMS,
  commandAllowlistGlobalScope,
  commandAllowlistPolicy,
  commandAllowlistProjectScope,
  invalidateAllowlistResolveCache,
  parseAllowedProgramsOverride,
  resolveAllowedPrograms,
  serializeAllowedProgramsOverride,
} from "@/lib/policy/command-allowlist";
import { PolicyStore } from "@/lib/policy/policy-store";

// ---------- 测试用假 PolicyStore（不依赖真 DB） ----------

function makeFakeStore() {
  const rows = new Map<string, { valueJson: string }>();
  const recorded: Array<{ key: string; scope: any; json: string }> = [];
  let writeError: Error | null = null;

  return {
    rows,
    recorded,
    setWriteError(err: Error | null) {
      writeError = err;
    },
    overrides: {
      async get(policyKey: string, scope: any) {
        const slot = `${policyKey}|${JSON.stringify(scope)}`;
        // 返回的是 row 对象（含 valueJson），跟真实 DAO 一致；
        // PolicyStore.get 内部会抓 row.valueJson。
        return rows.get(slot) ?? null;
      },
      async set(input: any) {
        if (writeError) throw writeError;
        const slot = `${input.policyKey}|${JSON.stringify(input.scope)}`;
        rows.set(slot, { valueJson: input.valueJson });
        recorded.push({ key: input.policyKey, scope: input.scope, json: input.valueJson });
      },
      async clear(policyKey: string, scope: any) {
        const slot = `${policyKey}|${JSON.stringify(scope)}`;
        return rows.delete(slot);
      },
      async clearAllForPolicy(policyKey: string) {
        const matches: any[] = [];
        for (const [k, v] of rows.entries()) {
          if (k.startsWith(`${policyKey}|`)) {
            matches.push({ valueJson: v.valueJson, scope: JSON.parse(k.split("|")[1]!) });
            rows.delete(k);
          }
        }
        return matches;
      },
      async listByPolicy() {
        return [];
      },
      async listKeysWithOverrides() {
        return [];
      },
    },
    history: {
      async record() {},
      async listByPolicy() {
        return [];
      },
    },
  };
}

describe("policy/command-allowlist", () => {
  describe("BUILTIN_ALLOWED_PROGRAMS", () => {
    it("是 frozen Set（防止 builtin 被运行时偷改）", () => {
      expect(Object.isFrozen(BUILTIN_ALLOWED_PROGRAMS)).toBe(true);
    });

    it("内置包含 v3.1 修复里点明的 pip3（F1 修正）", () => {
      expect(BUILTIN_ALLOWED_PROGRAMS.has("pip3")).toBe(true);
    });

    it("内置仍含 python3 + pip（F1 修正：原本就在表内，没漏）", () => {
      expect(BUILTIN_ALLOWED_PROGRAMS.has("python3")).toBe(true);
      expect(BUILTIN_ALLOWED_PROGRAMS.has("pip")).toBe(true);
    });

    it("内置不含提权 / 破坏性 / 远程访问程序（黑名单 + 默认拒绝独立保证）", () => {
      expect(BUILTIN_ALLOWED_PROGRAMS.has("rm")).toBe(false);
      expect(BUILTIN_ALLOWED_PROGRAMS.has("sudo")).toBe(false);
      // 远程访问 / 进程控制 / 系统守护类仍留在白名单外（非开发主循环，需要时走 override）。
      expect(BUILTIN_ALLOWED_PROGRAMS.has("ssh")).toBe(false);
      expect(BUILTIN_ALLOWED_PROGRAMS.has("systemctl")).toBe(false);
    });

    it("环境变量读取包装器不在内置白名单", () => {
      expect(BUILTIN_ALLOWED_PROGRAMS.has("env")).toBe(false);
      expect(BUILTIN_ALLOWED_PROGRAMS.has("printenv")).toBe(false);
    });

    // 2026-07-16 全 parity 档：开发工具链 + shell + 网络抓取进白名单，危险用法仍由黑名单挡。
    it("内置含全 parity 档补的开发工具链 / shell / 网络抓取", () => {
      for (const p of ["make", "docker", "gcc", "java", "cargo", "go", "bash", "sh", "curl", "wget", "pytest"]) {
        expect(BUILTIN_ALLOWED_PROGRAMS.has(p)).toBe(true);
      }
    });
  });

  describe("commandAllowlistPolicy.parse / serialize", () => {
    it("parse 接受 string[]", () => {
      const set = commandAllowlistPolicy.parse('["custom-tool","hl"]');
      expect(set).toEqual(new Set(["custom-tool", "hl"]));
    });

    it("parse 拒绝非数组", () => {
      expect(() => commandAllowlistPolicy.parse('{"a":1}')).toThrow();
      expect(() => commandAllowlistPolicy.parse('"a"')).toThrow();
    });

    it("parse 拒绝空字符串元素", () => {
      expect(() => commandAllowlistPolicy.parse('["a",""]')).toThrow();
    });

    it("serialize 输出合法 JSON 数组", () => {
      const json = serializeAllowedProgramsOverride(["x", "y"]);
      expect(JSON.parse(json)).toEqual(["x", "y"]);
    });

    it("parse(serialize(x)) 往返相等", () => {
      const original = ["a", "b", "c"];
      const round = parseAllowedProgramsOverride(serializeAllowedProgramsOverride(original));
      expect(round).toEqual(original);
    });
  });

  describe("commandAllowlistPolicy.merge（union）", () => {
    it("merge 是 builtin ∪ override（只增不减）", () => {
      const builtin = new Set(["pnpm", "npm"]);
      const override = new Set(["custom", "pnpm"]); // pnpm 已存在也不删
      const merged = commandAllowlistPolicy.merge(builtin, override);
      expect([...merged].sort()).toEqual(["custom", "npm", "pnpm"]);
    });

    it("override 完全为空时 merge = builtin 副本", () => {
      const builtin = new Set(["pnpm", "npm"]);
      const merged = commandAllowlistPolicy.merge(builtin, new Set());
      expect([...merged].sort()).toEqual(["npm", "pnpm"]);
    });

    it("merge 不修改入参（不可变）", () => {
      const builtin = new Set(["pnpm"]);
      const override = new Set(["x"]);
      commandAllowlistPolicy.merge(builtin, override);
      expect([...builtin]).toEqual(["pnpm"]);
      expect([...override]).toEqual(["x"]);
    });
  });

  describe("scopesAllowed / builtinVersion", () => {
    it("允许 project + global（不允许 distribution，用户切不到那档）", () => {
      expect(commandAllowlistPolicy.scopesAllowed).toContain("project");
      expect(commandAllowlistPolicy.scopesAllowed).toContain("global");
      expect(commandAllowlistPolicy.scopesAllowed).not.toContain("distribution");
    });

    it("builtinVersion 是版本戳（§5.4 versioning banner 用）", () => {
      expect(commandAllowlistPolicy.builtinVersion).toMatch(/^builtin-\d{4}-\d{2}-\d{2}$/);
    });

    it("mergeKind = union（白名单类）", () => {
      expect(commandAllowlistPolicy.mergeKind).toBe("union");
    });
  });

  describe("resolveAllowedPrograms", () => {
    let fake: ReturnType<typeof makeFakeStore>;
    let store: PolicyStore;

    beforeEach(() => {
      // review S-F-05 fix（2026-07-13）陪跑：resolveAllowedPrograms 现在有模块级 cache，
      // 测试间必须清掉，否则第一次跑"无 override = builtin"之后，第二次跑"全局 override"
      // 会命中 cache 拿到 builtin-only（cache key 是 projectId；undefined 项目 = "__no_project__"）。
      invalidateAllowlistResolveCache();
      fake = makeFakeStore();
      store = new PolicyStore({
        overrides: fake.overrides as any,
        history: fake.history as any,
      });
    });

    it("无 override 时 = builtin", async () => {
      const got = await resolveAllowedPrograms(undefined, undefined, store);
      // builtin 至少 50 个程序，包含 pip3 等关键项
      expect(got.has("pip3")).toBe(true);
      expect(got.has("pnpm")).toBe(true);
      expect(Object.isFrozen(got)).toBe(true);
    });

    it("全局 override 与 builtin 合并", async () => {
      await store.set(
        commandAllowlistPolicy.key,
        commandAllowlistGlobalScope(),
        '["custom-global-tool"]',
        "tester",
      );
      const got = await resolveAllowedPrograms(undefined, undefined, store);
      expect(got.has("custom-global-tool")).toBe(true);
      expect(got.has("pip3")).toBe(true); // builtin 还在
    });

    it("项目级 override 加到全局 + builtin 之上", async () => {
      await store.set(
        commandAllowlistPolicy.key,
        commandAllowlistGlobalScope(),
        '["custom-global"]',
        "tester",
      );
      await store.set(
        commandAllowlistPolicy.key,
        commandAllowlistProjectScope("proj-A"),
        '["custom-proj-A"]',
        "tester",
      );

      const gotA = await resolveAllowedPrograms("proj-A", undefined, store);
      expect(gotA.has("pip3")).toBe(true); // builtin
      expect(gotA.has("custom-global")).toBe(true); // global
      expect(gotA.has("custom-proj-A")).toBe(true); // project

      // 无项目上下文时：只看到 global + builtin，看不到其他项目
      const gotEmpty = await resolveAllowedPrograms(undefined, undefined, store);
      expect(gotEmpty.has("custom-global")).toBe(true);
      expect(gotEmpty.has("custom-proj-A")).toBe(false);
    });

    it("项目级 override 不会跨项目泄漏", async () => {
      await store.set(
        commandAllowlistPolicy.key,
        commandAllowlistProjectScope("proj-A"),
        '["only-for-A"]',
        "tester",
      );
      const gotB = await resolveAllowedPrograms("proj-B", undefined, store);
      expect(gotB.has("only-for-A")).toBe(false);
    });

    it("override 加入 env/printenv 后，resolve 结果交给 checkCommand 仍必须 block", async () => {
      await store.set(
        commandAllowlistPolicy.key,
        commandAllowlistGlobalScope(),
        '["env","printenv"]',
        "tester",
      );
      await store.set(
        commandAllowlistPolicy.key,
        commandAllowlistProjectScope("proj-hard-deny"),
        '["env","printenv"]',
        "tester",
      );
      const got = await resolveAllowedPrograms("proj-hard-deny", undefined, store);
      const { checkCommand } = await import("@/lib/llm/tools/command-safety");
      expect(got.has("env")).toBe(true);
      expect(got.has("printenv")).toBe(true);
      expect(checkCommand("env", [], got).verdict).toBe("block");
      expect(checkCommand("printenv API_KEY", [], got).verdict).toBe("block");
    });

    it("extraPrograms 覆盖内置（注入点；测试 fallback 用）", async () => {
      const small = new Set(["x", "y"]);
      const got = await resolveAllowedPrograms(undefined, small, store);
      // merge 用 extraPrograms 替代 builtin
      expect(got.has("x")).toBe(true);
      expect(got.has("y")).toBe(true);
      expect(got.has("pnpm")).toBe(false); // builtin 已不参与
    });
  });

  describe("scope helper 一致性", () => {
    it("commandAllowlistGlobalScope() = { level: 'global' }", () => {
      expect(commandAllowlistGlobalScope()).toEqual({ level: "global" });
    });

    it("commandAllowlistProjectScope(id) = { level: 'project', projectId: id }", () => {
      expect(commandAllowlistProjectScope("foo")).toEqual({
        level: "project",
        projectId: "foo",
      });
    });
  });
});
