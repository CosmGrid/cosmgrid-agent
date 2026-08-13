import { describe, expect, it } from "vitest";
import { deriveChainNodeGraph } from "../derive-chain-node-graph";
import type { ModelListItem } from "@/lib/api";
import type { OrchestrationState } from "@/lib/llm/orchestrator";
import type { WorkflowSnapshot } from "@/lib/workflow/types";

function model(id: string, name: string): ModelListItem {
  return {
    id,
    name,
    displayName: name,
    contextWindow: null,
    inputPrice: null,
    outputPrice: null,
    enabled: true,
    workRoles: "[]",
    capabilityScore: null,
    providerId: "p1",
    provider: { name: "P", type: "openai" },
  };
}

const models = [
  model("gpt-5-5", "GPT 5.5"),
  model("opus", "Opus 4.8"),
  model("deepseek", "DeepSeek"),
  model("gemini", "Gemini 3.1"),
  model("m3", "MiniMax-M3"),
];

function state(over: Partial<OrchestrationState> = {}): OrchestrationState {
  return {
    version: 2,
    updatedAt: "2026-06-29T00:00:00.000Z",
    currentNodeId: "architect-1",
    chainPlan: ["architect", "backend", "frontend", "tester"],
    nodes: [
      { id: "leader-1", role: "leader", title: "主对话", status: "done", modelId: "gpt-5-5", pinned: false },
      { id: "architect-1", role: "architect", title: "出规划", status: "active", modelId: "opus", pinned: true },
      { id: "backend-1", role: "backend", title: "后端执行", status: "planned", modelId: "deepseek", pinned: false },
      { id: "frontend-1", role: "frontend", title: "前端执行", status: "planned", modelId: "gemini", pinned: false },
      { id: "tester-1", role: "tester", title: "测试", status: "planned", modelId: "m3", pinned: false },
    ],
    ...over,
  };
}

describe("deriveChainNodeGraph", () => {
  it("第一个节点永远是主对话，并显示当前主模型", () => {
    const graph = deriveChainNodeGraph({
      orchestration: state(),
      selectedModelId: "gpt-5-5",
      selectedModelName: "GPT 5.5",
      availableModels: models,
      chainRunning: false,
      chainExecutedRoles: [],
      chainSkippedRoles: [],
      chainAbortedRole: null,
    });

    expect(graph.nodes[0]).toMatchObject({
      id: "main-chat",
      stepName: "主对话",
      modelName: "GPT 5.5",
    });
  });

  it("后续节点按工作流从左到右排序", () => {
    const graph = deriveChainNodeGraph({
      orchestration: state(),
      selectedModelId: "gpt-5-5",
      selectedModelName: "GPT 5.5",
      availableModels: models,
      chainRunning: false,
      chainExecutedRoles: [],
      chainSkippedRoles: [],
      chainAbortedRole: null,
    });

    expect(graph.nodes.map((n) => n.stepName)).toEqual([
      "主对话",
      "计划方案",
      "后端工程师执行",
      "前端工程师执行",
      "测试",
    ]);
  });

  it("chain 运行时只有第一个未完成接力节点是 running", () => {
    const graph = deriveChainNodeGraph({
      orchestration: state(),
      selectedModelId: "gpt-5-5",
      selectedModelName: "GPT 5.5",
      availableModels: models,
      chainRunning: true,
      chainExecutedRoles: ["architect"],
      chainSkippedRoles: [],
      chainAbortedRole: null,
    });

    const byRole = Object.fromEntries(graph.nodes.map((n) => [n.role, n.status]));
    expect(byRole.architect).toBe("done");
    expect(byRole.backend).toBe("running");
    expect(byRole.frontend).toBe("planned");
    expect(byRole.tester).toBe("planned");
  });

  it("支持 skipped 和 aborted 状态覆盖普通状态", () => {
    const graph = deriveChainNodeGraph({
      orchestration: state(),
      selectedModelId: "gpt-5-5",
      selectedModelName: "GPT 5.5",
      availableModels: models,
      chainRunning: true,
      chainExecutedRoles: ["architect"],
      chainSkippedRoles: ["backend"],
      chainAbortedRole: "frontend",
    });

    const byRole = Object.fromEntries(graph.nodes.map((n) => [n.role, n.status]));
    expect(byRole.backend).toBe("skipped");
    expect(byRole.frontend).toBe("aborted");
  });
});

// 2026-07-05 加：对弈进行中，"模型博弈"节点原来永远显示死板的"dynamic"占位符（渲染层转成
// "动态分配"），看不出到底哪几个模型在博弈——这里验证真实参与者传进去后节点会显示真实模型名单。
function debateSnapshot(): WorkflowSnapshot {
  return {
    version: 1,
    runId: "run-1",
    conversationId: "conv-1",
    status: "running",
    intent: {
      objective: "优化方案",
      requestedOutcome: "更好的方案",
      taskKind: "analysis",
      executionMode: "answer_only",
      reviewRequested: false,
      debateRequested: true,
      verificationRequired: false,
      securitySensitive: false,
      needsWorkspace: false,
      stickyUntil: [],
    },
    currentNodeId: "debate-1",
    nodes: [
      {
        id: "debate-1",
        phase: "debate",
        title: "模型博弈",
        status: "running",
        optional: false,
        dependsOn: [],
        assignedRoles: [],
        autoAdvance: "never",
      },
    ],
    nextActions: [],
    context: { projectFacts: [], changedFiles: [], riskLevel: "low" },
  };
}

