import { intentLearning, workflowRuns } from "@/lib/db";
import { isDeveloperDiagnosticsEnabled } from "@/lib/app-settings";
import { createCodeTaskWorkflowSnapshot } from "@/lib/workflow/code-task-template";
import { downweightMisjudgedExampleInDb } from "@/lib/workflow/intent-decay";
import {
  detectIntentCorrection,
  intentActionLabel,
} from "@/lib/workflow/intent-feedback";
import { classifyTurnIntentWithJudge } from "@/lib/workflow/intent-judge";
import { appendIntentDiagnostics } from "@/lib/workflow/intent-diagnostics-buffer";
import { applyTurnIntentDecision } from "@/lib/workflow/reducer";
import {
  BUILTIN_INTENT_EXAMPLES,
  routeTurnIntentSemantically,
  type IntentExample,
} from "@/lib/workflow/semantic-intent-router";
import type {
  TurnIntentDecision,
  WorkflowSnapshot,
} from "@/lib/workflow/types";

interface PrepareTurnWorkflowOptions {
  conversationId: string | null;
  projectId: string | null;
  pureMode: boolean;
  initialSnapshot: WorkflowSnapshot | null;
  text: string;
  userId: string;
  intentJudgeModel: Parameters<
    typeof classifyTurnIntentWithJudge
  >[0]["model"];
  workspacePath: string | null;
  applySnapshot: (snapshot: WorkflowSnapshot) => void;
  /** 本轮的 AbortSignal（来自 handleSend 的 controller.signal）——透传给意图判断 LLM，
   *  让它在「停止」或被取消时及时中断，且不无限挂起（B3）。 */
  abortSignal?: AbortSignal;
}

export interface PreparedTurnWorkflow {
  snapshot: WorkflowSnapshot | null;
  runId: string | null;
  shouldCompleteNode: boolean;
  intentDecision: TurnIntentDecision | null;
  intentJudgeCalled: boolean;
  workflowAdvanced: boolean;
}

export async function prepareTurnWorkflow(
  options: PrepareTurnWorkflowOptions,
): Promise<PreparedTurnWorkflow> {
  let snapshot = options.initialSnapshot;
  let runId = snapshot?.runId ?? null;
  const idleResult = (): PreparedTurnWorkflow => ({
    snapshot,
    runId,
    shouldCompleteNode: false,
    intentDecision: null,
    intentJudgeCalled: false,
    workflowAdvanced: false,
  });

  if (!options.conversationId || options.pureMode) return idleResult();

  try {
    if (!snapshot) {
      const activeRun = await workflowRuns.getActiveByConversation(
        options.conversationId,
      );
      snapshot = activeRun?.snapshot ?? null;
      runId = snapshot?.runId ?? null;
      if (snapshot) options.applySnapshot(snapshot);
    }

    const learnedExamples = await loadLearnedIntentExamples(
      options.text,
      snapshot,
    );
    const decision = await classifyTurnIntentWithJudge({
      text: options.text,
      activeRun: snapshot,
      recentTurnIds: [options.userId],
      model: options.intentJudgeModel,
      learnedExamples,
      abortSignal: options.abortSignal,
    });

    captureIntentDiagnostics(options.text, decision, learnedExamples);

    if (decision.action === "start_run") {
      runId = crypto.randomUUID();
      snapshot = createCodeTaskWorkflowSnapshot({
        runId,
        conversationId: options.conversationId,
        projectId: options.projectId,
        workspacePath: options.workspacePath,
        objective: decision.patch?.objective ?? options.text,
        executionMode: decision.patch?.executionMode,
      });
      await workflowRuns.create({
        conversationId: options.conversationId,
        projectId: options.projectId,
        snapshot,
      });
      options.applySnapshot(snapshot);
      return {
        snapshot,
        runId,
        shouldCompleteNode: true,
        intentDecision: decision,
        intentJudgeCalled: true,
        workflowAdvanced: true,
      };
    }

    if (snapshot && decision.action !== "answer_only") {
      const nextSnapshot = applyTurnIntentDecision({ snapshot, decision });
      await workflowRuns.saveSnapshot({
        runId: nextSnapshot.runId,
        snapshot: nextSnapshot,
        eventType: "workflow.intent_applied",
        eventPayload: { decision },
      });
      options.applySnapshot(nextSnapshot);
      return {
        snapshot: nextSnapshot,
        runId: nextSnapshot.runId,
        shouldCompleteNode: true,
        intentDecision: decision,
        intentJudgeCalled: true,
        workflowAdvanced: true,
      };
    }

    if (runId) {
      await workflowRuns.appendEvent({
        workflowRunId: runId,
        conversationId: options.conversationId,
        eventType: "workflow.intent_observed",
        payload: { decision },
      });
    }

    return {
      snapshot,
      runId,
      shouldCompleteNode: false,
      intentDecision: decision,
      intentJudgeCalled: true,
      workflowAdvanced: false,
    };
  } catch {
    return idleResult();
  }
}

async function loadLearnedIntentExamples(
  text: string,
  snapshot: WorkflowSnapshot | null,
): Promise<IntentExample[]> {
  try {
    const correction = detectIntentCorrection(text);
    if (correction) {
      await intentLearning.recordFeedback({
        userText: text,
        predictedAction: correction.predictedAction,
        correctedAction: correction.correctedAction,
        workflowState: snapshot?.currentNodeId ?? snapshot?.status ?? null,
        source: "user_text",
        reason: `用户明确纠正：不是${intentActionLabel(correction.predictedAction)}，而是${intentActionLabel(correction.correctedAction)}`,
      });
      const examplesBeforeCorrection = [
        ...BUILTIN_INTENT_EXAMPLES,
        ...(await intentLearning.listExamples({ enabledOnly: true })),
      ];
      await downweightMisjudgedExampleInDb(
        text,
        correction.predictedAction,
        examplesBeforeCorrection,
      ).catch(() => {});
      await intentLearning.upsertExample({
        action: correction.correctedAction,
        text,
        explanation: `用户纠正过：这类表达应识别为${intentActionLabel(correction.correctedAction)}，不是${intentActionLabel(correction.predictedAction)}。`,
        source: "user_correction",
        confidence: correction.confidence,
        weight: 1.25,
        enabled: true,
      });
    }

    return (await intentLearning.listExamples({ enabledOnly: true })).map(
      (example) => ({
        id: example.id,
        action: example.action,
        text: example.text,
        explanation: example.explanation,
        source: example.source,
        weight: example.weight,
        enabled: example.enabled,
      }),
    );
  } catch {
    return [];
  }
}

function captureIntentDiagnostics(
  text: string,
  decision: TurnIntentDecision,
  learnedExamples: IntentExample[],
): void {
  try {
    if (!isDeveloperDiagnosticsEnabled()) return;
    const route =
      decision.semanticRoute ??
      routeTurnIntentSemantically(
        text,
        learnedExamples.length
          ? [...BUILTIN_INTENT_EXAMPLES, ...learnedExamples]
          : BUILTIN_INTENT_EXAMPLES,
      );
    appendIntentDiagnostics({
      id: crypto.randomUUID(),
      capturedAt: new Date().toISOString(),
      userTextExcerpt: text.length > 80 ? `${text.slice(0, 80)}…` : text,
      decision,
      route,
    });
  } catch {
    // Diagnostics never block the conversation.
  }
}
