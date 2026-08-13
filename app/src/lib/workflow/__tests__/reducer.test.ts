import { describe, expect, it } from "vitest";
import { createCodeTaskWorkflowSnapshot } from "../code-task-template";
import {
  applyNextActionChoice,
  applyTurnIntentDecision,
  attachActiveSkillToWorkflow,
  attachObservedActivity,
  completeCurrentWorkflowNode,
  failCurrentWorkflowNode,
  markCurrentWorkflowNodeNeedsUser,
  repairCurrentWorkflowNode,
} from "../reducer";
import type { NodeOutcome } from "../node-outcome";
import type { TurnIntentDecision } from "../types";

function snapshot() {
  return createCodeTaskWorkflowSnapshot({
    runId: "run-1",
    conversationId: "conv-1",
    objective: "完善项目",
    workspacePath: "/tmp/project",
  });
}

const decision = (partial: Partial<TurnIntentDecision>): TurnIntentDecision => ({
  action: "continue_run",
  targetRunId: "run-1",
  confidence: 0.9,
  reason: "test",
  evidenceTurnIds: [],
  ...partial,
});

describe("workflow reducer", () => {
  it("完成当前节点后进入 waiting_user 并生成下一步候选", () => {
    const next = completeCurrentWorkflowNode({ snapshot: snapshot(), summary: "项目摘要" });
    expect(next.status).toBe("waiting_user");
    expect(next.nodes.find((n) => n.id === "read_project")?.status).toBe("done");
    expect(next.nextActions.map((a) => a.id)).toEqual(["make_plan"]);
  });

  // 2026-07-15 review 修复回归测试：verify 是管线终点阶段，defaultNextActionsForPhase("verify")
  // 返回空数组。旧实现不管这个直接把 status 设成 "waiting_user"，而 WorkflowRunStatus 从来没有
  // 任何路径转成 "completed"、getActiveByConversation 又把 waiting_user 当"活跃"复用——
  // 任务真正做完一次之后，同一对话会永久卡在 verify 阶段的只读工具门控里，往后所有写文件
  // 请求都被静默拒绝。修复后 verify 完成应该真正落到终态 "completed"。
  it("完成 verify 节点（管线终点，无下一步）后应转入真正的终态 completed，不是 waiting_user", () => {
    const verifying = { ...snapshot(), currentNodeId: "verify" };
    const next = completeCurrentWorkflowNode({ snapshot: verifying, summary: "验证通过" });

    expect(next.status).toBe("completed");
    expect(next.nodes.find((n) => n.id === "verify")?.status).toBe("done");
    expect(next.nextActions).toEqual([]);
    expect(next.pendingDecision).toBeUndefined();
  });

  // 2026-07-15 review 复检发现的遗漏（跟上面 completeCurrentWorkflowNode 是同一类 bug）：
  // failCurrentWorkflowNode 只在 outcome.status 为 "failed"/"blocked" 这两个明确终态
  // 判定时才会被调用（不会再自动重试），旧实现却仍然把 run 状态设成 "waiting_user"，
  // getActiveByConversation 把它当"活跃"复用，导致一次判死的任务永久锁死同一对话后续所有
  // 写文件请求——跟"成功走完 verify 却卡住"是完全一样的症状，只是触发条件是失败而不是成功。
  it("verify 节点判定为终态失败（blocked）后应转入 failed 终态，不是 waiting_user", () => {
    const verifying = { ...snapshot(), currentNodeId: "verify" };
    const outcome: NodeOutcome = {
      status: "blocked",
      summary: "连续 3 次修复仍未通过验证",
      evidenceIds: [],
      artifactIds: [],
      toolExecutionIds: [],
      failureCode: "acceptance_criteria_failed",
    };

    const next = failCurrentWorkflowNode({ snapshot: verifying, outcome });

    expect(next.status).toBe("failed");
    expect(next.nodes.find((n) => n.id === "verify")?.status).toBe("failed");
    expect(next.nextActions).toEqual([]);
    expect(next.pendingDecision).toBeUndefined();
  });

  it("任意阶段判定为直接失败（failed）后也应转入 failed 终态，不是 waiting_user", () => {
    const planning = { ...snapshot(), currentNodeId: "plan" };
    const outcome: NodeOutcome = {
      status: "failed",
      summary: "本轮没有产出任何回答内容。",
      evidenceIds: [],
      artifactIds: [],
      toolExecutionIds: [],
      failureCode: "empty_output",
    };

    const next = failCurrentWorkflowNode({ snapshot: planning, outcome });

    expect(next.status).toBe("failed");
    expect(next.nodes.find((n) => n.id === "plan")?.status).toBe("failed");
  });

  it("完成 plan 节点时把方案摘要和来源沉淀到 workflow context", () => {
    const ready = applyTurnIntentDecision({
      snapshot: completeCurrentWorkflowNode({ snapshot: snapshot(), summary: "项目摘要" }),
      decision: decision({ action: "continue_run" }),
    });
    const next = completeCurrentWorkflowNode({ snapshot: ready, summary: "Phase 1 先收口工作流" });

    expect(next.nodes.find((n) => n.id === "plan")?.status).toBe("done");
    expect(next.context.planSummary).toBe("Phase 1 先收口工作流");
    expect(next.context.planSource?.kind).toBe("message");
    expect(next.context.planSource?.ref).toBe("workflow:run-1:plan");
    expect(next.context.planSource?.summary).toBe("Phase 1 先收口工作流");
    expect(next.context.planSource?.phase).toBe("plan");
  });

  it("完成 debate 节点时把降级或完整方案作为后续执行来源", () => {
    const ready = applyTurnIntentDecision({
      snapshot: snapshot(),
      decision: decision({ patch: { debateRequested: true } }),
    });
    const next = completeCurrentWorkflowNode({
      snapshot: ready,
      summary: "降级方案正文",
      planSource: {
        kind: "degraded_debate",
        ref: "debate:session-1",
        summary: "降级方案正文",
        phase: "debate",
        boundAt: "2026-07-07T00:00:00.000Z",
        label: "多模型博弈未完成后的降级方案",
      },
    });

    expect(next.context.debateSummary).toBe("降级方案正文");
    expect(next.context.planSummary).toBe("降级方案正文");
    expect(next.context.planSource?.kind).toBe("degraded_debate");
    expect(next.context.planSource?.ref).toBe("debate:session-1");
  });

  // 2026-07-15 二次修复的回归测试：verify 终态修复的第一版实现用"nextActions 是否为空"
  // 判定管线终点，但 review/debate 阶段的 defaultNextActionsForPhase 也落进同一个空数组
  // 默认分支——它们是从 plan 分出去的旁支，不是管线终点，完成后应该保持 run 可被继续
  // （用户接下来说"那就执行吧"要能推进到 execute，靠的是 run 还在 getActiveByConversation
  // 能捞到的活跃状态里）。如果被错误标成 "completed"，debate/review 产出的方案会被无声丢弃。
  it("完成 debate 节点（非管线终点，是 plan 的旁支）后 run 应保持 waiting_user，不能被标成 completed", () => {
    const ready = applyTurnIntentDecision({
      snapshot: snapshot(),
      decision: decision({ patch: { debateRequested: true } }),
    });
    const next = completeCurrentWorkflowNode({
      snapshot: ready,
      summary: "降级方案正文",
      planSource: {
        kind: "degraded_debate",
        ref: "debate:session-1",
        summary: "降级方案正文",
        phase: "debate",
        boundAt: "2026-07-07T00:00:00.000Z",
        label: "多模型博弈未完成后的降级方案",
      },
    });

    expect(next.status).toBe("waiting_user");
  });

  it("完成 review 节点（非管线终点，是 plan 的旁支）后 run 应保持 waiting_user，不能被标成 completed", () => {
    const ready = applyTurnIntentDecision({
      snapshot: snapshot(),
      decision: decision({ patch: { reviewRequested: true } }),
    });
    const next = completeCurrentWorkflowNode({ snapshot: ready, summary: "评审意见" });

    expect(next.status).toBe("waiting_user");
  });

  it("可以把当前启用的 Skill 沉淀到 workflow context", () => {
    const next = attachActiveSkillToWorkflow({
      snapshot: snapshot(),
      skill: {
        id: "plan_execution",
        label: "按方案执行",
        selectedAt: "2026-07-07T00:00:00.000Z",
        reason: "execution mode execute_directly",
      },
    });

    expect(next.context.activeSkill).toMatchObject({
      id: "plan_execution",
      label: "按方案执行",
      reason: "execution mode execute_directly",
    });
  });

  it("approve_node 进入 execute 节点", () => {
    const next = applyTurnIntentDecision({
      snapshot: snapshot(),
      decision: decision({ action: "approve_node", patch: { executionMode: "execute_directly" } }),
    });
    expect(next.status).toBe("running");
    expect(next.currentNodeId).toBe("execute");
    expect(next.nodes.find((n) => n.id === "execute")?.status).toBe("ready");
  });

  it("执行意图会清掉旧的 review/debate 请求，避免再次进入博弈", () => {
    const previous = {
      ...snapshot(),
      intent: {
        ...snapshot().intent,
        reviewRequested: true,
        debateRequested: true,
      },
    };
    const next = applyTurnIntentDecision({
      snapshot: previous,
      decision: decision({
        action: "approve_node",
        patch: { executionMode: "execute_directly", reviewRequested: false, debateRequested: false },
      }),
    });

    expect(next.currentNodeId).toBe("execute");
    expect(next.intent.reviewRequested).toBe(false);
    expect(next.intent.debateRequested).toBe(false);
  });

  it("review/debate patch 分别进入对应可选节点", () => {
    expect(applyTurnIntentDecision({
      snapshot: snapshot(),
      decision: decision({ patch: { reviewRequested: true } }),
    }).currentNodeId).toBe("review");

    expect(applyTurnIntentDecision({
      snapshot: snapshot(),
      decision: decision({ patch: { debateRequested: true } }),
    }).currentNodeId).toBe("debate");
  });

  it("Harness 工程实施计划阶段1：repairCurrentWorkflowNode 把 verify 打回 execute 并计数 +1", () => {
    const verifying = { ...snapshot(), currentNodeId: "verify" };
    const outcome: NodeOutcome = {
      status: "retryable",
      summary: "0 工具证据",
      evidenceIds: [],
      artifactIds: [],
      toolExecutionIds: [],
      failureCode: "no_tool_evidence",
    };

    const next = repairCurrentWorkflowNode({ snapshot: verifying, outcome });

    expect(next.currentNodeId).toBe("execute");
    expect(next.status).toBe("running");
    expect(next.nodes.find((n) => n.id === "verify")?.status).toBe("pending");
    expect(next.nodes.find((n) => n.id === "verify")?.repairAttempts).toBe(1);
    expect(next.nodes.find((n) => n.id === "execute")?.status).toBe("ready");
  });

  it("repairCurrentWorkflowNode 在已有 repairAttempts 基础上继续累加", () => {
    const verifying = {
      ...snapshot(),
      currentNodeId: "verify",
      nodes: snapshot().nodes.map((n) => (n.id === "verify" ? { ...n, repairAttempts: 1 } : n)),
    };
    const outcome: NodeOutcome = {
      status: "retryable",
      summary: "再次没证据",
      evidenceIds: [],
      artifactIds: [],
      toolExecutionIds: [],
    };

    const next = repairCurrentWorkflowNode({ snapshot: verifying, outcome });

    expect(next.nodes.find((n) => n.id === "verify")?.repairAttempts).toBe(2);
  });

  it("2026-07-14：repairCurrentWorkflowNode 把 outcome 的 evidenceIds/artifactIds/toolExecutionIds 透传进 node.outputs（跟 completeCurrentWorkflowNode/failCurrentWorkflowNode 对齐，此前只写 summary，重试期间的具体证据会被丢掉）", () => {
    const verifying = { ...snapshot(), currentNodeId: "verify" };
    const outcome: NodeOutcome = {
      status: "retryable",
      summary: "lint 检查未通过",
      evidenceIds: ["ev-1", "ev-2"],
      artifactIds: ["artifact-1"],
      toolExecutionIds: ["te-1"],
      failureCode: "acceptance_criteria_failed",
    };

    const next = repairCurrentWorkflowNode({ snapshot: verifying, outcome });
    const verifyOutputs = next.nodes.find((n) => n.id === "verify")?.outputs;

    expect(verifyOutputs?.evidenceIds).toEqual(["ev-1", "ev-2"]);
    expect(verifyOutputs?.artifactIds).toEqual(["artifact-1"]);
    expect(verifyOutputs?.toolExecutionIds).toEqual(["te-1"]);
  });

  it("空数组的 evidenceIds/artifactIds/toolExecutionIds 不写进 outputs（跟 failCurrentWorkflowNode 的 length>0 guard 一致）", () => {
    const verifying = { ...snapshot(), currentNodeId: "verify" };
    const outcome: NodeOutcome = {
      status: "retryable",
      summary: "0 工具证据",
      evidenceIds: [],
      artifactIds: [],
      toolExecutionIds: [],
    };

    const next = repairCurrentWorkflowNode({ snapshot: verifying, outcome });
    const verifyOutputs = next.nodes.find((n) => n.id === "verify")?.outputs;

    expect(verifyOutputs).not.toHaveProperty("evidenceIds");
    expect(verifyOutputs).not.toHaveProperty("artifactIds");
    expect(verifyOutputs).not.toHaveProperty("toolExecutionIds");
  });

  it("多个 nextActions 时 continue_run 停在 waiting_user 等用户选择", () => {
    const planned = {
      ...snapshot(),
      nextActions: [
        { id: "review", labelKey: "x", targetPhase: "review" as const, recommended: false, reason: "", risk: "low" as const, estimatedCost: "low" as const },
        { id: "execute", labelKey: "y", targetPhase: "execute" as const, recommended: true, reason: "", risk: "medium" as const, estimatedCost: "high" as const },
      ],
    };
    const next = applyTurnIntentDecision({ snapshot: planned, decision: decision({ action: "continue_run" }) });
    expect(next.status).toBe("waiting_user");
    expect(next.pendingDecision?.kind).toBe("pick_next_step");
  });

  // 2026-07-15 review 修复回归测试：verifyNodeOutcome 判定 needs_user（用户拒绝写权限确认/
  // 主动中止）时，旧实现完全不更新快照，节点 status 停在原样（比如 "running"），
  // derive-chain-node-graph.ts 会一直把它渲染成"进行中"，跟真实"已经停下来"的状态对不上。
  it("markCurrentWorkflowNodeNeedsUser 把当前节点 status 改成 waiting_user，不动 currentNodeId/run 级 status", () => {
    const running = {
      ...snapshot(),
      currentNodeId: "execute",
      nodes: snapshot().nodes.map((n) => (n.id === "execute" ? { ...n, status: "running" as const } : n)),
    };
    const next = markCurrentWorkflowNodeNeedsUser({ snapshot: running });

    expect(next.nodes.find((n) => n.id === "execute")?.status).toBe("waiting_user");
    expect(next.currentNodeId).toBe("execute"); // 不推进/不后退，还是同一个节点
    expect(next.status).toBe(running.status); // run 级状态不动
    expect(next.nextActions).toEqual(running.nextActions); // 不推进 nextActions
  });

  it("markCurrentWorkflowNodeNeedsUser 找不到 currentNodeId 对应节点时原样返回，不抛错", () => {
    const orphan = { ...snapshot(), currentNodeId: "does-not-exist" };
    const next = markCurrentWorkflowNodeNeedsUser({ snapshot: orphan });
    expect(next).toBe(orphan);
  });

  // Task #9（2026-07-15）：nextActions/pendingDecision 之前没有 UI 消费，用户只能靠打字让
  // intent classifier 猜。applyNextActionChoice 是"用户直接点了某个 nextAction 按钮"这条
  // 确定性路径——不经过分类器，actionId 精确匹配就直接按 targetPhase 推进。
  it("applyNextActionChoice 按 actionId 精确匹配 targetPhase 推进，清空 nextActions/pendingDecision", () => {
    const planned = {
      ...snapshot(),
      currentNodeId: "plan",
      status: "waiting_user" as const,
      nextActions: [
        { id: "review_plan", labelKey: "x", targetPhase: "review" as const, recommended: false, reason: "", risk: "low" as const, estimatedCost: "low" as const },
        { id: "execute_plan", labelKey: "y", targetPhase: "execute" as const, recommended: true, reason: "", risk: "medium" as const, estimatedCost: "high" as const },
      ],
      pendingDecision: { nodeId: "plan", kind: "pick_next_step" as const, choices: ["review_plan", "execute_plan"] },
    };

    const next = applyNextActionChoice({ snapshot: planned, actionId: "execute_plan" });

    expect(next.currentNodeId).toBe("execute");
    expect(next.status).toBe("running");
    expect(next.nodes.find((n) => n.id === "execute")?.status).toBe("ready");
    expect(next.nextActions).toEqual([]);
    expect(next.pendingDecision).toBeUndefined();
  });

  it("applyNextActionChoice 找不到 actionId 时原样返回，不推进也不清空 nextActions", () => {
    const planned = {
      ...snapshot(),
      currentNodeId: "plan",
      nextActions: [
        { id: "execute_plan", labelKey: "y", targetPhase: "execute" as const, recommended: true, reason: "", risk: "medium" as const, estimatedCost: "high" as const },
      ],
    };

    const next = applyNextActionChoice({ snapshot: planned, actionId: "stale_action_id" });

    expect(next).toBe(planned);
  });

  // 工作流"实际动作可视化"阶段1（2026-07-18）：attachObservedActivity 是纯粹的"观测字段"
  // 写入——只允许合并 context.lastObservedActivity，不许碰权威状态机字段。
  describe("attachObservedActivity", () => {
    it("把 phases/dominant 合并进 context.lastObservedActivity，返回新对象（不 mutate 原快照）", () => {
      const original = snapshot();
      const next = attachObservedActivity(original, { phases: ["read_project", "execute"], dominant: "execute" });

      expect(next).not.toBe(original);
      expect(next.context.lastObservedActivity).toMatchObject({
        phases: ["read_project", "execute"],
        dominant: "execute",
      });
      expect(typeof next.context.lastObservedActivity?.observedAt).toBe("string");
      expect(Number.isNaN(Date.parse(next.context.lastObservedActivity!.observedAt))).toBe(false);
      // 原快照本身不受影响
      expect(original.context.lastObservedActivity).toBeUndefined();
    });

    it("绝不触碰 currentNodeId / nodes / status / nextActions / pendingDecision 等权威状态机字段", () => {
      const original = snapshot();
      const next = attachObservedActivity(original, { phases: [], dominant: null });

      expect(next.currentNodeId).toBe(original.currentNodeId);
      expect(next.nodes).toBe(original.nodes);
      expect(next.status).toBe(original.status);
      expect(next.nextActions).toBe(original.nextActions);
      expect(next.pendingDecision).toBe(original.pendingDecision);
    });

    it("dominant=null（0 有效工具/纯对话）时同样正确写入", () => {
      const next = attachObservedActivity(snapshot(), { phases: [], dominant: null });
      expect(next.context.lastObservedActivity).toMatchObject({ phases: [], dominant: null });
    });

    it("保留 context 里已有的其它字段（如 planSummary），不覆盖", () => {
      const withPlan = { ...snapshot(), context: { ...snapshot().context, planSummary: "既有计划摘要" } };
      const next = attachObservedActivity(withPlan, { phases: ["execute"], dominant: "execute" });

      expect(next.context.planSummary).toBe("既有计划摘要");
      expect(next.context.lastObservedActivity).toMatchObject({ phases: ["execute"], dominant: "execute" });
    });
  });
});
