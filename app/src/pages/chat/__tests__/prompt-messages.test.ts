import { describe, expect, it } from "vitest";
import { buildChatPromptMessages } from "../prompt-messages";
import type { ChatMessage } from "../types";

function textContent(content: unknown): string {
  return typeof content === "string" ? content : "";
}

describe("buildChatPromptMessages", () => {
  it("keeps receipt messages out of the model prompt and adds no-tools guard for API chats without workspace", () => {
    const messages: ChatMessage[] = [
      { id: "user-1", role: "user", content: "解释一下这个问题" },
      { id: "receipt-1", role: "assistant", content: "内部回执", kind: "receipt" },
      { id: "assistant-1", role: "assistant", content: "上一轮回答" },
    ];

    const prompt = buildChatPromptMessages({
      messages,
      effectiveWorkspace: null,
      primaryIsCli: false,
      projectMemoryPreamble: null,
      crossProjectPreamble: null,
      workspacePreamble: null,
      tooLargeNotice: (name) => `${name} 太大`,
    });

    expect(prompt.some((m) => textContent(m.content).includes("内部回执"))).toBe(false);
    expect(prompt.some((m) => m.role === "system" && textContent(m.content).includes("没有接入任何工具"))).toBe(true);
    expect(prompt.at(-2)).toEqual({ role: "user", content: "解释一下这个问题" });
    expect(prompt.at(-1)).toEqual({ role: "assistant", content: "上一轮回答" });
  });

  it("结构化工具历史：assistant 带合法 parts JSON → 解析并挂到 ChatMsg.parts（供发送边界展开）", () => {
    const structured = [
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "read", input: {} }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "read", output: { type: "text", value: "x" } }] },
    ];
    const prompt = buildChatPromptMessages({
      messages: [
        { id: "u1", role: "user", content: "读文件" },
        { id: "a1", role: "assistant", content: "读完了", parts: JSON.stringify(structured) },
      ],
      effectiveWorkspace: "/repo",
      primaryIsCli: false,
      projectMemoryPreamble: null,
      crossProjectPreamble: null,
      workspacePreamble: null,
      tooLargeNotice: (name) => `${name} 太大`,
    });
    const assistantMsg = prompt.at(-1) as { role: string; content: string; parts?: unknown[] };
    expect(assistantMsg.role).toBe("assistant");
    expect(assistantMsg.content).toBe("读完了"); // content 保留（token 估算/兜底）
    expect(assistantMsg.parts).toEqual(structured); // 结构化 parts 已挂上
  });

  it("结构化工具历史：assistant 的 parts 是坏 JSON → 整轮不发送给 provider", () => {
    const prompt = buildChatPromptMessages({
      messages: [{ id: "a1", role: "assistant", content: "回答", parts: "{坏JSON" }],
      effectiveWorkspace: "/repo",
      primaryIsCli: false,
      projectMemoryPreamble: null,
      crossProjectPreamble: null,
      workspacePreamble: null,
      tooLargeNotice: (name) => `${name} 太大`,
    });
    expect(prompt.some((message) => message.role === "assistant" && message.content === "回答")).toBe(false);
  });

  it("adds workspace guards and omits no-tools guard when a workspace is bound", () => {
    const prompt = buildChatPromptMessages({
      messages: [{ id: "user-1", role: "user", content: "读一下项目" }],
      effectiveWorkspace: "/repo",
      primaryIsCli: false,
      projectMemoryPreamble: "项目记忆",
      crossProjectPreamble: "跨项目记忆",
      workspacePreamble: "工作区说明",
      tooLargeNotice: (name) => `${name} 太大`,
    });

    expect(prompt.map((m) => textContent(m.content))).toEqual(
      expect.arrayContaining(["项目记忆", "跨项目记忆", "工作区说明"]),
    );
    expect(prompt.some((m) => textContent(m.content).includes("图片"))).toBe(true);
    expect(prompt.some((m) => textContent(m.content).includes("没有接入任何工具"))).toBe(false);
  });

  it("injects workflow context as a system fact so plan provenance survives model switching", () => {
    const prompt = buildChatPromptMessages({
      messages: [{ id: "user-1", role: "user", content: "开始执行" }],
      effectiveWorkspace: "/repo",
      primaryIsCli: false,
      projectMemoryPreamble: null,
      crossProjectPreamble: null,
      workspacePreamble: "工作区说明",
      workflowPreamble: "当前工作流上下文：执行基于 /Users/me/Desktop/PLAN.md",
      tooLargeNotice: (name) => `${name} 太大`,
    });

    expect(prompt.some((m) => m.role === "system" && textContent(m.content).includes("当前工作流上下文"))).toBe(true);
    expect(prompt.some((m) => m.role === "system" && textContent(m.content).includes("/Users/me/Desktop/PLAN.md"))).toBe(true);
  });

  it("injects active skill guidance as a system fact", () => {
    const prompt = buildChatPromptMessages({
      messages: [{ id: "user-1", role: "user", content: "开始执行" }],
      effectiveWorkspace: "/repo",
      primaryIsCli: false,
      projectMemoryPreamble: null,
      crossProjectPreamble: null,
      workspacePreamble: null,
      workflowPreamble: "当前工作流上下文：execute",
      skillPreamble: "当前启用技能：按方案执行\n验收标准：必须真实修改并验证。",
      tooLargeNotice: (name) => `${name} 太大`,
    });

    expect(prompt.some((m) => m.role === "system" && textContent(m.content).includes("当前启用技能：按方案执行"))).toBe(true);
    expect(prompt.some((m) => m.role === "system" && textContent(m.content).includes("必须真实修改并验证"))).toBe(true);
  });

  // 真实事故（2026-07-04）：模型上一轮回复"好，再试一次。"但 0 次真实工具调用，
  // 下一轮完全没有依据判断"上一轮到底做了什么"，只能瞎编。见 prompt-messages.ts
  // 的 buildLastTurnNoToolReminder。
  it("上一条 assistant 消息像重试意图但 toolCallCount=0 → 插入系统提醒", () => {
    const messages: ChatMessage[] = [
      { id: "user-1", role: "user", content: "看一下这个网站" },
      { id: "assistant-1", role: "assistant", content: "好，再试一次。", toolCallCount: 0 },
      { id: "user-2", role: "user", content: "？" },
    ];

    const prompt = buildChatPromptMessages({
      messages,
      effectiveWorkspace: "/repo",
      primaryIsCli: false,
      projectMemoryPreamble: null,
      crossProjectPreamble: null,
      workspacePreamble: null,
      tooLargeNotice: (name) => `${name} 太大`,
    });

    expect(prompt.some((m) => m.role === "system" && textContent(m.content).includes("0 次真实工具调用"))).toBe(true);
  });

  it("上一条 assistant 消息 toolCallCount 未记录（undefined）→ 不插入提醒（漏报优于误报）", () => {
    const messages: ChatMessage[] = [
      { id: "user-1", role: "user", content: "看一下这个网站" },
      { id: "assistant-1", role: "assistant", content: "好，再试一次。" },
      { id: "user-2", role: "user", content: "？" },
    ];

    const prompt = buildChatPromptMessages({
      messages,
      effectiveWorkspace: "/repo",
      primaryIsCli: false,
      projectMemoryPreamble: null,
      crossProjectPreamble: null,
      workspacePreamble: null,
      tooLargeNotice: (name) => `${name} 太大`,
    });

    expect(prompt.some((m) => m.role === "system" && textContent(m.content).includes("0 次真实工具调用"))).toBe(false);
  });

  // 真实问题（2026-07-07）：国产模型比 Claude/GPT 更容易在没真调用工具时编造"我看到/
  // 读到"这类话（对照 opencode kimi.txt 的做法），照 modelLabel 命中才追加这段提醒。
  it("modelLabel 是 MiniMax 系列 → 插入国产模型反编造提醒", () => {
    const prompt = buildChatPromptMessages({
      messages: [{ id: "user-1", role: "user", content: "帮我查一下这个仓库" }],
      effectiveWorkspace: "/repo",
      primaryIsCli: false,
      projectMemoryPreamble: null,
      crossProjectPreamble: null,
      workspacePreamble: null,
      tooLargeNotice: (name) => `${name} 太大`,
      modelLabel: "MiniMax-M3",
    });

    expect(prompt.some((m) => m.role === "system" && textContent(m.content).includes("我看到/我读到/我运行了"))).toBe(
      true,
    );
  });

  it("modelLabel 是 Claude/未传 → 不插入国产模型专属提醒", () => {
    const prompt = buildChatPromptMessages({
      messages: [{ id: "user-1", role: "user", content: "帮我查一下这个仓库" }],
      effectiveWorkspace: "/repo",
      primaryIsCli: false,
      projectMemoryPreamble: null,
      crossProjectPreamble: null,
      workspacePreamble: null,
      tooLargeNotice: (name) => `${name} 太大`,
      modelLabel: "Claude Opus 4.8",
    });

    expect(prompt.some((m) => m.role === "system" && textContent(m.content).includes("我看到/我读到/我运行了"))).toBe(
      false,
    );
  });

  it("上一条 assistant 消息真有工具调用（toolCallCount>0）→ 不插入提醒", () => {
    const messages: ChatMessage[] = [
      { id: "user-1", role: "user", content: "看一下这个网站" },
      { id: "assistant-1", role: "assistant", content: "好，再试一次。", toolCallCount: 2 },
      { id: "user-2", role: "user", content: "？" },
    ];

    const prompt = buildChatPromptMessages({
      messages,
      effectiveWorkspace: "/repo",
      primaryIsCli: false,
      projectMemoryPreamble: null,
      crossProjectPreamble: null,
      workspacePreamble: null,
      tooLargeNotice: (name) => `${name} 太大`,
    });

    expect(prompt.some((m) => m.role === "system" && textContent(m.content).includes("0 次真实工具调用"))).toBe(false);
  });
});
