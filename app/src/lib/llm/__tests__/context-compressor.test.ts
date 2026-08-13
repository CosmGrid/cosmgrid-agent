// context-compressor 单测（v0.9 阶段7：长上下文裁剪；v0.9.1 摘要式压缩）
import { describe, it, expect, vi } from "vitest";
import {
  estimateTokens,
  estimateMessagesTokens,
  compressHistory,
  compressHistoryWithSummary,
  type ChatMsg,
} from "../context-compressor";

function msg(role: ChatMsg["role"], content: string): ChatMsg {
  return { role, content };
}

describe("estimateTokens", () => {
  it("约 chars/3", () => {
    expect(estimateTokens("abcdef")).toBe(2);
    expect(estimateTokens("")).toBe(0);
  });
});

describe("compressHistory", () => {
  it("在预算内不压缩", () => {
    const ms = [msg("user", "hi"), msg("assistant", "hello")];
    const r = compressHistory(ms, { maxTokens: 1000 });
    expect(r.compressed).toBe(false);
    expect(r.droppedCount).toBe(0);
    expect(r.messages).toHaveLength(2);
  });

  it("超预算时裁掉较早消息并插省略提示", () => {
    const ms: ChatMsg[] = [];
    for (let i = 0; i < 20; i++) ms.push(msg("user", "x".repeat(300)));
    const r = compressHistory(ms, { maxTokens: 500, minRecent: 2 });
    expect(r.compressed).toBe(true);
    expect(r.droppedCount).toBeGreaterThan(0);
    // 第一条应是省略提示（system）
    expect(r.messages[0]!.role).toBe("system");
    // 保留的非提示消息数 + 裁掉数 = 原始数
    const keptNonNotice = r.messages.filter((m) => m.role !== "system").length;
    expect(keptNonNotice + r.droppedCount).toBe(20);
  });

  it("system 消息始终保留", () => {
    const ms: ChatMsg[] = [msg("system", "你是助手")];
    for (let i = 0; i < 20; i++) ms.push(msg("user", "y".repeat(300)));
    const r = compressHistory(ms, { maxTokens: 500, minRecent: 2 });
    const systems = r.messages.filter((m) => m.role === "system");
    // 原 system + 省略提示
    expect(systems.some((m) => m.content === "你是助手")).toBe(true);
  });

  it("至少保留 minRecent 条最近消息", () => {
    const ms: ChatMsg[] = [];
    for (let i = 0; i < 20; i++) ms.push(msg("user", "z".repeat(3000)));
    const r = compressHistory(ms, { maxTokens: 100, minRecent: 3 });
    const kept = r.messages.filter((m) => m.role !== "system");
    expect(kept.length).toBeGreaterThanOrEqual(3);
  });

  it("system 单独撑爆预算时，未超过 minRecent 的最近消息不重复计入 dropped", () => {
    const recent = [msg("user", "问题"), msg("assistant", "回答")];
    const ms = [msg("system", "s".repeat(3_000)), ...recent];

    const r = compressHistory(ms, { maxTokens: 100, minRecent: 4 });

    expect(r.compressed).toBe(false);
    expect(r.droppedCount).toBe(0);
    expect(r.messages).toEqual(ms);
  });

  it("不修改入参", () => {
    const ms = [msg("user", "a"), msg("assistant", "b")];
    const copy = JSON.parse(JSON.stringify(ms));
    compressHistory(ms, { maxTokens: 1 });
    expect(ms).toEqual(copy);
  });

  it("保留的是最新的消息（顺序不乱）", () => {
    const ms: ChatMsg[] = [];
    for (let i = 0; i < 10; i++) ms.push(msg("user", `m${i}-${"x".repeat(300)}`));
    const r = compressHistory(ms, { maxTokens: 400, minRecent: 2 });
    const last = r.messages[r.messages.length - 1]!;
    expect(typeof last.content === "string" && last.content.startsWith("m9")).toBe(true);
  });

  it("自定义省略提示文案", () => {
    const ms: ChatMsg[] = [];
    for (let i = 0; i < 20; i++) ms.push(msg("user", "x".repeat(300)));
    const r = compressHistory(ms, { maxTokens: 500, minRecent: 2, noticeText: (n) => `省略了${n}条` });
    expect(String(r.messages[0]!.content)).toMatch(/省略了\d+条/);
  });
});

describe("estimateMessagesTokens", () => {
  it("含每条 4 token 开销", () => {
    expect(estimateMessagesTokens([msg("user", "abc")])).toBe(estimateTokens("abc") + 4);
  });

  it("按 AI SDK 的 input/output 真实形状估算结构化工具历史", () => {
    const withParts: ChatMsg = {
      role: "assistant",
      content: "短摘要",
      parts: [
        {
          role: "assistant",
          content: [{
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "read_file",
            input: { path: `/tmp/${"a".repeat(3_000)}` },
          }],
        },
        {
          role: "tool",
          content: [{
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "read_file",
            output: { type: "text", value: "b".repeat(6_000) },
          }],
        },
      ],
    };

    expect(() => estimateMessagesTokens([withParts])).not.toThrow();
    expect(estimateMessagesTokens([withParts])).toBeGreaterThan(2_500);
  });

  it("遇到 undefined、BigInt 或循环工具值时估算不抛错", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const withUnusualParts: ChatMsg = {
      role: "assistant",
      content: "fallback",
      parts: [{
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "u", toolName: "u", output: undefined },
          { type: "tool-result", toolCallId: "b", toolName: "b", output: 1n },
          { type: "tool-result", toolCallId: "c", toolName: "c", output: circular },
        ],
      }] as ChatMsg["parts"],
    };

    expect(() => estimateMessagesTokens([withUnusualParts])).not.toThrow();
    expect(estimateMessagesTokens([withUnusualParts])).toBeGreaterThan(0);
  });
});