describe("deriveChainNodeGraph — 对弈节点显示真实参与者", () => {
  it("没有传 debateParticipants 时，对弈节点 modelName 是占位符 'dynamic'", () => {
    const graph = deriveChainNodeGraph({
      orchestration: null,
      workflowSnapshot: debateSnapshot(),
      selectedModelId: "gpt-5-5",
      selectedModelName: "GPT 5.5",
      availableModels: models,
      chainRunning: false,
      chainExecutedRoles: [],
      chainSkippedRoles: [],
      chainAbortedRole: null,
    });

    const debateNode = graph.nodes.find((n) => n.role === "debate");
    expect(debateNode?.modelName).toBe("dynamic");
  });

  it("传了 debateParticipants 时，对弈节点 modelName 显示真实参与模型名单", () => {
    const graph = deriveChainNodeGraph({
      orchestration: null,
      workflowSnapshot: debateSnapshot(),
      selectedModelId: "gpt-5-5",
      selectedModelName: "GPT 5.5",
      availableModels: models,
      chainRunning: false,
      chainExecutedRoles: [],
      chainSkippedRoles: [],
      chainAbortedRole: null,
      debateParticipants: [
        { modelId: "m3", modelName: "MiniMax-M3" },
        { modelId: "opus", modelName: "Opus 4.8" },
      ],
    });

    const debateNode = graph.nodes.find((n) => n.role === "debate");
    expect(debateNode?.modelName).toBe("MiniMax-M3、Opus 4.8");
  });
});

describe("deriveChainNodeGraph — workflow 阶段节点", () => {
  it("显示已完成的博弈节点和当前执行节点", () => {
    const workflow: WorkflowSnapshot = {
      version: 1,
      runId: "run-1",
      conversationId: "conv-1",
      status: "running",
      intent: {
        objective: "执行方案",
        requestedOutcome: "按方案落地",
        taskKind: "feature",
        executionMode: "execute_directly",
        reviewRequested: false,
        debateRequested: false,
        verificationRequired: true,
        securitySensitive: false,
        needsWorkspace: true,
        stickyUntil: [],
      },
      currentNodeId: "execute",
      nodes: [
        {
          id: "read_project",
          phase: "read_project",
          title: "读取项目",
          status: "done",
          optional: false,
          dependsOn: [],
          assignedRoles: [],
          autoAdvance: "always",
        },
        {
          id: "plan",
          phase: "plan",
          title: "制定方案",
          status: "done",
          optional: false,
          dependsOn: ["read_project"],
          assignedRoles: [],
          autoAdvance: "never",
        },
        {
          id: "debate",
          phase: "debate",
          title: "模型博弈",
          status: "done",
          optional: true,
          dependsOn: ["plan"],
          assignedRoles: [],
          autoAdvance: "never",
        },
        {
          id: "execute",
          phase: "execute",
          title: "执行方案",
          status: "ready",
          optional: false,
          dependsOn: ["plan"],
          assignedRoles: [],
          autoAdvance: "never",
        },
      ],
      nextActions: [],
      context: { projectFacts: [], changedFiles: [], riskLevel: "low" },
    };

    const graph = deriveChainNodeGraph({
      orchestration: null,
      workflowSnapshot: workflow,
      selectedModelId: "m3",
      selectedModelName: "MiniMax-M3",
      availableModels: models,
      chainRunning: false,
      chainExecutedRoles: [],
      chainSkippedRoles: [],
      chainAbortedRole: null,
    });

    const byRole = Object.fromEntries(graph.nodes.map((node) => [node.role, node]));
    expect(byRole.debate).toMatchObject({ stepName: "模型博弈", status: "done" });
    expect(byRole.execute).toMatchObject({ stepName: "执行方案", status: "active", modelName: "dynamic" });
    expect(graph.nodes.map((node) => node.role)).toContain("leader");
  });

  // 2026-07-15 review 修复回归测试：节点 status 是 "waiting_user"（用户拒绝写权限确认/
  // 主动中止后，reducer.ts 的 markCurrentWorkflowNodeNeedsUser 会把节点改成这个状态）时，
  // 不该跟 running/ready 一样被渲染成 "active"（看起来还在进行中）——用户已经停下来了。
  it("节点 status 为 waiting_user 时不渲染成 active（已经停下来了，不是还在进行中）", () => {
    const workflow: WorkflowSnapshot = {
      version: 1,
      runId: "run-1",
      conversationId: "conv-1",
      status: "waiting_user",
      intent: {
        objective: "执行方案",
        requestedOutcome: "按方案落地",
        taskKind: "feature",
        executionMode: "execute_directly",
        reviewRequested: false,
        debateRequested: false,
        verificationRequired: true,
        securitySensitive: false,
        needsWorkspace: true,
        stickyUntil: [],
      },
      currentNodeId: "execute",
      nodes: [
        {
          id: "execute",
          phase: "execute",
          title: "执行方案",
          status: "waiting_user",
          optional: false,
          dependsOn: ["plan"],
          assignedRoles: [],
          autoAdvance: "never",
        },
      ],
      nextActions: [],
      context: { projectFacts: [], changedFiles: [], riskLevel: "low" },
    };

    const graph = deriveChainNodeGraph({
      orchestration: null,
      workflowSnapshot: workflow,
      selectedModelId: "m3",
      selectedModelName: "MiniMax-M3",
      availableModels: models,
      chainRunning: false,
      chainExecutedRoles: [],
      chainSkippedRoles: [],
      chainAbortedRole: null,
    });

    const byRole = Object.fromEntries(graph.nodes.map((node) => [node.role, node]));
    expect(byRole.execute?.status).not.toBe("active");
    expect(byRole.execute?.status).toBe("aborted");
  });
});

