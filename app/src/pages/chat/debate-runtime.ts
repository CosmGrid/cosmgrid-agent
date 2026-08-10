import type { Dispatch, SetStateAction } from "react";
import type { TFunction } from "i18next";
import type { CredentialListItem, ModelListItem } from "@/lib/api";
import { workflowRuns, type Conversation } from "@/lib/db";
import { executeDebateTurn } from "@/lib/llm/debate-turn";
import { isFullDebateResult } from "@/lib/llm/debate-result";
import { isExplicitDebateRequest } from "@/lib/workflow/intent-classifier";
import { createCodeTaskWorkflowSnapshot } from "@/lib/workflow/code-task-template";
import {
  applyTurnIntentDecision,
  completeCurrentWorkflowNode,
} from "@/lib/workflow/reducer";
import type {
  TurnIntentDecision,
  WorkflowSnapshot,
} from "@/lib/workflow/types";
import type { ChatMessage } from "@/pages/chat/types";

interface DebatePreparation {
  conversationId: string | null;
  workspacePath: string | null;
  workflowSnapshot: WorkflowSnapshot | null;
  workflowRunId: string | null;
  intentDecision: TurnIntentDecision | null;
  persistAssistant: (
    content: string,
    modelId: string | null,
    usage?: { inputTokens: number; outputTokens: number },
  ) => void;
}

interface RunDebateRuntimeOptions {
  prep: DebatePreparation;
  pureMode: boolean;
  text: string;
  model: ModelListItem;
  availableModels: ModelListItem[];
  credentials: CredentialListItem[];
  conversationList: Conversation[];
  messages: ChatMessage[];
  userMessage: ChatMessage;
  visibleMessages: ChatMessage[];
  controller: AbortController;
  getApiKey: (credentialId: string) => Promise<string | null>;
  t: TFunction;
  applyWorkflowSnapshot: (snapshot: WorkflowSnapshot) => void;
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  setPanelOpen: Dispatch<SetStateAction<boolean>>;
  setIsStreaming: Dispatch<SetStateAction<boolean>>;
  setStreamError: Dispatch<SetStateAction<string | null>>;
  setSwitchNotice: Dispatch<SetStateAction<string | null>>;
  setCacheNotice: Dispatch<SetStateAction<string | null>>;
  setPersistNotice: Dispatch<SetStateAction<string | null>>;
  setDebateParticipants: Dispatch<
    SetStateAction<Array<{ modelId: string; modelName: string }> | null>
  >;
  markStickToBottom: () => void;
  isCurrentTurn: () => boolean;
  releaseTurnState: () => boolean;
}

export function shouldRunDebateTurn(args: {
  pureMode: boolean;
  text: string;
  intentDecision: TurnIntentDecision | null;
}): boolean {
  if (args.pureMode) return false;
  return (
    args.intentDecision?.patch?.debateRequested === true ||
    isExplicitDebateRequest(args.text)
  );
}