describe("compressHistoryWithSummary (v0.9.1)", () => {
  it("在预算内不压缩、不调 summarize", async () => {
    const summarize = vi.fn(async () => "摘要");
    const ms = [msg("user", "hi"), msg("assistant", "hello")];
    const r = await compressHistoryWithSummary(ms, { maxTokens: 1000, summarize });
    expect(r.compressed).toBe(false);
    expect(r.droppedCount).toBe(0);
    expect(summarize).not.toHaveBeenCalled();
  });

  it("超预算时调 summarize 并把摘要作为 system 插到 systemMsgs 之后", async () => {
    const summarize = vi.fn(async (dropped: ChatMsg[]) =>
      `摘要: ${dropped.length} 条早期对话`,
    );
    const ms: ChatMsg[] = [];
    for (let i = 0; i < 20; i++) ms.push(msg("user", "x".repeat(300)));

    const r = await compressHistoryWithSummary(ms, {
      maxTokens: 500,
      minRecent: 2,
      summarize,
    });

    expect(r.compressed).toBe(true);
    expect(r.droppedCount).toBeGreaterThan(0);
    expect(summarize).toHaveBeenCalledTimes(1);

    // dropped 参数应是非 system 的、要丢的那些消息
    const droppedArg = summarize.mock.calls[0]![0] as ChatMsg[];
    expect(droppedArg.length).toBe(r.droppedCount);
    expect(droppedArg.every((m) => m.role !== "system")).toBe(true);

    // 输出里应该包含摘要文本（而不是省略提示）
    const summaryNotice = r.messages.find(
      (m) => m.role === "system" && String(m.content).includes("摘要"),
    );
    expect(summaryNotice).toBeDefined();
    expect(String(summaryNotice!.content)).toContain("Earlier conversation summary");
  });

  it("summarize 返回 null（生成失败）时退回 notice 抽取式", async () => {
    const summarize = vi.fn(async () => null);
    const ms: ChatMsg[] = [];
    for (let i = 0; i < 20; i++) ms.push(msg("user", "x".repeat(300)));

    const r = await compressHistoryWithSummary(ms, {
      maxTokens: 500,
      minRecent: 2,
      summarize,
      noticeText: (n) => `[omitted ${n}]`,
    });

    expect(r.compressed).toBe(true);
    // 退回 notice 文本（不是 "Earlier conversation summary"）
    const firstSystem = r.messages.find((m) => m.role === "system");
    expect(String(firstSystem!.content)).toMatch(/omitted \d+/);
    expect(String(firstSystem!.content)).not.toContain("Earlier conversation summary");
  });

  it("summarize 抛错时 catch 返回 null，等价于 null 路径（退回抽取式）", async () => {
    const summarize = vi.fn(async () => {
      throw new Error("network down");
    });
    const ms: ChatMsg[] = [];
    for (let i = 0; i < 20; i++) ms.push(msg("user", "x".repeat(300)));

    // 不应向上抛错——压缩器内部包成 try/catch 由调用方负责
    const r = await compressHistoryWithSummary(ms, {
      maxTokens: 500,
      minRecent: 2,
      summarize,
      noticeText: (n) => `[fallback ${n}]`,
    });

    expect(r.compressed).toBe(true);
    const firstSystem = r.messages.find((m) => m.role === "system");
    expect(String(firstSystem!.content)).toMatch(/fallback \d+/);
  });

  it("未注入 summarize 时等同于抽取式（保持向后兼容）", async () => {
    const ms: ChatMsg[] = [];
    for (let i = 0; i < 20; i++) ms.push(msg("user", "x".repeat(300)));

    const r = await compressHistoryWithSummary(ms, {
      maxTokens: 500,
      minRecent: 2,
      noticeText: (n) => `[no-summarizer ${n}]`,
    });

    expect(r.compressed).toBe(true);
    const firstSystem = r.messages.find((m) => m.role === "system");
    expect(String(firstSystem!.content)).toMatch(/no-summarizer \d+/);
  });

  it("不修改入参（不可变）", async () => {
    const summarize = vi.fn(async () => "x");
    const ms = [msg("user", "a"), msg("assistant", "b")];
    const copy = JSON.parse(JSON.stringify(ms));
    await compressHistoryWithSummary(ms, { maxTokens: 1, summarize });
    expect(ms).toEqual(copy);
  });

  it("与 compressHistory 共享 splitByBudget：相同输入下 droppedCount 一致", async () => {
    const summarize = vi.fn(async () => "x");
    const ms: ChatMsg[] = [];
    for (let i = 0; i < 20; i++) ms.push(msg("user", "x".repeat(300)));

    const baseline = compressHistory(ms, { maxTokens: 500, minRecent: 2 });
    const withSummary = await compressHistoryWithSummary(ms, {
      maxTokens: 500,
      minRecent: 2,
      summarize,
    });

    expect(withSummary.droppedCount).toBe(baseline.droppedCount);
  });
});
