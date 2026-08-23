// Harness 阶段2 — executor 单元测试。
//
// 覆盖：
// - doom-loop 检测：同 (toolName, input) 在窗口内连续 3 次 → 返回 TOOL_DOOM_LOOP，
//   不调工具本体，retryable=false，明确禁止继续原样重试
// - renderForModel：把 ToolResultV2 渲染成结构化字符串（status / summary / error.code /
//   nextActions / artifacts 头部齐全）
// - 落库 result_json + error_code
// - 归一化：老 ToolResult 走 compatFromLegacy → v2 落库
//
// 每个测试用独立 messageId 隔离 doom-loop 状态，避免用例互相污染。

import { describe, expect, it, beforeEach, vi } from "vitest";
import { z } from "zod";

const mocks = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("../../../db", () => ({
  toolExecutions: { create: mocks.create },
}));

import { executeTool, renderForModel } from "../executor";
import type { AnyToolDefinition, ToolContext } from "../types";

function echoTool(over: Partial<AnyToolDefinition> = {}): AnyToolDefinition {
  return {
    name: "echo",
    description: "回显输入",
    parameters: z.object({ text: z.string() }),
    readOnly: true,
    security: { kind: "none" },
    execute: async (input: { text: string }) => ({
      status: "success" as const,
      summary: input.text,
      output: input.text,
      artifacts: [],
      nextActions: [],
    }),
    ...over,
  };
}

/** 用唯一 messageId 隔离 doom-loop 状态。 */
function ctxWithMessage(messageId: string): ToolContext {
  return {
    workspacePath: "/ws",
    projectId: "p1",
    conversationId: "c1",
    messageId,
  };
}

beforeEach(() => {
  mocks.create.mockReset();
  mocks.create.mockResolvedValue("exec-id");
});

describe("executor: doom loop 拦截", () => {
  it("同 tool+input 连续 3 次 → 第 3 次返回 TOOL_DOOM_LOOP，不再调工具", async () => {
    const exec = vi.fn(async (input: { text: string }) => ({
      status: "success" as const,
      summary: input.text,
      output: input.text,
      artifacts: [],
      nextActions: [],
    }));
    const tool = echoTool({ execute: exec });
    const ctx = ctxWithMessage(`msg-${Date.now()}-1`);

    // 前 2 次正常调用
    await executeTool(tool, { text: "x" }, ctx);
    await executeTool(tool, { text: "x" }, ctx);
    expect(exec).toHaveBeenCalledTimes(2);

    // 第 3 次应被 doom loop 拦截，工具不再被调用
    const third = await executeTool(tool, { text: "x" }, ctx);
    expect(exec).toHaveBeenCalledTimes(2); // 没新增调用
    expect(third.status).toBe("error");
    expect(third.error?.code).toBe("TOOL_DOOM_LOOP");
    expect(third.error?.retryable).toBe(false);
    expect(third.error?.stopCondition).toContain("禁止继续");
    expect(third.nextActions.some((a) => a.action === "switch_strategy")).toBe(true);
    expect(third.nextActions.some((a) => a.action === "ask_user")).toBe(true);
  });

  it("不同 input 不会触发 doom loop", async () => {
    const exec = vi.fn(async (input: { text: string }) => ({
      status: "success" as const,
      summary: input.text,
      output: input.text,
      artifacts: [],
      nextActions: [],
    }));
    const tool = echoTool({ execute: exec });
    const ctx = ctxWithMessage(`msg-${Date.now()}-2`);

    await executeTool(tool, { text: "a" }, ctx);
    await executeTool(tool, { text: "b" }, ctx);
    await executeTool(tool, { text: "c" }, ctx);
    await executeTool(tool, { text: "d" }, ctx);
    expect(exec).toHaveBeenCalledTimes(4);
  });

  it("不同 messageId 隔离 doom loop 状态", async () => {
    const exec = vi.fn(async (input: { text: string }) => ({
      status: "success" as const,
      summary: input.text,
      output: input.text,
      artifacts: [],
      nextActions: [],
    }));
    const tool = echoTool({ execute: exec });

    await executeTool(tool, { text: "y" }, ctxWithMessage("msg-iso-A"));
    await executeTool(tool, { text: "y" }, ctxWithMessage("msg-iso-A"));
    await executeTool(tool, { text: "y" }, ctxWithMessage("msg-iso-B")); // 不同 messageId 不算重
    await executeTool(tool, { text: "y" }, ctxWithMessage("msg-iso-B"));
    expect(exec).toHaveBeenCalledTimes(4);
  });

  it("doom-loop 命中也落审计（result_json + error_code=TOOL_DOOM_LOOP）", async () => {
    const exec = vi.fn(async () => ({
      status: "success" as const,
      summary: "x",
      output: "x",
      artifacts: [],
      nextActions: [],
    }));
    const tool = echoTool({ execute: exec });
    const ctx = ctxWithMessage(`msg-${Date.now()}-audit`);

    await executeTool(tool, { text: "z" }, ctx);
    await executeTool(tool, { text: "z" }, ctx);
    await executeTool(tool, { text: "z" }, ctx); // 第 3 次被拦

    // 3 次都落审计
    expect(mocks.create).toHaveBeenCalledTimes(3);
    const thirdCall = mocks.create.mock.calls[2]![0];
    expect(thirdCall.status).toBe("error");
    expect(thirdCall.errorCode).toBe("TOOL_DOOM_LOOP");
    expect(thirdCall.resultJson).toBeTruthy();
    const parsed = JSON.parse(thirdCall.resultJson);
    expect(parsed.error.code).toBe("TOOL_DOOM_LOOP");
    expect(parsed.error.retryable).toBe(false);
  });
});

