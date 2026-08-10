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
    });

    captureIntentDiagnostics(options.text, decision, learnedExamples);

    if (decision.action === "start_run") {
      // 2026-07-16 review 修复：start_run 之前如果已经有一个正在跑的 run（snapshot 非空，
      // 来自本轮上面 options.initialSnapshot 或 getActiveByConversation 查到的活跃 run），
      // 之前这里直接 workflowRuns.create 插入新行，旧行的 status 原样留在
      // running/waiting_user/paused，getActiveByConversation 只按 updated_at 取最新一条，
      // 旧行从此再也没有任何代码路径会碰它——永久卡在"活跃"状态，污染审计视图
      // （getAuditSummary/会话工作流历史）。这里先把旧 run 标成 cancelled 落库（复用
      // applyTurnIntentDecision 的 cancel_run 分支同一套终态转换逻辑），再创建新 run。
      if (snapshot) {
        const cancelledOldSnapshot = applyTurnIntentDecision({
          snapshot,
          decision: {
            action: "cancel_run",
            targetRunId: snapshot.runId,
            confidence: 1,
            reason: "start_run classifier 判定开启新任务，旧 run 视为被取代",
            evidenceTurnIds: [],
          },
        });
        await workflowRuns.saveSnapshot({
          runId: cancelledOldSnapshot.runId,
          snapshot: cancelledOldSnapshot,
          eventType: "workflow.superseded_by_new_run",
          eventPayload: { reason: "start_run classifier 判定开启新任务，旧 run 视为被取代" },
        });
      }
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
