import { beforeEach, describe, expect, it, vi } from "vitest";
import { finalizeStreamedChatTurn } from "@/pages/chat/stream-finalization";
import { VERIFY_ACCEPTANCE_CRITERIA } from "@/lib/llm/evidence/verify-acceptance-criteria";
import type { ChatMessage } from "@/pages/chat/types";

const mocks = vi.hoisted(() => ({
  writeCache: vi.fn(),
  saveSnapshot: vi.fn(),
  listByMessage: vi.fn(),
  listByConversation: vi.fn(),
  completeCurrentWorkflowNode: vi.fn(),
  failCurrentWorkflowNode: vi.fn(),
  repairCurrentWorkflowNode: vi.fn(),
  verifyTask: vi.fn(),
  recordPlaybookEventSafe: vi.fn(),
  runPlaybookPipeline: vi.fn(),
}));

vi.mock("@/lib/llm/semantic-cache", () => ({
  writeCache: mocks.writeCache,
}));

vi.mock("@/lib/db", () => ({
  workflowRuns: {
    saveSnapshot: mocks.saveSnapshot,
  },
  toolExecutions: {
    listByMessage: mocks.listByMessage,
    listByConversation: mocks.listByConversation,
  },
}));

// 工作流"实际动作可视化"阶段1（2026-07-18）：三个权威 reducer 沿用原来的窄 mock 不变
// （包括 markCurrentWorkflowNodeNeedsUser 等其它导出继续保持"未提供即 undefined"的原有
// 行为，不动其它用例已经依赖的既有语义——尤其 needs_user 分支那条用例）。只额外挂上真实的
// attachObservedActivity：它是这次要接线验证的对象本身，mock 掉就测不出"observed activity
// 真的被合并进保存的 snapshot"了。
vi.mock("@/lib/workflow/reducer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/workflow/reducer")>();
  return {
    attachObservedActivity: actual.attachObservedActivity,
    completeCurrentWorkflowNode: mocks.completeCurrentWorkflowNode,
    failCurrentWorkflowNode: mocks.failCurrentWorkflowNode,
    repairCurrentWorkflowNode: mocks.repairCurrentWorkflowNode,
  };
});

// 2026-07-14：verifyTask 单独 mock 掉——只关心 stream-finalization.ts 按 phase 传对了
// acceptanceCriteria（该不该传 VERIFY_ACCEPTANCE_CRITERIA），verifyTask 自身的判定逻辑
// 已经在 task-verifier.test.ts 里直接、完整地测过，这里不重复。
vi.mock("@/lib/llm/evidence/task-verifier", () => ({
  verifyTask: mocks.verifyTask,
}));

