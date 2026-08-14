import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { maybeBuildDoomLoopResult } from "../executor-doom-loop";
import { summarizePartsForAudit } from "../executor-parts-audit";
import { renderResultForModel } from "../executor-render";
import { normalizeToV2 } from "../executor-result";
import { runSecurityPrecheck } from "../executor-security";
import { safeStringify, shapeOfInput } from "../executor-serialization";
import type { AnyToolDefinition, ToolContext } from "../types";

// 引擎化阶段 1a：runSecurityPrecheck 调 resolveAllowedPrograms → PolicyStore.get。
// 本测试只关心 precheck 自身逻辑（denied / 透传 security）的 contract，
// 不关心 override 行为，所以 mock PolicyStore.get 永远返回 null（无 override 时
// resolveAllowedPrograms 直接回 builtin）。
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

const baseCtx: ToolContext = {
  workspacePath: "/tmp/cosmgrid-test",
  projectId: "p1",
  conversationId: "c1",
};

function toolWithSecurity(security: AnyToolDefinition["security"]): AnyToolDefinition {
  return {
    name: "helper_tool",
    description: "helper",
    parameters: z.object({}),
    readOnly: true,
    security,
    execute: async () => ({
      status: "success",
      summary: "ok",
      output: "ok",
      artifacts: [],
      nextActions: [],
    }),
  };
}

describe("executor helper coverage", () => {
  it("safeStringify handles plain values, bigint, and unserializable circular objects", () => {
    expect(safeStringify({ a: 1 })).toBe('{"a":1}');
    expect(safeStringify({ n: 1n })).toBe('{"n":"1"}');

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(safeStringify(circular)).toBe("[object Object]");
  });

  it("shapeOfInput returns compact json, truncates long json, and handles circular objects", () => {
    expect(shapeOfInput({ a: 1 })).toBe('{"a":1}');
    expect(shapeOfInput({ text: "x".repeat(260) })).toContain("…(truncated)");

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(shapeOfInput(circular)).toBe("(unserializable)");
  });

  it("summarizePartsForAudit supports raw base64 image strings without data-url prefix", () => {
    const out = summarizePartsForAudit([
      { type: "image", image: "A".repeat(1368), mediaType: "image/webp" },
    ]);
    expect(out).toContain("[image webp");
    expect(out).toContain("1.0KB]");
  });

  it("normalizeToV2 accepts valid v2 results and falls back for legacy results", () => {
    const warning = {
      status: "warning" as const,
      summary: "warn",
      output: "warn",
      artifacts: [],
      nextActions: [],
    };
    expect(normalizeToV2(warning)).toBe(warning);

    const legacy = normalizeToV2({ status: "success", output: "legacy ok" });
    expect(legacy.summary).toBe("legacy ok");
    expect(legacy.artifacts).toEqual([]);
  });

  it("renderResultForModel covers unsafe actions and artifacts without labels", () => {
    const rendered = renderResultForModel(
      {
        status: "success",
        summary: "ok",
        output: "done",
        artifacts: [{ kind: "file", uri: "src/a.ts", label: "" }],
        nextActions: [{ action: "write_file", reason: "needs edit", safe: false }],
      },
      100,
    );
    expect(rendered).toContain("write_file (需用户确认): needs edit");
    expect(rendered).toContain("[artifacts] file:src/a.ts");
  });

  it("runSecurityPrecheck returns undefined security for missing optional fields", async () => {
    await expect(
      runSecurityPrecheck(toolWithSecurity({ kind: "read-path", pathField: "file_path" }), {}, baseCtx),
    ).resolves.toEqual({ security: undefined });
    await expect(
      runSecurityPrecheck(toolWithSecurity({ kind: "write-path", pathField: "file_path" }), { file_path: " " }, baseCtx),
    ).resolves.toEqual({ security: undefined });
    await expect(
      runSecurityPrecheck(toolWithSecurity({ kind: "command", commandField: "command" }), {}, baseCtx),
    ).resolves.toEqual({ security: undefined });
    await expect(runSecurityPrecheck(toolWithSecurity({ kind: "none" }), {}, baseCtx)).resolves.toEqual({
      security: undefined,
    });
  });

  it("runSecurityPrecheck returns command verdicts and denied command blocks", async () => {
    await expect(
      runSecurityPrecheck(
        toolWithSecurity({ kind: "command", commandField: "command" }),
        { command: "pnpm test" },
        baseCtx,
      ),
    ).resolves.toMatchObject({ security: { kind: "command" } });

    const denied = await runSecurityPrecheck(
      toolWithSecurity({ kind: "command", commandField: "command" }),
      { command: "rm -rf /" },
      baseCtx,
    );
    expect("denied" in denied).toBe(true);
  });

  it("K7 能力门控：只读阶段允许集 active 时，写工具被拦、读工具放行", async () => {
    // read_project/plan 阶段策略：只授予读 + 命令，不授予写。
    const auditCaps = ["read_files", "inspect_git", "run_readonly_checks"];
    const ctx: ToolContext = { ...baseCtx, activeCaps: auditCaps };

    // 写工具 → 拦截
    const deniedWrite = await runSecurityPrecheck(
      toolWithSecurity({ kind: "write-path", pathField: "file_path" }),
      { file_path: "a.ts" },
      ctx,
    );
    expect("denied" in deniedWrite).toBe(true);
    if ("denied" in deniedWrite) {
      expect(deniedWrite.reasonCode).toBe("SKILL_CAPABILITY_DENIED");
    }

    // 读工具 → 放行（read-path 恒放行，即便 skill 只声明了这些 cap）
    const readOk = await runSecurityPrecheck(
      toolWithSecurity({ kind: "read-path", pathField: "file_path" }),
      { file_path: "a.ts" },
      ctx,
    );
    expect("denied" in readOk).toBe(false);
  });

  it("K7 能力门控：不设 activeCaps 时完全不门控（无阶段策略保持全放行）", async () => {
    const deniedWrite = await runSecurityPrecheck(
      toolWithSecurity({ kind: "write-path", pathField: "file_path" }),
      { file_path: "a.ts" },
      baseCtx, // 无 activeCaps
    );
    // 不因 K7 被拦（write-path 的 path-safety 对 /tmp 工作区内的相对路径放行）
    expect("denied" in deniedWrite).toBe(false);
  });

  it("maybeBuildDoomLoopResult returns null before threshold and error after repeated calls", () => {
    const ctx = { ...baseCtx, messageId: "helper-doom-loop" };
    expect(maybeBuildDoomLoopResult(ctx, "read", { file_path: "a.ts" }, '{"file_path":"a.ts"}')).toBeNull();
    expect(maybeBuildDoomLoopResult(ctx, "read", { file_path: "a.ts" }, '{"file_path":"a.ts"}')).toBeNull();

    const third = maybeBuildDoomLoopResult(ctx, "read", { file_path: "a.ts" }, '{"file_path":"a.ts"}');
    expect(third?.error?.code).toBe("TOOL_DOOM_LOOP");
    expect(third?.nextActions.map((a) => a.action)).toContain("ask_user");
  });
});
