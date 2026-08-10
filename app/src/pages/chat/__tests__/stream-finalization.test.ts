import { beforeEach, describe, expect, it, vi } from "vitest";
import { finalizeStreamedChatTurn } from "@/pages/chat/stream-finalization";
import { VERIFY_ACCEPTANCE_CRITERIA } from "@/lib/llm/evidence/verify-acceptance-criteria";
import type { ChatMessage } from "@/pages/chat/types";

const mocks = vi.hoisted(() => ({
  writeCache: vi.fn(),
  saveSnapshot: vi.fn(),
  getById: vi.fn(),
  listByMessage: vi.fn(),
  listByConversation: vi.fn(),
  completeCurrentWorkflowNode: vi.fn(),
  failCurrentWorkflowNode: vi.fn(),
  repairCurrentWorkflowNode: vi.fn(),
  verifyTask: vi.fn(),
}));

vi.mock("@/lib/llm/semantic-cache", () => ({
  writeCache: mocks.writeCache,
}));

vi.mock("@/lib/db", () => ({
  workflowRuns: {
    saveSnapshot: mocks.saveSnapshot,
    getById: mocks.getById,
  },
  toolExecutions: {
    listByMessage: mocks.listByMessage,
    listByConversation: mocks.listByConversation,
  },
}));

vi.mock("@/lib/workflow/reducer", () => ({
  completeCurrentWorkflowNode: mocks.completeCurrentWorkflowNode,
  failCurrentWorkflowNode: mocks.failCurrentWorkflowNode,
  repairCurrentWorkflowNode: mocks.repairCurrentWorkflowNode,
}));

// 2026-07-14：verifyTask 单独 mock 掉——只关心 stream-finalization.ts 按 phase 传对了
// acceptanceCriteria（该不该传 VERIFY_ACCEPTANCE_CRITERIA），verifyTask 自身的判定逻辑
// 已经在 task-verifier.test.ts 里直接、完整地测过，这里不重复。
vi.mock("@/lib/llm/evidence/task-verifier", () => ({
  verifyTask: mocks.verifyTask,
}));

function makeSnapshot(phase: string, overrides: Record<string, unknown> = {}) {
  return {
    runId: "run-1",
    currentNodeId: "node-1",
    nodes: [{ id: "node-1", phase, status: "running", ...overrides }],
  } as never;
}

