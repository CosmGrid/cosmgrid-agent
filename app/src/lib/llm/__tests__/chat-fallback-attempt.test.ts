// chat-fallback-attempt 单元测试：只覆盖工具步数熔断重构新增的 priorToolCalls 拼接行为
// （doom-loop 跨续接批次判定，见 chat-fallback-attempt.ts 里 runModelAttempt 的注释）。
import { describe, it, expect, vi } from "vitest";

const mocks = vi.hoisted(() => ({ streamText: vi.fn() }));

vi.mock("ai", () => ({ streamText: mocks.streamText, stepCountIs: (n: number) => n }));
vi.mock("../provider-factory", () => ({
  getLanguageModel: vi.fn(() => ({ __mock: true })),
}));
vi.mock("../db", () => ({ cliSessions: { upsert: vi.fn() } }));

import { runModelAttempt, splitSystemFromMessages } from "../chat-fallback-attempt";
import type { ModelEndpoint } from "../chat-fallback-types";

const target: ModelEndpoint = {
  modelId: "m1",
  modelName: "model-1",
  providerType: "anthropic",
  providerId: "p1",
  apiCredentialId: "c1",
  apiKey: "k",
  baseUrl: "https://x",
};

/** 模拟 streamText 在一步内触发一次 onStepFinish（同名同参工具调用），然后立即 tool-calls 收尾。 */
function makeOneStepStream(toolCall: { toolName: string; input: unknown }) {
  return (args: { onStepFinish?: (e: { toolCalls: unknown[] }) => void }) => {
    args.onStepFinish?.({ toolCalls: [toolCall] });
    return {
      fullStream: (async function* () {})(),
      usage: Promise.resolve({ inputTokens: 1, outputTokens: 1 }),
      finishReason: Promise.resolve("tool-calls"),
    };
  };
}

describe("runModelAttempt - doom-loop 跨续接批次判定（priorToolCalls）", () => {
  it("本批只有 1 次调用，但拼上 priorToolCalls 后累计满 3 次相同调用 → 应该 abort", async () => {
    const call = { toolName: "edit", input: { path: "/a.ts" } };
    mocks.streamText.mockImplementationOnce(makeOneStepStream(call));

    const result = await runModelAttempt(
      target,
      [{ role: "user", content: "改完这个文件" }],
      { onDelta: () => {} },
      { tools: {} as never, maxToolSteps: 20 },
      [call, call], // 前两批已经是同一个调用；本批第 3 次命中应该跨批触发 doom-loop
    );

    expect(result.wasAborted).toBe(true);
  });

  it("不传 priorToolCalls（默认空数组）时只看本批内的调用，行为跟改造前一致", async () => {
    const call = { toolName: "edit", input: { path: "/a.ts" } };
    mocks.streamText.mockImplementationOnce(makeOneStepStream(call));

    const result = await runModelAttempt(
      target,
      [{ role: "user", content: "改完这个文件" }],
      { onDelta: () => {} },
      { tools: {} as never, maxToolSteps: 20 },
    );

    expect(result.wasAborted).toBe(false);
  });
});

// 2026-07-15 review 修复回归测试：options.signal 在调用 runModelAttempt 之前就已经
// aborted（对应 chat-fallback.ts 续接场景：两次 attempt 之间用户点了停止）。旧实现只用
// addEventListener("abort", onParentAbort)，已经发生过的 abort 事件不会补发到新注册的
// 监听器上，会导致这次调用完全无视停止请求、把 streamText 真的跑完。
describe("runModelAttempt - signal 提前 aborted 的续接场景（2026-07-15 review 修复）", () => {
  it("signal 在调用前就已 aborted → localAbort 被同步触发，streamText 拿到的是已 aborted 的 abortSignal", async () => {
    let capturedAbortSignal: AbortSignal | undefined;
    mocks.streamText.mockImplementationOnce((args: { abortSignal?: AbortSignal }) => {
      capturedAbortSignal = args.abortSignal;
      return {
        fullStream: (async function* () {})(),
        usage: Promise.resolve({ inputTokens: 0, outputTokens: 0 }),
        finishReason: Promise.resolve("stop"),
      };
    });

    const ac = new AbortController();
    ac.abort(); // 调用 runModelAttempt 之前就已经 aborted

    const result = await runModelAttempt(
      target,
      [{ role: "user", content: "继续" }],
      { onDelta: () => {} },
      { signal: ac.signal },
    );

    expect(capturedAbortSignal?.aborted).toBe(true);
    expect(result.wasAborted).toBe(true);
  });
});

