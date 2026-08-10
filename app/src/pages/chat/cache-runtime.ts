import type { Dispatch, SetStateAction } from "react";
import { lookupCache } from "@/lib/llm/semantic-cache";
import {
  prepareSemanticCacheTurn,
  type PreparedSemanticCacheTurn,
} from "@/lib/llm/semantic-cache-turn";
import type { LanguageModel } from "@/lib/llm/provider-factory";
import type { TurnIntentDecision, WorkflowSnapshot } from "@/lib/workflow/types";
import type { ChatMessage } from "@/pages/chat/types";

type PersistAssistant = (
  content: string,
  modelId: string | null,
  usage?: { inputTokens: number; outputTokens: number },
  kind?: ChatMessage["kind"],
  toolCallCount?: number | null,
) => void;

export interface RunSemanticCacheRuntimeArgs {
  text: string;
  newMessages: ChatMessage[];
  modelId: string;
  modelLabel: string;
  pureMode: boolean;
  smartRoutingEnabled: boolean;
  workspacePath: string | null;
  workflowSnapshot: WorkflowSnapshot | null;
  intentJudgeCalledThisTurn: boolean;
  turnIntentDecision: TurnIntentDecision | null;
  intentJudgeModel: LanguageModel | null;
  persistAssistant: PersistAssistant;
  cacheHitLabel: (days: number) => string;
  markStickToBottom: () => void;
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  setIsStreaming: Dispatch<SetStateAction<boolean>>;
  setStreamError: Dispatch<SetStateAction<string | null>>;
  setSwitchNotice: Dispatch<SetStateAction<string | null>>;
  setCacheNotice: Dispatch<SetStateAction<string | null>>;
  setPersistNotice: Dispatch<SetStateAction<string | null>>;
  onCacheHitDone: () => void;
  isCurrentTurn: () => boolean;
}

export type SemanticCacheRuntimeResult =
  | { hit: true }
  | ({
    hit: false;
    assistantId: string;
    assistantMsg: ChatMessage;
    turnStartedAt: string;
  } & PreparedSemanticCacheTurn);

export async function runSemanticCacheRuntime(
  args: RunSemanticCacheRuntimeArgs,
): Promise<SemanticCacheRuntimeResult> {
  if (!args.isCurrentTurn()) return { hit: true };

  const assistantId = crypto.randomUUID();
  const assistantMsg: ChatMessage = {
    id: assistantId,
    role: "assistant",
    content: "",
    createdAt: new Date().toISOString(),
    modelLabel: args.modelLabel,
  };

  args.markStickToBottom();
  args.setMessages([...args.newMessages, assistantMsg]);
  args.setIsStreaming(true);
  args.setStreamError(null);
  args.setSwitchNotice(null);
  args.setCacheNotice(null);
  args.setPersistNotice(null);

  const turnStartedAt = new Date().toISOString();
  const preparedCache = await prepareSemanticCacheTurn({
    text: args.text,
    pureMode: args.pureMode,
    smartRoutingEnabled: args.smartRoutingEnabled,
    workspacePath: args.workspacePath,
    workflowSnapshot: args.workflowSnapshot,
    intentJudgeCalledThisTurn: args.intentJudgeCalledThisTurn,
    turnIntentDecision: args.turnIntentDecision,
    intentJudgeModel: args.intentJudgeModel,
  });
  if (!args.isCurrentTurn()) return { hit: true };

  if (preparedCache.cacheEligible) {
    let hit: Awaited<ReturnType<typeof lookupCache>> = null;
    try {
      hit = await lookupCache(args.text);
    } catch {
      // 缓存查询失败不影响主流程，继续走真实模型。
    }
    // Stop 后查询 Promise 仍可能晚到。此时把旧轮视为已经结束，但不得再写消息、
    // 持久化答案或清理由新轮持有的全局状态。
    if (!args.isCurrentTurn()) return { hit: true };
    if (hit) {
      const days = Math.max(0, Math.floor(hit.ageMs / 86_400_000));
      args.setMessages((prev) =>
        prev.map((message) =>
          message.id === assistantId ? { ...message, content: hit.responseText } : message,
        ),
      );
      args.persistAssistant(hit.responseText, args.modelId);
      args.setCacheNotice(args.cacheHitLabel(days));
      args.onCacheHitDone();
      return { hit: true };
    }
  }

  return {
    hit: false,
    assistantId,
    assistantMsg,
    turnStartedAt,
    ...preparedCache,
  };
}
