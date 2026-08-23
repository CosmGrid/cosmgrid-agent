import { describe, it, expect } from "vitest";
import type { DbMessage } from "@/lib/db";
import { dbMessagesToChat } from "@/pages/chat/history";
import { buildChatPromptMessages } from "@/pages/chat/prompt-messages";
import { splitSystemFromMessages } from "@/lib/llm/chat-fallback-attempt";

// 端到端回归：结构化工具历史真根因修复的「存储→重建→展开」全链路。
// 证明一条存了 parts 的 assistant 轮，最终回放给模型的是结构化 tool-call/tool-result 序列
// （= 对照实验探针 C 的形态，MiniMax 已实弹验证返回原生 tool_calls），而不是散文压平
// （= 探针 E 的形态，MiniMax 会照散文编造）。任一环退化都会被这个测试抓到。

function makeDbMessage(over: Partial<DbMessage>): DbMessage {
  return {
    id: "m1",
    conversationId: "c1",
    role: "assistant",
    content: "",
    modelId: null,
    inputTokens: 0,
    outputTokens: 0,
    cost: 0,
    createdAt: "2026-07-17T00:00:00.000Z",
    ...over,
  };
}

describe("结构化工具历史 端到端回放（存储→重建→展开）", () => {
  it("存了 parts 的 assistant 轮 → 最终回放成结构化 tool-call/tool-result（不是散文）", () => {
    const structured = [
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "c1", toolName: "read", input: { file_path: "执行记录.md" } }],
      },
      {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "c1", toolName: "read", output: { type: "text", value: "第1行\n第2行" } }],
      },
      { role: "assistant", content: [{ type: "text", text: "我读完了执行记录" }] },
    ];

    const hist: DbMessage[] = [
      makeDbMessage({ id: "u1", role: "user", content: "读一下执行记录.md" }),
      makeDbMessage({
        id: "a1",
        role: "assistant",
        content: "我读完了执行记录", // UI/兜底用的散文
        parts: JSON.stringify(structured), // 真相源
        toolCallCount: 1,
      }),
      makeDbMessage({ id: "u2", role: "user", content: "第2行是什么？" }),
    ];

    // 1) DB → ChatMessage（parts 带过来）
    const chatMessages = dbMessagesToChat(hist, []);
    const assistant = chatMessages.find((m) => m.id === "a1");
    expect(assistant?.parts).toBe(JSON.stringify(structured));

    // 2) ChatMessage → 发送用的 ChatMsg（parts 解析并挂上）
    const promptMsgs = buildChatPromptMessages({
      messages: chatMessages,
      effectiveWorkspace: "/repo",
      primaryIsCli: false,
      projectMemoryPreamble: null,
      crossProjectPreamble: null,
      workspacePreamble: null,
      tooLargeNotice: (name) => `${name} 太大`,
    });

    // 3) 发送边界展开 → 真正发给模型的 ModelMessage[]
    const { rest } = splitSystemFromMessages(promptMsgs);

    // 断言：那条 assistant 轮展开成了「结构化」三条，散文"我读完了执行记录"不作为单独一条 assistant 文本轮混入
    const roles = rest.map((m) => (m as { role: string }).role);
    expect(roles).toEqual(["user", "assistant", "tool", "assistant", "user"]);

    const toolCallMsg = rest[1] as { content: Array<{ type: string; toolName?: string }> };
    expect(toolCallMsg.content[0]?.type).toBe("tool-call");
    expect(toolCallMsg.content[0]?.toolName).toBe("read");

    const toolResultMsg = rest[2] as { role: string; content: Array<{ type: string }> };
    expect(toolResultMsg.role).toBe("tool");
    expect(toolResultMsg.content[0]?.type).toBe("tool-result");

    // 关键反向断言：模型看到的历史里，没有任何一条「role=assistant 且 content 是散文字符串」
    // 冒充「答了文件内容却没调工具」——这正是探针 E/F 触发编造的那种毒样本。
    const prosaicAssistant = rest.find(
      (m) => (m as { role: string }).role === "assistant" && typeof (m as { content: unknown }).content === "string",
    );
    expect(prosaicAssistant).toBeUndefined();
  });

  it("旧消息无 parts（历史遗留）→ 退化回散文文本回放，不炸（向后兼容）", () => {
    const hist: DbMessage[] = [
      makeDbMessage({ id: "u1", role: "user", content: "你好" }),
      makeDbMessage({ id: "a1", role: "assistant", content: "你好呀", parts: null }),
    ];
    const chatMessages = dbMessagesToChat(hist, []);
    const promptMsgs = buildChatPromptMessages({
      messages: chatMessages,
      effectiveWorkspace: null,
      primaryIsCli: false,
      projectMemoryPreamble: null,
      crossProjectPreamble: null,
      workspacePreamble: null,
      tooLargeNotice: (name) => `${name} 太大`,
    });
    const { rest } = splitSystemFromMessages(promptMsgs);
    expect(rest.at(-1)).toEqual({ role: "assistant", content: "你好呀" });
  });

  it("mixed/marker/malformed/unknown parts 整轮不回放，只有 null/空 parts 回退 content", () => {
    const mixed = JSON.stringify([{ role: "assistant", content: [{ type: "tool-call", toolCallId: "w", toolName: "web_fetch", input: { url: "https://x" } }] }]);
    for (const parts of [mixed, JSON.stringify({ version: 1, kind: "web_fetch_history", status: "withheld" }), "{bad", JSON.stringify([{ role: "assistant", content: [{ type: "unknown" }] }])]) {
      const chat = dbMessagesToChat([makeDbMessage({ id: "bad", content: "must-not-fallback", parts })], []);
      const prompt = buildChatPromptMessages({ messages: chat, effectiveWorkspace: "/repo", primaryIsCli: false, projectMemoryPreamble: null, crossProjectPreamble: null, workspacePreamble: null, tooLargeNotice: (n) => n });
      expect(splitSystemFromMessages(prompt).rest.some((m) => JSON.stringify(m).includes("must-not-fallback"))).toBe(false);
    }
    for (const parts of [null, ""]) {
      const chat = dbMessagesToChat([makeDbMessage({ id: "plain", content: "fallback", parts })], []);
      const prompt = buildChatPromptMessages({ messages: chat, effectiveWorkspace: null, primaryIsCli: false, projectMemoryPreamble: null, crossProjectPreamble: null, workspacePreamble: null, tooLargeNotice: (n) => n });
      expect(splitSystemFromMessages(prompt).rest.at(-1)).toEqual({ role: "assistant", content: "fallback" });
    }
  });
});