// 工作流"实际动作可视化"阶段1（2026-07-18）：context.lastObservedActivity.phases 命中的
// workflow 节点应该被标记 touched=true，纯展示态，不影响 status 本身。
describe("deriveChainNodeGraph — touched（观测到本轮真实动过手）", () => {
  function workflowWithObservedActivity(
    lastObservedActivity?: { phases: import("@/lib/workflow/types").WorkflowPhase[]; dominant: import("@/lib/workflow/types").WorkflowPhase | null; observedAt: string },
  ): WorkflowSnapshot {
    return {
      version: 1,
      runId: "run-1",
      conversationId: "conv-1",
      status: "running",
      intent: {
        objective: "执行方案",
        requestedOutcome: "按方案落地",
        taskKind: "feature",
        executionMode: "execute_directly",
        reviewRequested: false,
        debateRequested: false,
        verificationRequired: false,
        securitySensitive: false,
        needsWorkspace: true,
        stickyUntil: [],
      },
      currentNodeId: "execute",
      nodes: [
        {
          id: "read_project",
          phase: "read_project",
          title: "读取项目",
          status: "done",
          optional: false,
          dependsOn: [],
          assignedRoles: [],
          autoAdvance: "always",
        },
        {
          id: "execute",
          phase: "execute",
          title: "执行方案",
          status: "ready",
          optional: false,
          dependsOn: [],
          assignedRoles: [],
          autoAdvance: "never",
        },
      ],
      nextActions: [],
      context: {
        projectFacts: [],
        changedFiles: [],
        riskLevel: "low",
        ...(lastObservedActivity ? { lastObservedActivity } : {}),
      },
    };
  }

  it("没有 lastObservedActivity（旧快照/纯问答轮）时所有节点 touched 为 falsy", () => {
    const graph = deriveChainNodeGraph({
      orchestration: null,
      workflowSnapshot: workflowWithObservedActivity(undefined),
      selectedModelId: "m3",
      selectedModelName: "MiniMax-M3",
      availableModels: models,
      chainRunning: false,
      chainExecutedRoles: [],
      chainSkippedRoles: [],
      chainAbortedRole: null,
    });

    const byRole = Object.fromEntries(graph.nodes.map((node) => [node.role, node]));
    expect(byRole.read_project?.touched).toBeFalsy();
    expect(byRole.execute?.touched).toBeFalsy();
  });

  it("lastObservedActivity.phases 命中 execute 时，execute 节点 touched=true，未命中的 read_project 不受影响", () => {
    const graph = deriveChainNodeGraph({
      orchestration: null,
      workflowSnapshot: workflowWithObservedActivity({
        phases: ["execute"],
        dominant: "execute",
        observedAt: "2026-07-18T00:00:00.000Z",
      }),
      selectedModelId: "m3",
      selectedModelName: "MiniMax-M3",
      availableModels: models,
      chainRunning: false,
      chainExecutedRoles: [],
      chainSkippedRoles: [],
      chainAbortedRole: null,
    });

    const byRole = Object.fromEntries(graph.nodes.map((node) => [node.role, node]));
    expect(byRole.execute?.touched).toBe(true);
    expect(byRole.read_project?.touched).toBeFalsy();
  });

  it("lastObservedActivity.phases 同时命中 read_project 和 execute 时，两个节点都 touched=true", () => {
    const graph = deriveChainNodeGraph({
      orchestration: null,
      workflowSnapshot: workflowWithObservedActivity({
        phases: ["read_project", "execute"],
        dominant: "execute",
        observedAt: "2026-07-18T00:00:00.000Z",
      }),
      selectedModelId: "m3",
      selectedModelName: "MiniMax-M3",
      availableModels: models,
      chainRunning: false,
      chainExecutedRoles: [],
      chainSkippedRoles: [],
      chainAbortedRole: null,
    });

    const byRole = Object.fromEntries(graph.nodes.map((node) => [node.role, node]));
    expect(byRole.read_project?.touched).toBe(true);
    expect(byRole.execute?.touched).toBe(true);
  });
});