// 阶段5 Playbook：pipeline 单独 mock——只验证 stream-finalization 的触发条件
// （什么 outcome 写什么事件、事件先写后消费），管道内部逻辑在 pipeline.test.ts 直接测。
vi.mock("@/lib/llm/playbook/pipeline", () => ({
  recordPlaybookEventSafe: mocks.recordPlaybookEventSafe,
  runPlaybookPipeline: mocks.runPlaybookPipeline,
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
    mocks.saveSnapshot.mockReset().mockResolvedValue(undefined);
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
    mocks.recordPlaybookEventSafe.mockReset().mockResolvedValue(undefined);
    mocks.runPlaybookPipeline.mockReset().mockResolvedValue(null);
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
      projectId: null,
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
      // 结构化工具历史：本例 streamingResult 未带 responseMessages → parts 传 null（退化文本回放）
      null,
    );
    expect(mocks.writeCache).toHaveBeenCalledWith("hello", "final answer", "model-result", "standard");
    expect(setMessages.mock.results[0]?.value[0]).toMatchObject({ toolCallCount: 1 });
  });

  it("结构化工具历史：toolCallCount>0 且带 responseMessages → persistAssistant 收到 JSON 化的 parts", async () => {
    const setMessages = vi.fn((updater) => updater([{ id: "a-1", role: "assistant", content: "" } as ChatMessage]));
    const persistAssistant = vi.fn();
    const responseMessages = [
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "read", input: { file_path: "a.md" } }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName: "read", output: { type: "text", value: "内容" } }] },
      { role: "assistant", content: [{ type: "text", text: "读完了" }] },
    ];

    await finalizeStreamedChatTurn({
      text: "读 a.md",
      assistantMessage: { id: "a-1", role: "assistant", content: "" },
      assistantId: "a-1",
      streamingResult: {
        fullContent: "读完了",
        lastModelId: "model-1",
        lastToolCallCount: 1,
        harnessDirty: false,
        responseMessages: responseMessages as never,
      },
      conversationId: "conv-1",
      projectId: null,
      cacheEligible: false,
      taskRole: "standard",
      shouldCompleteWorkflowNode: false,
      workflowSnapshot: null,
      workflowRunId: null,
      controllerAborted: false,
      persistAssistant,
      setMessages,
      applyWorkflowSnapshot: vi.fn(),
    });

    const partsArg = persistAssistant.mock.calls[0]?.[5];
    expect(typeof partsArg).toBe("string");
    expect(JSON.parse(partsArg)).toEqual(responseMessages);
  });

  it("结构化工具历史：toolCallCount=0（纯问答轮）→ parts 传 null，不落结构", async () => {
    const setMessages = vi.fn((updater) => updater([{ id: "a-2", role: "assistant", content: "" } as ChatMessage]));
    const persistAssistant = vi.fn();

    await finalizeStreamedChatTurn({
      text: "你好",
      assistantMessage: { id: "a-2", role: "assistant", content: "" },
      assistantId: "a-2",
      streamingResult: {
        fullContent: "你好呀",
        lastModelId: "model-1",
        lastToolCallCount: 0,
        harnessDirty: false,
        responseMessages: [{ role: "assistant", content: [{ type: "text", text: "你好呀" }] }] as never,
      },
      conversationId: "conv-1",
      projectId: null,
      cacheEligible: false,
      taskRole: "standard",
      shouldCompleteWorkflowNode: false,
      workflowSnapshot: null,
      workflowRunId: null,
      controllerAborted: false,
      persistAssistant,
      setMessages,
      applyWorkflowSnapshot: vi.fn(),
    });

    expect(persistAssistant.mock.calls[0]?.[5]).toBeNull();
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
      projectId: null,
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
    // 工作流"实际动作可视化"阶段1（2026-07-18）：completeCurrentWorkflowNode 的 mock 返回值
    // （nextWorkflow）现在会被真实的 attachObservedActivity 包一层再保存——保存的快照不再
    // 跟 nextWorkflow 严格相等（多了 context.lastObservedActivity），用 objectContaining
    // 断言"原有字段都还在 + 新观测字段确实被写入"，而不是整体相等。
    expect(mocks.saveSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      runId: "run-1",
      snapshot: expect.objectContaining({
        runId: "run-1",
        currentNodeId: null,
        context: expect.objectContaining({
          lastObservedActivity: expect.objectContaining({ phases: [], dominant: null }),
        }),
      }),
      eventType: "workflow.node_completed",
    }));
    expect(applyWorkflowSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        currentNodeId: null,
        context: expect.objectContaining({
          lastObservedActivity: expect.objectContaining({ phases: [], dominant: null }),
        }),
      }),
    );
  });

  // 工作流"实际动作可视化"阶段1（2026-07-18）接线测试：验证 ①保存的快照带上了
  // lastObservedActivity（按本轮真实工具算出 read+write → dominant=execute）
  // ②completeCurrentWorkflowNode 返回值里的 currentNodeId/nodes（节点状态）原样透传，
  // 没有被 observed-activity 接线改动分毫。
  it("Step4 接线：保存的快照带上 lastObservedActivity，且 currentNode/node.status 不被改动", async () => {
    mocks.listByMessage.mockResolvedValue([
      { id: "te-1", toolName: "write", status: "success" },
      { id: "te-2", toolName: "read", status: "success" },
    ]);
    const completedNode = { id: "node-1", phase: "execute", status: "done" };
    const nextWorkflowFromComplete = {
      runId: "run-1",
      currentNodeId: null,
      nodes: [completedNode],
      context: { projectFacts: [], changedFiles: [], riskLevel: "low" },
    };
    mocks.completeCurrentWorkflowNode.mockReturnValue(nextWorkflowFromComplete);
    const applyWorkflowSnapshot = vi.fn();
    const workflowSnapshot = makeSnapshot("execute");

    await finalizeStreamedChatTurn({
      text: "hello",
      assistantMessage: { id: "assistant-1", role: "assistant", content: "" },
      assistantId: "assistant-1",
      streamingResult: {
        fullContent: "已经改完并读过相关文件",
        lastModelId: "model-1",
        lastToolCallCount: 2,
        harnessDirty: false,
      },
      conversationId: "conv-1",
      projectId: null,
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

    const savedSnapshot = mocks.saveSnapshot.mock.calls[0]![0].snapshot;
    expect(savedSnapshot.context.lastObservedActivity).toMatchObject({
      phases: ["read_project", "execute"],
      dominant: "execute",
    });
    expect(typeof savedSnapshot.context.lastObservedActivity.observedAt).toBe("string");
    // currentNode / node.status 完全来自 completeCurrentWorkflowNode 的返回值，原样透传，
    // 没有被 attachObservedActivity 篡改。
    expect(savedSnapshot.currentNodeId).toBe(nextWorkflowFromComplete.currentNodeId);
    expect(savedSnapshot.nodes).toEqual(nextWorkflowFromComplete.nodes);
    expect(applyWorkflowSnapshot).toHaveBeenCalledWith(savedSnapshot);
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
      projectId: null,
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
      projectId: null,
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
      projectId: null,
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
      projectId: null,
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
      projectId: null,
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
      projectId: null,
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
      projectId: null,
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
      projectId: null,
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
      projectId: null,
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
      projectId: null,
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
      projectId: null,
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

  // 阶段5 Playbook 接线点（2026-07-17）：验证触发条件与时序，管道内部逻辑在 pipeline.test.ts
  describe("playbook 事件接线", () => {
    function playbookArgs(over: Record<string, unknown> = {}) {
      return {
        text: "hello",
        assistantMessage: { id: "assistant-1", role: "assistant" as const, content: "" },
        assistantId: "assistant-1",
        streamingResult: {
          fullContent: "final answer",
          lastModelId: "model-1",
          lastToolCallCount: 0,
          harnessDirty: false,
        },
        conversationId: "conv-1",
        projectId: "p-1",
        cacheEligible: false,
        taskRole: "standard",
        shouldCompleteWorkflowNode: true,
        workflowSnapshot: makeSnapshot("execute"),
        workflowRunId: "run-1",
        controllerAborted: false,
        persistAssistant: vi.fn(),
        setMessages: vi.fn((updater) => updater([])),
        applyWorkflowSnapshot: vi.fn(),
        ...over,
      };
    }

    it("execute 阶段验收 failed → 写 outcome_failed 事件（先于 pipeline）再消费", async () => {
      // execute 阶段 0 工具调用 → verifyNodeOutcome 判 failed（no_tool_evidence）
      await finalizeStreamedChatTurn(playbookArgs());
      await vi.waitFor(() => expect(mocks.runPlaybookPipeline).toHaveBeenCalled());
      expect(mocks.recordPlaybookEventSafe).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: "p-1",
          conversationId: "conv-1",
          kind: "outcome_failed",
        }),
      );
      // 时序：事件写入调用发生在 pipeline 消费之前
      const eventOrder = mocks.recordPlaybookEventSafe.mock.invocationCallOrder[0]!;
      const pipelineOrder = mocks.runPlaybookPipeline.mock.invocationCallOrder[0]!;
      expect(eventOrder).toBeLessThan(pipelineOrder);
      expect(mocks.runPlaybookPipeline).toHaveBeenCalledWith({ projectId: "p-1", conversationId: "conv-1" });
    });

    it("passed 路径不写 outcome 事件，但仍跑 pipeline（消费 summary_dropped 等旁路事件）", async () => {
      await finalizeStreamedChatTurn(
        playbookArgs({ workflowSnapshot: makeSnapshot("plan") }),  // plan 阶段 0 工具也 passed
      );
      await vi.waitFor(() => expect(mocks.runPlaybookPipeline).toHaveBeenCalled());
      expect(mocks.recordPlaybookEventSafe).not.toHaveBeenCalled();
    });

    it("projectId=null → 事件与 pipeline 都不触发", async () => {
      await finalizeStreamedChatTurn(playbookArgs({ projectId: null }));
      await vi.waitFor(() => expect(mocks.failCurrentWorkflowNode).toHaveBeenCalled());
      expect(mocks.recordPlaybookEventSafe).not.toHaveBeenCalled();
      expect(mocks.runPlaybookPipeline).not.toHaveBeenCalled();
    });

    it("2026-07-17 复检 MEDIUM 修复：pipeline settle 后调 onPlaybookMemoryChange 通知 UI refetch（不用等下一轮对话）", async () => {
      const onPlaybookMemoryChange = vi.fn();
      mocks.runPlaybookPipeline.mockResolvedValue({ created: 1, candidates: 0, superseded: 0, disputed: 0, archived: 0, skipped: 0 });
      await finalizeStreamedChatTurn(playbookArgs({ onPlaybookMemoryChange }));
      await vi.waitFor(() => expect(onPlaybookMemoryChange).toHaveBeenCalled());
    });

    it("pipeline 失败也要调 onPlaybookMemoryChange（.finally 语义，不管成败都该有机会 refetch 纠正状态）", async () => {
      const onPlaybookMemoryChange = vi.fn();
      mocks.runPlaybookPipeline.mockRejectedValue(new Error("db locked"));
      await finalizeStreamedChatTurn(playbookArgs({ onPlaybookMemoryChange }));
      await vi.waitFor(() => expect(onPlaybookMemoryChange).toHaveBeenCalled());
    });

    it("不传 onPlaybookMemoryChange 不报错（可选回调，测试/无 UI 场景兼容）", async () => {
      await expect(finalizeStreamedChatTurn(playbookArgs())).resolves.toBeDefined();
    });
  });
});