describe("executor: 落库 result_json + error_code", () => {
  it("audit projects known fields, redacts them, and excludes unknown/debug/parts", async () => {
    const tool = echoTool({
      execute: async () => ({
        status: "success" as const,
        summary: "summary token=summary-secret-123456",
        output: "output sk-proj-output-secret-123456",
        artifacts: [{ kind: "file" as const, uri: "file://?api_key=uri-secret-123456", label: "label Bearer label-secret-1234567890" }],
        nextActions: [{ action: "token=action-secret-123456", reason: "token=reason-secret-123456", safe: true }],
        parts: [{ type: "text", text: "nested base64 secret" }],
        debug: { parts: [{ data: "nested base64 secret" }] },
        unknown: "unknown-secret",
      } as never),
    });
    const runtime = await executeTool(tool, { text: "x" }, ctxWithMessage("msg-audit-projection"));
    expect(runtime.parts).toBeDefined();
    const call = mocks.create.mock.calls[0]![0];
    const parsed = JSON.parse(call.resultJson);
    expect(parsed.output).toBe(call.output);
    expect(JSON.stringify(parsed)).not.toContain("unknown-secret");
    expect(JSON.stringify(parsed)).not.toContain("nested base64 secret");
    expect(JSON.stringify(parsed)).not.toContain("secret-123456");
    expect(parsed.status).toBe("success");
    expect(parsed.artifacts[0].kind).toBe("file");
    expect(parsed.nextActions[0].safe).toBe(true);
  });
  it("成功执行：resultJson 是合法 ToolResultV2，errorCode=null", async () => {
    const tool = echoTool();
    await executeTool(tool, { text: "hi" }, ctxWithMessage("msg-rj-1"));
    const call = mocks.create.mock.calls[0]![0];
    expect(call.resultJson).toBeTruthy();
    const parsed = JSON.parse(call.resultJson);
    expect(parsed.status).toBe("success");
    expect(parsed.summary).toBeTruthy();
    expect(parsed.artifacts).toEqual([]);
    expect(parsed.nextActions).toEqual([]);
    expect(parsed.error).toBeUndefined();
    expect(call.errorCode).toBeNull();
  });

  it("参数错误：errorCode=TOOL_INVALID_PARAMS，retryable=true", async () => {
    const tool = echoTool();
    await executeTool(tool, { text: 123 as unknown as string }, ctxWithMessage("msg-rj-2"));
    const call = mocks.create.mock.calls[0]![0];
    expect(call.status).toBe("error");
    expect(call.errorCode).toBe("TOOL_INVALID_PARAMS");
    const parsed = JSON.parse(call.resultJson);
    expect(parsed.error.code).toBe("TOOL_INVALID_PARAMS");
    expect(parsed.error.retryable).toBe(true);
  });

  it("执行抛错：errorCode=TOOL_UNKNOWN_ERROR，retryable=false", async () => {
    const tool = echoTool({ execute: async () => { throw new Error("boom"); } });
    await executeTool(tool, { text: "x" }, ctxWithMessage("msg-rj-3"));
    const call = mocks.create.mock.calls[0]![0];
    expect(call.errorCode).toBe("TOOL_UNKNOWN_ERROR");
  });
});

