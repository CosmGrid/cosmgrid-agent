import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCodeTaskWorkflowSnapshot } from "@/lib/workflow/code-task-template";

const mocks = vi.hoisted(() => ({
  getActiveByConversation: vi.fn(),
  createRun: vi.fn(),
  saveSnapshot: vi.fn(),
  appendEvent: vi.fn(),
  listExamples: vi.fn(),
  classifyTurnIntentWithJudge: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  workflowRuns: {
    getActiveByConversation: mocks.getActiveByConversation,
    create: mocks.createRun,
    saveSnapshot: mocks.saveSnapshot,
    appendEvent: mocks.appendEvent,
  },
  intentLearning: {
    listExamples: mocks.listExamples,
    recordFeedback: vi.fn(),
    upsertExample: vi.fn(),
  },
}));

vi.mock("@/lib/workflow/intent-judge", () => ({
  classifyTurnIntentWithJudge: mocks.classifyTurnIntentWithJudge,
}));

vi.mock("@/lib/app-settings", () => ({
  isDeveloperDiagnosticsEnabled: () => false,
}));

vi.mock("@/lib/workflow/intent-feedback", () => ({
  detectIntentCorrection: () => null,
  intentActionLabel: (action: string) => action,
}));

vi.mock("@/lib/workflow/intent-decay", () => ({
  downweightMisjudgedExampleInDb: vi.fn(),
}));

import { prepareTurnWorkflow } from "@/lib/workflow/prepare-turn-workflow";

describe("prepareTurnWorkflow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listExamples.mockResolvedValue([]);
    mocks.getActiveByConversation.mockResolvedValue(null);
  });

  it("leaves workflow untouched in pure single-model mode", async () => {
    const applySnapshot = vi.fn();

    const result = await prepareTurnWorkflow({
      conversationId: "conversation-1",
      projectId: null,
      pureMode: true,
      initialSnapshot: null,
      text: "start implementing",
      userId: "user-1",
      intentJudgeModel: null,
      workspacePath: "/workspace",
      applySnapshot,
    });

    expect(result).toEqual({
      snapshot: null,
      runId: null,
      shouldCompleteNode: false,
      intentDecision: null,
      intentJudgeCalled: false,
      workflowAdvanced: false,
    });
    expect(mocks.classifyTurnIntentWithJudge).not.toHaveBeenCalled();
    expect(applySnapshot).not.toHaveBeenCalled();
  });

  it("creates and applies a workflow when intent starts a run", async () => {
    mocks.classifyTurnIntentWithJudge.mockResolvedValue({
      action: "start_run",
      confidence: 0.95,
      reason: "new implementation task",
      patch: { objective: "Implement feature A" },
    });
    const applySnapshot = vi.fn();

    const result = await prepareTurnWorkflow({
      conversationId: "conversation-1",
      projectId: "project-1",
      pureMode: false,
      initialSnapshot: null,
      text: "Implement feature A",
      userId: "user-1",
      intentJudgeModel: null,
      workspacePath: "/workspace",
      applySnapshot,
    });

    expect(result.intentDecision?.action).toBe("start_run");
    expect(result.shouldCompleteNode).toBe(true);
    expect(result.workflowAdvanced).toBe(true);
    expect(result.runId).toBeTruthy();
    expect(mocks.createRun).toHaveBeenCalledOnce();
    expect(applySnapshot).toHaveBeenCalledWith(result.snapshot);
  });

  // 2026-07-16 review 修复回归测试：classifier 判定 start_run 时，如果调用方已经带着一个
  // 正在跑的 run（initialSnapshot 非空），之前直接 create 插入新行，旧行的 status 原样
  // 停在 running，getActiveByConversation 只按 updated_at 取最新一条，旧行从此没有任何
  // 代码路径会碰它——永久卡在"活跃"状态污染审计视图。现在应该先把旧 run 标 cancelled
  // 落库，再创建新 run。
  it("start_run 判定命中且已有活跃 run → 先把旧 run 标 cancelled 落库，再创建新 run", async () => {
    const existing = createCodeTaskWorkflowSnapshot({
      runId: "run-old",
      conversationId: "conversation-1",
      objective: "Old task still running",
      workspacePath: "/workspace",
    });
    mocks.classifyTurnIntentWithJudge.mockResolvedValue({
      action: "start_run",
      confidence: 0.95,
      reason: "new implementation task",
      patch: { objective: "Implement feature B" },
    });
    const applySnapshot = vi.fn();

    const result = await prepareTurnWorkflow({
      conversationId: "conversation-1",
      projectId: "project-1",
      pureMode: false,
      initialSnapshot: existing,
      text: "Implement feature B",
      userId: "user-1",
      intentJudgeModel: null,
      workspacePath: "/workspace",
      applySnapshot,
    });

    // 旧 run 被标成 cancelled 落库了
    expect(mocks.saveSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-old",
        snapshot: expect.objectContaining({ runId: "run-old", status: "cancelled" }),
        eventType: "workflow.superseded_by_new_run",
      }),
    );
    // 新 run 正常创建，且是一个全新的 runId（不是复用旧的）
    expect(mocks.createRun).toHaveBeenCalledOnce();
    expect(result.runId).toBeTruthy();
    expect(result.runId).not.toBe("run-old");
  });

  it("records an observed answer without advancing an existing workflow", async () => {
    const existing = createCodeTaskWorkflowSnapshot({
      runId: "run-1",
      conversationId: "conversation-1",
      objective: "Existing task",
      workspacePath: "/workspace",
    });
    mocks.classifyTurnIntentWithJudge.mockResolvedValue({
      action: "answer_only",
      confidence: 0.9,
      reason: "question only",
    });

    const result = await prepareTurnWorkflow({
      conversationId: "conversation-1",
      projectId: null,
      pureMode: false,
      initialSnapshot: existing,
      text: "Explain the current status",
      userId: "user-1",
      intentJudgeModel: null,
      workspacePath: "/workspace",
      applySnapshot: vi.fn(),
    });

    expect(result.snapshot).toBe(existing);
    expect(result.workflowAdvanced).toBe(false);
    expect(mocks.appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        workflowRunId: "run-1",
        eventType: "workflow.intent_observed",
      }),
    );
    expect(mocks.saveSnapshot).not.toHaveBeenCalled();
  });
});