describe("runModelAttempt - stepCount 真实步数统计（假收尾判定用，见 chat-fallback.ts）", () => {
  it("每次 onStepFinish 触发都计入 stepCount，不管这一步有没有工具调用", async () => {
    mocks.streamText.mockImplementationOnce(
      (args: { onStepFinish?: (e: { toolCalls: unknown[] }) => void }) => {
        args.onStepFinish?.({ toolCalls: [{ toolName: "read", input: { path: "/a.ts" } }] });
        args.onStepFinish?.({ toolCalls: [] }); // 纯文字步，没有工具调用，也要计入
        args.onStepFinish?.({ toolCalls: [{ toolName: "grep", input: { pattern: "x" } }] });
        return {
          fullStream: (async function* () {})(),
          usage: Promise.resolve({ inputTokens: 1, outputTokens: 1 }),
          finishReason: Promise.resolve("stop"),
        };
      },
    );

    const result = await runModelAttempt(
      target,
      [{ role: "user", content: "帮我核对文档" }],
      { onDelta: () => {} },
      { tools: {} as never, maxToolSteps: 20 },
    );

    expect(result.stepCount).toBe(3);
  });

  it("没有工具（未开 tools）时不装 onStepFinish，stepCount 恒为 0", async () => {
    mocks.streamText.mockReturnValueOnce({
      fullStream: (async function* () {})(),
      usage: Promise.resolve({ inputTokens: 1, outputTokens: 1 }),
      finishReason: Promise.resolve("stop"),
    });

    const result = await runModelAttempt(
      target,
      [{ role: "user", content: "你好" }],
      { onDelta: () => {} },
      {},
    );

    expect(result.stepCount).toBe(0);
  });
});

