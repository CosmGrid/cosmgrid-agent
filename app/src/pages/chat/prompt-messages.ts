import { buildTimePreamble, buildNoToolsPreamble, buildImageGuardPreamble, buildDomesticModelReminder } from "@/lib/llm/prompts/context-preamble";
import { buildCorePreamble } from "@/lib/llm/prompts/cosmgrid-rules";
import { toUserCoreMessage } from "@/lib/llm/attachments";
import { detectIntentNoToolCall } from "@/lib/llm/harness/feedback";
import type { ChatMsg } from "@/lib/llm/context-compressor";
import type { ChatMessage } from "./types";
import { classifyStructuredParts } from "@/lib/security-invariants/web-fetch-privacy";

// 真实事故（2026-07-04）：模型上一轮回复"好，再试一次。"，本轮 0 个真实工具调用，
// 用户没等到结果追问"？"；模型下一轮完全没有"上一轮到底做没做"的依据，只能盯着
// 那句纯文本自己脑补——结果编出一个从没发生过的细节（张冠李戴说"curl 被拒绝"）。
// 修法：跨轮持久化 toolCallCount（见 db/conversations.ts），组装 prompt 时发现
// 「上一条 assistant 消息像是承诺了动作，但 toolCallCount===0」就插一条 system 提醒，
// 把「上一轮没有真实执行」钉成事实，堵住模型瞎编「上一轮做了什么」的空间。
function buildLastTurnNoToolReminder(messages: ChatMessage[]): string | null {
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant" && m.kind !== "receipt");
  if (!lastAssistant) return null;
  if (lastAssistant.toolCallCount !== 0) return null; // undefined(未记录)/>0 都不触发,漏报优先于误报
  if (!detectIntentNoToolCall(lastAssistant.content)) return null;
  return [
    "⚠️ 系统记录：你上一条回复的措辞像是要重试或执行某个操作，但那一轮实际 0 次真实工具调用——你当时什么也没做。",
    "如果你不确定上一轮具体发生了什么，直接说明「不确定上一步状态」，不要编造细节（比如编造报错信息、编造用错了哪个命令）。",
    "这一轮如果还需要重试，请直接调用工具，不要只用文字说「再试一次」却不实际调用。",
  ].join("\n");
}

export function buildChatPromptMessages(args: {
  messages: ChatMessage[];
  effectiveWorkspace: string | null;
  primaryIsCli: boolean;
  projectMemoryPreamble: string | null;
  crossProjectPreamble: string | null;
  workspacePreamble: string | null;
  workflowPreamble?: string | null;
  skillPreamble?: string | null;
  tooLargeNotice: (name: string) => string;
  /** 当前选中模型的人类可读名（如 "MiniMax-M3"），用于系统提示词里的身份陈述 */
  modelLabel?: string | null;
}): ChatMsg[] {
  const lastTurnReminder = buildLastTurnNoToolReminder(args.messages);
  const domesticModelReminder = buildDomesticModelReminder(args.modelLabel);
  return [
    { role: "system", content: buildCorePreamble(args.effectiveWorkspace, args.modelLabel) },
    { role: "system", content: buildTimePreamble() },
    ...(domesticModelReminder ? [{ role: "system" as const, content: domesticModelReminder }] : []),
    ...(args.projectMemoryPreamble ? [{ role: "system" as const, content: args.projectMemoryPreamble }] : []),
    ...(args.crossProjectPreamble ? [{ role: "system" as const, content: args.crossProjectPreamble }] : []),
    ...(args.workspacePreamble ? [{ role: "system" as const, content: args.workspacePreamble }] : []),
    ...(args.workflowPreamble ? [{ role: "system" as const, content: args.workflowPreamble }] : []),
    ...(args.skillPreamble ? [{ role: "system" as const, content: args.skillPreamble }] : []),
    ...(args.effectiveWorkspace ? [{ role: "system" as const, content: buildImageGuardPreamble() }] : []),
    ...(!args.effectiveWorkspace && !args.primaryIsCli
      ? [{ role: "system" as const, content: buildNoToolsPreamble() }]
      : []),
    ...(lastTurnReminder ? [{ role: "system" as const, content: lastTurnReminder }] : []),
    ...args.messages.filter((m) => m.kind !== "receipt").flatMap((m): ChatMsg[] => {
      if (m.role === "user" && m.attachments && m.attachments.length > 0) {
        return [toUserCoreMessage(m.content, m.attachments, { tooLargeNotice: args.tooLargeNotice })];
      }
      // 结构化工具历史：这条 assistant 轮存了真实的 tool-call/tool-result 结构，挂到 ChatMsg.parts，
      // 发送边界会展开成标准 ModelMessage 回放（而非 content 散文压平），弱模型才不会照散文编造。
      if (m.role === "assistant") {
        const classified = classifyStructuredParts(m.parts);
        if (classified.status === "safe" && classified.parts) {
          return [{ role: m.role, content: m.content, parts: classified.parts as ChatMsg["parts"] }];
        }
        if (m.parts && m.parts.trim() !== "") return [];
      }
      return [{ role: m.role, content: m.content }];
    }),
  ];
}
