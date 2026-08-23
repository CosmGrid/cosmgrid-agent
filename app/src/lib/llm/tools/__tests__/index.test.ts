// tools/index 单测（v0.7 阶段4：默认注册表 + AI SDK 转换）
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../../../db", () => ({
  toolExecutions: { create: vi.fn().mockResolvedValue("id") },
}));

import { createDefaultToolRegistry, buildAiSdkTools } from "../index";
import { setFsAdapter, type FsAdapter } from "../fs-adapter";
import { __setLimitMapForTest } from "../../model-limits";
import type { ToolContext } from "../types";

const ctx: ToolContext = { workspacePath: "/ws" };

beforeEach(() => {
  const fs: FsAdapter = {
    readTextFile: async () => "hello\nworld",
    readBytes: async () => new Uint8Array(0),
    readDir: async () => [],
    exists: async () => true,
    writeTextFile: async () => {},
    mkdirp: async () => {},
  };
  setFsAdapter(fs);
});

describe("createDefaultToolRegistry", () => {
  it("注册默认只读工具，包含 LSP 查询能力", () => {
    const r = createDefaultToolRegistry();
    expect(r.has("read")).toBe(true);
    expect(r.has("glob")).toBe(true);
    expect(r.has("grep")).toBe(true);
    expect(r.has("git_read")).toBe(true);
    expect(r.has("web_fetch")).toBe(false);
    expect(r.has("web_search")).toBe(true);
    expect(r.has("todo_write")).toBe(true);
    expect(r.has("ask_user_question")).toBe(true);
    expect(r.has("lsp_diagnostics")).toBe(true);
    expect(r.has("lsp_definition")).toBe(true);
    expect(r.has("lsp_hover")).toBe(true);
    // 2026-07-09 加 view_image 工具后总数从 11 → 12（仅只读集合；写工具仍按 includeWrite 控）
    expect(r.has("view_image")).toBe(true);
    // 2026-07-14 加 skill 工具（真 Skill 渐进披露的调用入口），总数 12 → 13
    expect(r.has("skill")).toBe(true);
    expect(r.listReadOnly()).toHaveLength(13);
  });
});

describe("createDefaultToolRegistry — OMO-7 capability guardrail", () => {
  afterEach(() => __setLimitMapForTest(null));

  it("modelName 明确不支持工具调用（tool_call===false）→ 整个注册表为空", () => {
    __setLimitMapForTest(null, null, new Map([["no-tool-model", false]]));
    const r = createDefaultToolRegistry({ modelName: "no-tool-model" });
    expect(r.listReadOnly()).toHaveLength(0);
    expect(r.has("read")).toBe(false);
  });

  it("modelName 未被 models.dev 收录（不确定）→ 按支持处理，正常全量注册", () => {
    __setLimitMapForTest(null, null, new Map());
    const r = createDefaultToolRegistry({ modelName: "unknown-model" });
    expect(r.has("read")).toBe(true);
    expect(r.has("web_fetch")).toBe(false);
    expect(r.listReadOnly()).toHaveLength(13);
  });

  it("modelName 明确不支持视觉（vision===false）→ 只不注册 view_image，其余工具正常", () => {
    __setLimitMapForTest(null, null, new Map(), new Map([["no-vision-model", false]]));
    const r = createDefaultToolRegistry({ modelName: "no-vision-model" });
    expect(r.has("view_image")).toBe(false);
    expect(r.has("read")).toBe(true);
    expect(r.has("web_fetch")).toBe(false);
    expect(r.listReadOnly()).toHaveLength(12);
  });

  it("没传 modelName → 不受能力表影响，照常全量注册", () => {
    __setLimitMapForTest(null, null, new Map([["some-model", false]]), new Map([["some-model", false]]));
    const r = createDefaultToolRegistry();
    expect(r.has("view_image")).toBe(true);
    expect(r.has("web_fetch")).toBe(false);
    expect(r.listReadOnly()).toHaveLength(13);
  });
});

describe("buildAiSdkTools", () => {
  it("每个工具转成带 description 的 AI SDK tool", () => {
    const tools = buildAiSdkTools(createDefaultToolRegistry(), ctx);
    // remember（3.1 修复）始终注册，不分只读/写——它自己走 confirm 审批，不受权限档位过滤。
    // 2026-07-09 加 view_image，工具集合从 10 → 11；2026-07-14 加 skill，11 → 12；
    // 2026-07-15 加 report_no_changes_needed（execute 阶段合法零工具调用逃生舱），12 → 13
    expect(Object.keys(tools).sort()).toEqual([
      "ask_user_question",
      "git_read",
      "glob",
      "grep",
      "lsp_definition",
      "lsp_diagnostics",
      "lsp_hover",
      "read",
      "remember",
      "report_no_changes_needed",
      "skill",
      "todo_write",
      "view_image",
      "web_search",
    ]);
    expect(tools.read!.description).toContain("读取");
    expect(tools.git_read!.description).toContain("git");
  });

  it("tool.execute 走 executeTool 返回字符串输出", async () => {
    const tools = buildAiSdkTools(createDefaultToolRegistry(), ctx);
    const out = await (tools.read!.execute as any)({ file_path: "a.ts" }, {});
    expect(typeof out).toBe("string");
    expect(out).toContain("hello");
  });

  it("includeWrite 和模型变体均不注册 web_fetch", () => {
    const tools = buildAiSdkTools(createDefaultToolRegistry({ includeWrite: true, modelName: "unknown-model" }), ctx);
    expect(tools.web_fetch).toBeUndefined();
  });
});