describe("renderForModel: 把 ToolResultV2 渲染成结构化字符串", () => {
  it("success：包含 status / summary / artifacts / nextActions 头部", async () => {
    const tool: AnyToolDefinition = {
      name: "write_v",
      description: "test",
      parameters: z.object({ content: z.string() }),
      readOnly: false,
      security: { kind: "none" },
      execute: async () => ({
        status: "success",
        summary: "写入 foo.ts",
        output: "已写入",
        artifacts: [{ kind: "file", uri: "foo.ts", label: "新文件" }],
        nextActions: [{ action: "read_back", reason: "校验", safe: true }],
      }),
    };
    const res = await executeTool(tool, { content: "x" }, ctxWithMessage("msg-render-1"));
    const rendered = renderForModel(res);
    expect(rendered).toContain("[tool_status] success");
    expect(rendered).toContain("[summary] 写入 foo.ts");
    expect(rendered).toContain("[next_actions] read_back");
    expect(rendered).toContain("[artifacts] file:foo.ts");
    expect(rendered).toContain("--- output ---");
    expect(rendered).toContain("已写入");
  });

  it("error retryable=false：包含 error_code / error_cause / error_stop_condition", async () => {
    const tool: AnyToolDefinition = {
      name: "noop_v",
      description: "test",
      parameters: z.object({}),
      readOnly: true,
      security: { kind: "none" },
      execute: async () => ({
        status: "denied",
        summary: "拒绝",
        output: "用户拒绝",
        artifacts: [],
        nextActions: [],
        error: {
          code: "TOOL_DENIED",
          rootCauseHint: "用户点了拒绝",
          retryable: false,
          stopCondition: "等待用户授权",
        },
      }),
    };
    const res = await executeTool(tool, {}, ctxWithMessage("msg-render-2"));
    const rendered = renderForModel(res);
    expect(rendered).toContain("[tool_status] denied");
    expect(rendered).toContain("[error_code] TOOL_DENIED (retryable=false)");
    expect(rendered).toContain("[error_cause] 用户点了拒绝");
    expect(rendered).toContain("[error_stop_condition] 等待用户授权");
  });

  it("error retryable=true：包含 error_retry_hint 而不是 stop_condition", async () => {
    const tool: AnyToolDefinition = {
      name: "noop_v2",
      description: "test",
      parameters: z.object({}),
      readOnly: true,
      security: { kind: "none" },
      execute: async () => ({
        status: "error",
        summary: "old_string 不唯一",
        output: "...",
        artifacts: [],
        nextActions: [],
        error: {
          code: "TOOL_OLD_STRING_AMBIGUOUS",
          rootCauseHint: "出现 3 次",
          retryable: true,
          retryInstruction: "补更多上下文",
        },
      }),
    };
    const res = await executeTool(tool, {}, ctxWithMessage("msg-render-3"));
    const rendered = renderForModel(res);
    expect(rendered).toContain("retryable=true");
    expect(rendered).toContain("[error_retry_hint] 补更多上下文");
  });
});

describe("executor: 老 ToolResult 兼容", () => {
  it("工具返回老 {status,output} → 落库 resultJson 仍是 v2 形态", async () => {
    const legacyTool: AnyToolDefinition = {
      name: "legacy_v",
      description: "test",
      parameters: z.object({}),
      readOnly: true,
      security: { kind: "none" },
      execute: async () => ({ status: "success", output: "老格式 OK" }) as unknown as Awaited<ReturnType<typeof echoTool>>["execute"] extends (...args: any[]) => Promise<infer R> ? R : never,
    };
    await executeTool(legacyTool, {}, ctxWithMessage("msg-legacy"));
    const call = mocks.create.mock.calls[0]![0];
    const parsed = JSON.parse(call.resultJson);
    expect(parsed.status).toBe("success");
    expect(parsed.summary).toBe("老格式 OK");
    expect(parsed.artifacts).toEqual([]);
    expect(parsed.nextActions).toEqual([]);
    expect(parsed.error).toBeUndefined();
  });
});