describe("finalizeStreamedChatTurn", () => {
  beforeEach(() => {
    mocks.writeCache.mockReset();
    // 2026-07-16 review 修复：saveSnapshot 现在返回 { applied: boolean }（乐观锁 CAS 结果），
    // 默认 mock 成 applied: true——大多数测试关心的是"该不该完成/失败节点"，不是 CAS 本身，
    // CAS 未命中的场景单独测（见下方"陈旧写入被 CAS 拒绝"用例）。
    mocks.saveSnapshot.mockReset().mockResolvedValue({ applied: true });
    mocks.getById.mockReset().mockResolvedValue({ snapshotVersion: 0 });
    mocks.listByMessage.mockReset().mockResolvedValue([]);
    mocks.listByConversation.mockReset().mockResolvedValue([]);
    mocks.completeCurrentWorkflowNode.mockReset().mockReturnValue({ runId: "run-1", currentNodeId: null });
    mocks.failCurrentWorkflowNode.mockReset().mockReturnValue({ runId: "run-1", currentNodeId: "node-1" });
    mocks.repairCurrentWorkflowNode.mockReset().mockReturnValue({ runId: "run-1", currentNodeId: "execute" });
    mocks.verifyTask.mockReset().mockReturnValue({
      status: "passes",
      metCriteria: [],
      failedCriteria: [],
      linkedClaims: [],
      conflicts: [],
      decidedAt: "2026-07-14T00:00:00.000Z",
      decisionEvidenceIds: [],
      humanSummary: "ok",
    });
  });

  it("更新工具调用数、持久化助手消息，并写入语义缓存", async () => {
    const setMessages = vi.fn((updater) => updater([{ id: "assistant-1", role: "assistant", content: "old" } as ChatMessage]));
    const persistAssistant = vi.fn();

    const result = await finalizeStreamedChatTurn({
      text: "hello",
      assistantMessage: { id: "assistant-1", role: "assistant", content: "" },
      assistantId: "assistant-1",
      streamingResult: {
        fullContent: "final answer",
        lastModelId: "model-1",
        lastResultModelId: "model-result",
        lastUsage: { inputTokens: 1, outputTokens: 2, toolCallCount: 1 },
        lastToolCallCount: 1,
        harnessDirty: false,
      },
      conversationId: "conv-1",
      conversationIdRef: { current: "conv-1" },
      cacheEligible: true,
      taskRole: "standard",
      shouldCompleteWorkflowNode: false,
      workflowSnapshot: null,
      workflowRunId: null,
      controllerAborted: false,
      persistAssistant,
      setMessages,
      applyWorkflowSnapshot: vi.fn(),
    });

    expect(result.finalContent).toBe("final answer");
    expect(result.finalAssistantMsg).toMatchObject({ id: "assistant-1", content: "final answer" });
    expect(persistAssistant).toHaveBeenCalledWith(
      "final answer",
      "model-1",
      { inputTokens: 1, outputTokens: 2, toolCallCount: 1 },
      undefined,
      1,
    );
    expect(mocks.writeCache).toHaveBeenCalledWith("hello", "final answer", "model-result", "standard");
    expect(setMessages.mock.results[0]?.value[0]).toMatchObject({ toolCallCount: 1 });
  });

  it("verifyNodeOutcome 判定 passed（plan 阶段不要求工具证据）时才完成工作流节点", async () => {
    const nextWorkflow = { runId: "run-1", currentNodeId: null };
    mocks.completeCurrentWorkflowNode.mockReturnValue(nextWorkflow);
    const applyWorkflowSnapshot = vi.fn();
    const workflowSnapshot = makeSnapshot("plan");

    await finalizeStreamedChatTurn({
      text: "hello",
      assistantMessage: { id: "assistant-1", role: "assistant", content: "" },
      assistantId: "assistant-1",
      streamingResult: {
        fullContent: "final answer",
        lastModelId: "model-1",
        lastResultModelId: "model-result",
        lastUsage: undefined,
        lastToolCallCount: 0,
        harnessDirty: false,
      },
      conversationId: "conv-1",
      conversationIdRef: { current: "conv-1" },
      cacheEligible: false,
      taskRole: "standard",
      shouldCompleteWorkflowNode: true,
      workflowSnapshot,
      workflowRunId: "run-1",
      controllerAborted: false,
      persistAssistant: vi.fn(),
      setMessages: vi.fn((updater) => updater([])),
      applyWorkflowSnapshot,
    });

    // 2026-07-15 review 修复：工作流验收现在是 fire-and-forget 后台跑（不阻塞 isStreaming
    // 归位），finalizeStreamedChatTurn 的 await 结束不代表这段副作用已经跑完，要显式等它。
    await vi.waitFor(() => expect(applyWorkflowSnapshot).toHaveBeenCalled());

    // 阶段3（2026-07-11）：completeCurrentWorkflowNode 现在额外接收 evidenceIds / verification
    // 参数（兼容可选）；这里用 toMatchObject 而非 toHaveBeenCalledWith——避免新增 evidenceIds 空数组
    // 之类参数触发误报。
    expect(mocks.completeCurrentWorkflowNode).toHaveBeenCalledWith(
      expect.objectContaining({
        snapshot: workflowSnapshot,
        summary: "final answer",
      }),
    );
    expect(mocks.failCurrentWorkflowNode).not.toHaveBeenCalled();
    expect(mocks.saveSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      runId: "run-1",
      snapshot: nextWorkflow,
      eventType: "workflow.node_completed",
    }));
    expect(applyWorkflowSnapshot).toHaveBeenCalledWith(nextWorkflow);
  });

  it("2026-07-16：后台验收落地前用户已切到别的会话 → 不覆盖全局 workflowSnapshot，但仍落库", async () => {
    const nextWorkflow = { runId: "run-1", currentNodeId: null };
    mocks.completeCurrentWorkflowNode.mockReturnValue(nextWorkflow);
    const applyWorkflowSnapshot = vi.fn();
    const workflowSnapshot = makeSnapshot("plan");
    // 模拟"发起这轮验收时是 conv-1，验收后台跑的这段时间里用户已经切到 conv-2"——
    // conversationIdRef 是活体引用，跟 conversationId 这个闭包值不同步是这个 bug 的关键。
    const conversationIdRef = { current: "conv-1" };

    const pending = finalizeStreamedChatTurn({
      text: "hello",
      assistantMessage: { id: "assistant-1", role: "assistant", content: "" },
      assistantId: "assistant-1",
      streamingResult: {
        fullContent: "final answer",
        lastModelId: "model-1",
        lastResultModelId: "model-result",
        lastUsage: undefined,
        lastToolCallCount: 0,
        harnessDirty: false,
      },
      conversationId: "conv-1",
      conversationIdRef,
      cacheEligible: false,
      taskRole: "standard",
      shouldCompleteWorkflowNode: true,
      workflowSnapshot,
      workflowRunId: "run-1",
      controllerAborted: false,
      persistAssistant: vi.fn(),
      setMessages: vi.fn((updater) => updater([])),
      applyWorkflowSnapshot,
    });

    // finalizeStreamedChatTurn 本身很快 resolve（不等后台验收）——这里模拟用户在它
    // resolve 之后、后台验收还没跑完之前，切到了另一个会话。
    await pending;
    conversationIdRef.current = "conv-2";

    // 等后台验收（fire-and-forget）真正落地。
    await vi.waitFor(() => expect(mocks.saveSnapshot).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));

    // DB 落库记录的是 conv-1 这个 workflow run 自己的真实结果，跟用户当前在看哪个会话
    // 无关，应该照常写。
    expect(mocks.saveSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      runId: "run-1",
      snapshot: nextWorkflow,
      eventType: "workflow.node_completed",
    }));
    // 但全局 UI 状态不能被 conv-1 跑完的验收结果覆盖——用户已经在看 conv-2 了。
    expect(applyWorkflowSnapshot).not.toHaveBeenCalled();
  });

  it("Harness 工程实施计划阶段1：execute 阶段 0 工具调用 → 验收不通过，不完成节点而是标 failed", async () => {
    const failedWorkflow = { runId: "run-1", currentNodeId: "node-1" };
    mocks.failCurrentWorkflowNode.mockReturnValue(failedWorkflow);
    const applyWorkflowSnapshot = vi.fn();
    const workflowSnapshot = makeSnapshot("execute");

    await finalizeStreamedChatTurn({
      text: "hello",
      assistantMessage: { id: "assistant-1", role: "assistant", content: "" },
      assistantId: "assistant-1",
      streamingResult: {
        fullContent: "我已经把文件改好了",
        lastModelId: "model-1",
        lastToolCallCount: 0,
        harnessDirty: false,
      },
      conversationId: "conv-1",
      conversationIdRef: { current: "conv-1" },
      cacheEligible: false,
      taskRole: "standard",
      shouldCompleteWorkflowNode: true,
      workflowSnapshot,
      workflowRunId: "run-1",
      controllerAborted: false,
      persistAssistant: vi.fn(),
      setMessages: vi.fn((updater) => updater([])),
      applyWorkflowSnapshot,
    });

    await vi.waitFor(() => expect(applyWorkflowSnapshot).toHaveBeenCalled());
    expect(mocks.completeCurrentWorkflowNode).not.toHaveBeenCalled();
    expect(mocks.failCurrentWorkflowNode).toHaveBeenCalledWith(
      expect.objectContaining({
        snapshot: workflowSnapshot,
        outcome: expect.objectContaining({ status: "failed", failureCode: "no_tool_evidence" }),
      }),
    );
    expect(mocks.saveSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      runId: "run-1",
      snapshot: failedWorkflow,
      eventType: "workflow.node_failed_verification",
    }));
    expect(applyWorkflowSnapshot).toHaveBeenCalledWith(failedWorkflow);
  });

  it("Harness 判定编造（harnessDirty=true）→ 即使有工具调用也不完成节点", async () => {
    const workflowSnapshot = makeSnapshot("execute");

    await finalizeStreamedChatTurn({
      text: "hello",
      assistantMessage: { id: "assistant-1", role: "assistant", content: "" },
      assistantId: "assistant-1",
      streamingResult: {
        fullContent: "final answer",
        lastModelId: "model-1",
        lastToolCallCount: 3,
        harnessDirty: true,
      },
      conversationId: "conv-1",
      conversationIdRef: { current: "conv-1" },
      cacheEligible: false,
      taskRole: "standard",
      shouldCompleteWorkflowNode: true,
      workflowSnapshot,
      workflowRunId: "run-1",
      controllerAborted: false,
      persistAssistant: vi.fn(),
      setMessages: vi.fn((updater) => updater([])),
      applyWorkflowSnapshot: vi.fn(),
    });

    await vi.waitFor(() => expect(mocks.failCurrentWorkflowNode).toHaveBeenCalled());
    expect(mocks.completeCurrentWorkflowNode).not.toHaveBeenCalled();
    expect(mocks.failCurrentWorkflowNode).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: expect.objectContaining({ failureCode: "harness_dirty" }) }),
    );
  });

  it("Harness 工程实施计划阶段1：verify 阶段 0 工具证据 + 未达修复上限 → retryable，打回 execute 而不是锁死失败", async () => {
    const repairedWorkflow = { runId: "run-1", currentNodeId: "execute" };
    mocks.repairCurrentWorkflowNode.mockReturnValue(repairedWorkflow);
    const applyWorkflowSnapshot = vi.fn();
    const workflowSnapshot = makeSnapshot("verify", { repairAttempts: 0 });

    await finalizeStreamedChatTurn({
      text: "hello",
      assistantMessage: { id: "assistant-1", role: "assistant", content: "" },
      assistantId: "assistant-1",
      streamingResult: {
        fullContent: "测试跑完了",
        lastModelId: "model-1",
        lastToolCallCount: 0,
        harnessDirty: false,
      },
      conversationId: "conv-1",
      conversationIdRef: { current: "conv-1" },
      cacheEligible: false,
      taskRole: "standard",
      shouldCompleteWorkflowNode: true,
      workflowSnapshot,
      workflowRunId: "run-1",
      controllerAborted: false,
      persistAssistant: vi.fn(),
      setMessages: vi.fn((updater) => updater([])),
      applyWorkflowSnapshot,
    });

    await vi.waitFor(() => expect(applyWorkflowSnapshot).toHaveBeenCalled());
    expect(mocks.completeCurrentWorkflowNode).not.toHaveBeenCalled();
    expect(mocks.failCurrentWorkflowNode).not.toHaveBeenCalled();
    expect(mocks.repairCurrentWorkflowNode).toHaveBeenCalledWith(
      expect.objectContaining({
        snapshot: workflowSnapshot,
        outcome: expect.objectContaining({ status: "retryable", failureCode: "no_tool_evidence" }),
      }),
    );
    expect(mocks.saveSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      runId: "run-1",
      snapshot: repairedWorkflow,
      eventType: "workflow.node_repair_retry",
    }));
    expect(applyWorkflowSnapshot).toHaveBeenCalledWith(repairedWorkflow);
  });

  it("Harness 工程实施计划阶段1：verify 已修复到上限（repairAttempts=2）→ blocked，锁死等人工介入", async () => {
    const blockedWorkflow = { runId: "run-1", currentNodeId: "node-1" };
    mocks.failCurrentWorkflowNode.mockReturnValue(blockedWorkflow);
    const applyWorkflowSnapshot = vi.fn();
    const workflowSnapshot = makeSnapshot("verify", { repairAttempts: 2 });

    await finalizeStreamedChatTurn({
      text: "hello",
      assistantMessage: { id: "assistant-1", role: "assistant", content: "" },
      assistantId: "assistant-1",
      streamingResult: {
        fullContent: "又跑了一次",
        lastModelId: "model-1",
        lastToolCallCount: 0,
        harnessDirty: false,
      },
      conversationId: "conv-1",
      conversationIdRef: { current: "conv-1" },
      cacheEligible: false,
      taskRole: "standard",
      shouldCompleteWorkflowNode: true,
      workflowSnapshot,
      workflowRunId: "run-1",
      controllerAborted: false,
      persistAssistant: vi.fn(),
      setMessages: vi.fn((updater) => updater([])),
      applyWorkflowSnapshot,
    });

    await vi.waitFor(() => expect(applyWorkflowSnapshot).toHaveBeenCalled());
    expect(mocks.repairCurrentWorkflowNode).not.toHaveBeenCalled();
    expect(mocks.failCurrentWorkflowNode).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: expect.objectContaining({ status: "blocked" }) }),
    );
    expect(mocks.saveSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      runId: "run-1",
      snapshot: blockedWorkflow,
      eventType: "workflow.node_blocked",
    }));
    expect(applyWorkflowSnapshot).toHaveBeenCalledWith(blockedWorkflow);
  });

  it("Harness 工程实施计划阶段1：本轮有工具被用户拒绝（denied）→ needs_user，节点原样不动", async () => {
    mocks.listByMessage.mockResolvedValue([{ id: "te-1", status: "denied" }]);
    const applyWorkflowSnapshot = vi.fn();
    const workflowSnapshot = makeSnapshot("execute");

    await finalizeStreamedChatTurn({
      text: "hello",
      assistantMessage: { id: "assistant-1", role: "assistant", content: "" },
      assistantId: "assistant-1",
      streamingResult: {
        fullContent: "我需要写文件但你拒绝了",
        lastModelId: "model-1",
        lastToolCallCount: 0,
        harnessDirty: false,
      },
      conversationId: "conv-1",
      conversationIdRef: { current: "conv-1" },
      cacheEligible: false,
      taskRole: "standard",
      shouldCompleteWorkflowNode: true,
      workflowSnapshot,
      workflowRunId: "run-1",
      controllerAborted: false,
      persistAssistant: vi.fn(),
      setMessages: vi.fn((updater) => updater([])),
      applyWorkflowSnapshot,
    });

    // needs_user 分支不调用任何一个"完成/失败/重试"reducer，没有可以正向 waitFor 的信号——
    // 用宏任务 tick 让 fire-and-forget 后台任务里已经排队的微任务（listByMessage 的
    // .then 链）跑完，再确认后续分支确实什么都没做。
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.listByMessage).toHaveBeenCalledWith("assistant-1");
    expect(mocks.completeCurrentWorkflowNode).not.toHaveBeenCalled();
    expect(mocks.failCurrentWorkflowNode).not.toHaveBeenCalled();
    expect(mocks.repairCurrentWorkflowNode).not.toHaveBeenCalled();
    expect(mocks.saveSnapshot).not.toHaveBeenCalled();
    expect(applyWorkflowSnapshot).not.toHaveBeenCalled();
  });

  describe("2026-07-14：verify 阶段真实判定接入——按 phase 传对 acceptanceCriteria", () => {
    it("verify 阶段 → verifyTask 收到 VERIFY_ACCEPTANCE_CRITERIA", async () => {
      const workflowSnapshot = makeSnapshot("verify");

      await finalizeStreamedChatTurn({
        text: "hello",
        assistantMessage: { id: "assistant-1", role: "assistant", content: "" },
        assistantId: "assistant-1",
        streamingResult: {
          fullContent: "8 项测试全部通过",
          lastModelId: "model-1",
          lastToolCallCount: 1,
          harnessDirty: false,
        },
        conversationId: "conv-1",
        conversationIdRef: { current: "conv-1" },
        cacheEligible: false,
        taskRole: "standard",
        shouldCompleteWorkflowNode: true,
        workflowSnapshot,
        workflowRunId: "run-1",
        controllerAborted: false,
        persistAssistant: vi.fn(),
        setMessages: vi.fn((updater) => updater([])),
        applyWorkflowSnapshot: vi.fn(),
      });

      await vi.waitFor(() => expect(mocks.verifyTask).toHaveBeenCalled());
      expect(mocks.verifyTask).toHaveBeenCalledWith(
        expect.objectContaining({ acceptanceCriteria: VERIFY_ACCEPTANCE_CRITERIA }),
      );
    });

    it("execute 阶段 → verifyTask 收到空数组（不受 verify 判定标准影响）", async () => {
      const workflowSnapshot = makeSnapshot("execute");

      await finalizeStreamedChatTurn({
        text: "hello",
        assistantMessage: { id: "assistant-1", role: "assistant", content: "" },
        assistantId: "assistant-1",
        streamingResult: {
          fullContent: "已经改完代码了",
          lastModelId: "model-1",
          lastToolCallCount: 1,
          harnessDirty: false,
        },
        conversationId: "conv-1",
        conversationIdRef: { current: "conv-1" },
        cacheEligible: false,
        taskRole: "standard",
        shouldCompleteWorkflowNode: true,
        workflowSnapshot,
        workflowRunId: "run-1",
        controllerAborted: false,
        persistAssistant: vi.fn(),
        setMessages: vi.fn((updater) => updater([])),
        applyWorkflowSnapshot: vi.fn(),
      });

      await vi.waitFor(() => expect(mocks.verifyTask).toHaveBeenCalled());
      expect(mocks.verifyTask).toHaveBeenCalledWith(
        expect.objectContaining({ acceptanceCriteria: [] }),
      );
    });
  });

  describe("2026-07-14：真门控——verify 阶段细对账 fails 时真的打回/锁死，不再只是展示文字", () => {
    it("verification.status='fails' + repairAttempts 未到上限 → 打回 execute（retryable），不完成节点", async () => {
      mocks.verifyTask.mockReturnValue({
        status: "fails",
        metCriteria: [],
        failedCriteria: ["lint_pass"],
        linkedClaims: [],
        conflicts: [],
        decidedAt: "2026-07-14T00:00:00.000Z",
        decisionEvidenceIds: [],
        humanSummary: "未满足验收：ESLint 无 error。",
      });
      const workflowSnapshot = makeSnapshot("verify", { repairAttempts: 0 });

      await finalizeStreamedChatTurn({
        text: "hello",
        assistantMessage: { id: "assistant-1", role: "assistant", content: "" },
        assistantId: "assistant-1",
        streamingResult: {
          fullContent: "8 项测试全部通过，lint 也过了",
          lastModelId: "model-1",
          lastToolCallCount: 1,
          harnessDirty: false,
        },
        conversationId: "conv-1",
        conversationIdRef: { current: "conv-1" },
        cacheEligible: false,
        taskRole: "standard",
        shouldCompleteWorkflowNode: true,
        workflowSnapshot,
        workflowRunId: "run-1",
        controllerAborted: false,
        persistAssistant: vi.fn(),
        setMessages: vi.fn((updater) => updater([])),
        applyWorkflowSnapshot: vi.fn(),
      });

      await vi.waitFor(() => expect(mocks.repairCurrentWorkflowNode).toHaveBeenCalled());
      expect(mocks.completeCurrentWorkflowNode).not.toHaveBeenCalled();
      expect(mocks.repairCurrentWorkflowNode).toHaveBeenCalledWith(
        expect.objectContaining({
          snapshot: workflowSnapshot,
          outcome: expect.objectContaining({
            status: "retryable",
            failureCode: "acceptance_criteria_failed",
          }),
        }),
      );
      expect(mocks.saveSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: "workflow.node_repair_retry" }),
      );
    });

    it("verification.status='fails' + repairAttempts 已到上限（2）→ blocked，锁死等人工介入", async () => {
      mocks.verifyTask.mockReturnValue({
        status: "fails",
        metCriteria: [],
        failedCriteria: ["lint_pass"],
        linkedClaims: [],
        conflicts: [],
        decidedAt: "2026-07-14T00:00:00.000Z",
        decisionEvidenceIds: [],
        humanSummary: "未满足验收：ESLint 无 error。",
      });
      const workflowSnapshot = makeSnapshot("verify", { repairAttempts: 2 });

      await finalizeStreamedChatTurn({
        text: "hello",
        assistantMessage: { id: "assistant-1", role: "assistant", content: "" },
        assistantId: "assistant-1",
        streamingResult: {
          fullContent: "8 项测试全部通过",
          lastModelId: "model-1",
          lastToolCallCount: 1,
          harnessDirty: false,
        },
        conversationId: "conv-1",
        conversationIdRef: { current: "conv-1" },
        cacheEligible: false,
        taskRole: "standard",
        shouldCompleteWorkflowNode: true,
        workflowSnapshot,
        workflowRunId: "run-1",
        controllerAborted: false,
        persistAssistant: vi.fn(),
        setMessages: vi.fn((updater) => updater([])),
        applyWorkflowSnapshot: vi.fn(),
      });

      await vi.waitFor(() => expect(mocks.failCurrentWorkflowNode).toHaveBeenCalled());
      expect(mocks.completeCurrentWorkflowNode).not.toHaveBeenCalled();
      expect(mocks.repairCurrentWorkflowNode).not.toHaveBeenCalled();
      expect(mocks.failCurrentWorkflowNode).toHaveBeenCalledWith(
        expect.objectContaining({
          snapshot: workflowSnapshot,
          outcome: expect.objectContaining({
            status: "blocked",
            failureCode: "acceptance_criteria_failed",
          }),
        }),
      );
      expect(mocks.saveSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: "workflow.node_blocked" }),
      );
    });

    it("verification.status='inconclusive'（证据看不清）→ 不触发降级，仍正常完成节点", async () => {
      mocks.verifyTask.mockReturnValue({
        status: "inconclusive",
        metCriteria: [],
        failedCriteria: [],
        linkedClaims: [],
        conflicts: [],
        decidedAt: "2026-07-14T00:00:00.000Z",
        decisionEvidenceIds: [],
        humanSummary: "证据不充分，需要人工复核。",
      });
      const workflowSnapshot = makeSnapshot("verify", { repairAttempts: 0 });

      await finalizeStreamedChatTurn({
        text: "hello",
        assistantMessage: { id: "assistant-1", role: "assistant", content: "" },
        assistantId: "assistant-1",
        streamingResult: {
          fullContent: "已经验证过了",
          lastModelId: "model-1",
          lastToolCallCount: 1,
          harnessDirty: false,
        },
        conversationId: "conv-1",
        conversationIdRef: { current: "conv-1" },
        cacheEligible: false,
        taskRole: "standard",
        shouldCompleteWorkflowNode: true,
        workflowSnapshot,
        workflowRunId: "run-1",
        controllerAborted: false,
        persistAssistant: vi.fn(),
        setMessages: vi.fn((updater) => updater([])),
        applyWorkflowSnapshot: vi.fn(),
      });

      await vi.waitFor(() => expect(mocks.completeCurrentWorkflowNode).toHaveBeenCalled());
      expect(mocks.repairCurrentWorkflowNode).not.toHaveBeenCalled();
      expect(mocks.failCurrentWorkflowNode).not.toHaveBeenCalled();
      expect(mocks.completeCurrentWorkflowNode).toHaveBeenCalled();
    });

    it("非 verify 阶段（execute）即使 verifyTask 返回 fails，也不触发降级（防御性范围校验）", async () => {
      mocks.verifyTask.mockReturnValue({
        status: "fails",
        metCriteria: [],
        failedCriteria: ["lint_pass"],
        linkedClaims: [],
        conflicts: [],
        decidedAt: "2026-07-14T00:00:00.000Z",
        decisionEvidenceIds: [],
        humanSummary: "未满足验收：ESLint 无 error。",
      });
      const workflowSnapshot = makeSnapshot("execute", { repairAttempts: 0 });

      await finalizeStreamedChatTurn({
        text: "hello",
        assistantMessage: { id: "assistant-1", role: "assistant", content: "" },
        assistantId: "assistant-1",
        streamingResult: {
          fullContent: "已经改完代码了",
          lastModelId: "model-1",
          lastToolCallCount: 1,
          harnessDirty: false,
        },
        conversationId: "conv-1",
        conversationIdRef: { current: "conv-1" },
        cacheEligible: false,
        taskRole: "standard",
        shouldCompleteWorkflowNode: true,
        workflowSnapshot,
        workflowRunId: "run-1",
        controllerAborted: false,
        persistAssistant: vi.fn(),
        setMessages: vi.fn((updater) => updater([])),
        applyWorkflowSnapshot: vi.fn(),
      });

      await vi.waitFor(() => expect(mocks.completeCurrentWorkflowNode).toHaveBeenCalled());
      expect(mocks.repairCurrentWorkflowNode).not.toHaveBeenCalled();
      expect(mocks.failCurrentWorkflowNode).not.toHaveBeenCalled();
      expect(mocks.completeCurrentWorkflowNode).toHaveBeenCalled();
    });
  });
});