// 2026-07-16 工程化根因修复回归测试：多条 system 消息必须合并成 AI SDK 的 system 参数，
// 不能作为并排的 {role:"system"} 塞进 messages 数组——否则 MiniMax-M3 等模型的 chat
// template 渲染 system×N 序列时会退化吐 <|user_mask|> 特殊 token（dump 真实请求体确认）。
describe("splitSystemFromMessages（system 消息打包契约）", () => {
  it("多条 system 合并成一条 system 字符串（\\n\\n 连接），rest 只留对话消息、顺序不变", () => {
    const { system, rest } = splitSystemFromMessages([
      { role: "system", content: "规则A" },
      { role: "system", content: "规则B" },
      { role: "user", content: "你好" },
      { role: "assistant", content: "在" },
      { role: "system", content: "压缩摘要（也是 system）" },
      { role: "user", content: "打开163" },
    ]);
    expect(system).toBe("规则A\n\n规则B\n\n压缩摘要（也是 system）");
    expect(rest.map((m) => (m as { role: string }).role)).toEqual(["user", "assistant", "user"]);
  });

  it("没有 system 消息时 system 为 undefined（streamText 就不带 system 参数）", () => {
    const { system, rest } = splitSystemFromMessages([{ role: "user", content: "hi" }]);
    expect(system).toBeUndefined();
    expect(rest).toHaveLength(1);
  });

  it("数组型 content 的 system（多模态 part）折叠成纯文本", () => {
    const { system } = splitSystemFromMessages([
      { role: "system", content: [{ type: "text", text: "图片守卫规则" }] as never },
    ]);
    expect(system).toBe("图片守卫规则");
  });

  it("结构化工具历史：assistant 带 parts → 展开成真实 ModelMessage 序列回放（不是 content 散文压平）", () => {
    const parts = [
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "read", input: { file_path: "a.md" } }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "read", output: { type: "text", value: "苹果" } }] },
      { role: "assistant", content: [{ type: "text", text: "读完了" }] },
    ];
    const { rest } = splitSystemFromMessages([
      { role: "user", content: "读 a.md" },
      { role: "assistant", content: "读完了", parts: parts as never },
      { role: "user", content: "再读 b.md" },
    ]);
    // 一条带 parts 的 assistant 轮展开成 3 条结构化消息，散文 content "读完了" 不作为单条回放
    expect(rest.map((m) => (m as { role: string }).role)).toEqual([
      "user", "assistant", "tool", "assistant", "user",
    ]);
    // 展开的是结构化 tool-call，不是散文
    const toolCallMsg = rest[1] as { content: Array<{ type: string }> };
    expect(toolCallMsg.content[0]?.type).toBe("tool-call");
  });

  it("结构化工具历史：assistant 无 parts → 退化回 {role, content} 文本（老消息兼容）", () => {
    const { rest } = splitSystemFromMessages([
      { role: "assistant", content: "纯文本回答" },
    ]);
    expect(rest).toEqual([{ role: "assistant", content: "纯文本回答" }]);
  });

  it("结构化工具历史：mixed/unknown shape 直达 provider 边界也整轮省略", () => {
    for (const parts of [
      [{ role: "assistant", content: [{ type: "tool-call", toolCallId: "w", toolName: "web_fetch", input: { url: "https://x" } }] }],
      [{ role: "assistant", content: [{ type: "unknown" }] }],
    ]) {
      const { rest } = splitSystemFromMessages([{ role: "assistant", content: "must-not-fallback", parts: parts as never }]);
      expect(rest).toEqual([]);
    }
  });

  it("递归 marker 在 read input/tool output 中也整轮省略，非法 marker 优先 malformed", () => {
    for (const parts of [
      [{ role: "assistant", content: [{ type: "tool-call", toolCallId: "r", toolName: "read", input: { nested: [{ kind: "web_fetch_history", version: 1, status: "withheld" }] } }] }],
      [{ role: "tool", content: [{ type: "tool-result", toolCallId: "r", toolName: "read", output: { nested: { kind: "web_fetch_history", version: 1, status: "withheld" } } }] }],
      [{ role: "assistant", content: [{ type: "tool-call", toolCallId: "w", toolName: "web_fetch", input: { nested: { kind: "web_fetch_history", version: 9, status: "withheld" } } }] }],
    ]) {
      expect(splitSystemFromMessages([{ role: "assistant", content: "must-not-fallback", parts: parts as never }]).rest).toEqual([]);
    }
  });
});

// 接线断言：runModelAttempt 的 API 路径必须把 system 走 streamText 的 system 参数，
// messages 里不再含任何 system 消息。
describe("runModelAttempt - API 路径把 system 走独立参数（不塞 messages）", () => {
  it("streamText 收到的 system 是合并字符串，messages 里没有 system", async () => {
    let captured: { system?: string; messages?: Array<{ role: string }> } | undefined;
    mocks.streamText.mockImplementationOnce((args: { system?: string; messages?: Array<{ role: string }> }) => {
      captured = args;
      return {
        fullStream: (async function* () {})(),
        usage: Promise.resolve({ inputTokens: 1, outputTokens: 1 }),
        finishReason: Promise.resolve("stop"),
      };
    });

    await runModelAttempt(
      target,
      [
        { role: "system", content: "系统规则1" },
        { role: "system", content: "系统规则2" },
        { role: "user", content: "打开163看新闻" },
      ],
      { onDelta: () => {} },
      {},
    );

    expect(captured?.system).toBe("系统规则1\n\n系统规则2");
    expect(captured?.messages?.some((m) => m.role === "system")).toBe(false);
    expect(captured?.messages?.map((m) => m.role)).toEqual(["user"]);
  });
});