export async function runDebateRuntime(
  options: RunDebateRuntimeOptions,
): Promise<boolean> {
  if (
    !shouldRunDebateTurn({
      pureMode: options.pureMode,
      text: options.text,
      intentDecision: options.prep.intentDecision,
    })
  ) {
    return false;
  }
  if (!options.isCurrentTurn()) return true;

  const { conversationId, workspacePath } = options.prep;
  const projectId =
    (conversationId
      ? options.conversationList.find(
          (conversation) => conversation.id === conversationId,
        )?.projectId
      : null) ?? null;
  let activeSnapshot = options.prep.workflowSnapshot;
  let activeRunId = options.prep.workflowRunId;

  if (!activeSnapshot && conversationId) {
    try {
      const runId = crypto.randomUUID();
      const base = createCodeTaskWorkflowSnapshot({
        runId,
        conversationId,
        projectId,
        workspacePath,
        objective: options.text,
      });
      const debateSnapshot = applyTurnIntentDecision({
        snapshot: base,
        decision: {
          action: "continue_run",
          targetRunId: runId,
          confidence: 1,
          reason: "用户明确要求开始博弈",
          evidenceTurnIds: [],
          patch: { debateRequested: true },
        },
      });
      await workflowRuns.create({
        conversationId,
        projectId,
        snapshot: debateSnapshot,
      });
      activeSnapshot = debateSnapshot;
      activeRunId = runId;
      if (options.isCurrentTurn()) {
        options.applyWorkflowSnapshot(debateSnapshot);
      }
    } catch {
      // A temporary workflow failure does not block debate.
    }
  }

  if (!options.isCurrentTurn()) return true;

  const assistantId = crypto.randomUUID();
  const estimatedParticipants = Math.min(
    Math.max(options.availableModels.length, 1),
    4,
  );
  const estimatedCallCount =
    estimatedParticipants <= 1 ? 1 : estimatedParticipants === 2 ? 3 : estimatedParticipants;
  const modelLabel = options.t("chat.workPanel.dynamicModelPool");
  const costNote: ChatMessage = {
    id: crypto.randomUUID(),
    role: "assistant",
    content: options.t("chat.debate.costWarning", {
      count: estimatedCallCount,
    }),
    createdAt: new Date().toISOString(),
    modelLabel,
    kind: "system-notice",
  };
  const debateMessage: ChatMessage = {
    id: assistantId,
    role: "assistant",
    content: options.t("chat.debate.running"),
    createdAt: new Date().toISOString(),
    modelLabel,
  };

  options.markStickToBottom();
  options.setPanelOpen(true);
  options.setMessages([...options.visibleMessages, costNote, debateMessage]);
  options.setIsStreaming(true);
  options.setStreamError(null);
  options.setSwitchNotice(null);
  options.setCacheNotice(null);
  options.setPersistNotice(null);

  try {
    const debate = await executeDebateTurn({
      primaryModel: options.model,
      availableModels: options.availableModels,
      credentials: options.credentials,
      workspacePath,
      messages: options.messages,
      userMessage: options.userMessage,
      projectId,
      workflowRunId: activeRunId,
      getApiKey: options.getApiKey,
      signal: options.controller.signal,
      t: options.t,
      onParticipants: (participants) => {
        if (!options.isCurrentTurn()) return;
        options.setDebateParticipants(
          participants.map((participant) => {
            const found = options.availableModels.find(
              (candidate) => candidate.id === participant.modelId,
            );
            return {
              modelId: participant.modelId,
              modelName:
                found?.displayName || found?.name || participant.modelName,
            };
          }),
        );
      },
    });

    if (!options.isCurrentTurn()) return true;

    options.setMessages((previous) =>
      previous.map((message) =>
        message.id === assistantId
          ? {
              ...message,
              content: debate.content,
              usage: { ...debate.usage, toolCallCount: 0 },
            }
          : message,
      ),
    );
    options.prep.persistAssistant(
      debate.content,
      debate.result.rounds.at(-1)?.modelId ?? options.model.id,
      debate.usage,
    );

    if (conversationId && activeSnapshot && activeRunId) {
      const fullDebate = isFullDebateResult(debate.result);
      const nextWorkflow = completeCurrentWorkflowNode({
        snapshot: activeSnapshot,
        summary: debate.result.finalSolution.slice(0, 1200),
        planSource: {
          kind: fullDebate ? "debate_result" : "degraded_debate",
          ref: `debate:${activeRunId}`,
          summary: debate.result.finalSolution.slice(0, 1200),
          phase: "debate",
          boundAt: new Date().toISOString(),
          label: fullDebate
            ? "完整多模型博弈结果"
            : "多模型博弈未完成后的降级方案",
        },
      });
      await workflowRuns.saveSnapshot({
        runId: activeRunId,
        snapshot: nextWorkflow,
        eventType: "workflow.debate_completed",
        eventPayload: {
          participantModelIds: debate.participants.map(
            (participant) => participant.modelId,
          ),
          rounds: debate.result.rounds.map((round) => ({
            role: round.role,
            modelId: round.modelId,
          })),
        },
      });
      if (options.isCurrentTurn()) {
        options.applyWorkflowSnapshot(nextWorkflow);
      }
    }
  } catch (error) {
    if ((error as Error).name === "AbortError") {
      if (options.isCurrentTurn()) {
        options.setMessages((previous) =>
          previous.map((message) =>
            message.id === assistantId
              ? { ...message, content: options.t("chat.stopped") }
              : message,
          ),
        );
      }
      await updateFailedWorkflow(
        "cancelled",
        activeSnapshot,
        activeRunId,
        options.applyWorkflowSnapshot,
        options.isCurrentTurn,
      );
      return true;
    }

    const message =
      error instanceof Error ? error.message : options.t("chat.debate.failed");
    if (options.isCurrentTurn()) {
      options.setMessages((previous) =>
        previous.map((item) =>
          item.id === assistantId ? { ...item, content: message } : item,
        ),
      );
      options.prep.persistAssistant(message, null);
      options.setStreamError(message);
    }
    await updateFailedWorkflow(
      "failed",
      activeSnapshot,
      activeRunId,
      options.applyWorkflowSnapshot,
      options.isCurrentTurn,
      message,
    );
  } finally {
    if (options.releaseTurnState()) {
      options.setDebateParticipants(null);
    }
  }
  return true;
}

async function updateFailedWorkflow(
  status: "cancelled" | "failed",
  snapshot: WorkflowSnapshot | null,
  runId: string | null,
  applySnapshot: (snapshot: WorkflowSnapshot) => void,
  isCurrentTurn: () => boolean,
  message?: string,
): Promise<void> {
  if (!snapshot || !runId) return;
  const next: WorkflowSnapshot = {
    ...snapshot,
    status,
    nodes: snapshot.nodes.map((node) =>
      node.id === snapshot.currentNodeId
        ? { ...node, status: status === "cancelled" ? "skipped" : "failed" }
        : node,
    ),
  };
  await workflowRuns
    .saveSnapshot({
      runId,
      snapshot: next,
      eventType:
        status === "cancelled"
          ? "workflow.debate_cancelled"
          : "workflow.debate_failed",
      eventPayload:
        status === "cancelled" ? { reason: "user_stopped" } : { message },
    })
    .catch(() => {});
  if (isCurrentTurn()) applySnapshot(next);
}
