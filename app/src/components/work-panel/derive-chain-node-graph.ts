import type { ModelListItem } from "@/lib/api";
import {
  deriveChainProgress,
  type OrchestrationState,
  type RoleId,
} from "@/lib/llm/orchestrator";
import type { WorkflowNode, WorkflowPhase, WorkflowSnapshot } from "@/lib/workflow/types";

export type ChainNodeVisualStatus = "planned" | "active" | "running" | "done" | "skipped" | "aborted";
export type ChainNodeRole = RoleId | WorkflowPhase;

export interface ChainNodeView {
  id: string;
  role: ChainNodeRole;
  stepName: string;
  title: string;
  modelId: string | null;
  modelName: string;
  status: ChainNodeVisualStatus;
  pinned: boolean;
  locked?: boolean;
  /**
   * 工作流"实际动作可视化"阶段1（2026-07-18）：非权威的展示态——本轮 AI 是否真的在这个
   * 阶段动过手（来自 WorkflowSnapshot.context.lastObservedActivity.phases 命中）。
   * 只影响 UI 的一层轻量高亮，不参与 status 的推进判定，也不覆盖已有的 status 语义。
   */
  touched?: boolean;
}

export interface ChainNodeGraphView {
  nodes: ChainNodeView[];
}

const ROLE_STEP_NAME: Record<ChainNodeRole, string> = {
  leader: "主对话",
  architect: "计划方案",
  frontend: "前端工程师执行",
  backend: "后端工程师执行",
  runner: "运行检查",
  tester: "测试",
  reviewer: "最终审查",
  security: "安全审查",
  read_project: "读取项目",
  plan: "制定方案",
  review: "评审方案",
  debate: "模型博弈",
  execute: "执行方案",
  verify: "验证结果",
};

const CHAIN_ROLE_ORDER: ChainNodeRole[] = [
  "leader",
  "read_project",
  "plan",
  "architect",
  "review",
  "debate",
  "execute",
  "backend",
  "frontend",
  "verify",
  "runner",
  "tester",
  "reviewer",
  "security",
];

function modelName(modelId: string | null, models: ModelListItem[], fallback: string): string {
  if (!modelId) return fallback;
  const model = models.find((m) => m.id === modelId);
  return model?.displayName || model?.name || modelId;
}

function byStableRoleOrder(a: ChainNodeView, b: ChainNodeView): number {
  return CHAIN_ROLE_ORDER.indexOf(a.role) - CHAIN_ROLE_ORDER.indexOf(b.role) || a.id.localeCompare(b.id);
}

function debateNodeStatus(snapshot: WorkflowSnapshot, node: WorkflowNode): ChainNodeVisualStatus {
  if (node.status === "done") return "done";
  if (node.status === "failed") return "aborted";
  if (node.status === "skipped") return "skipped";
  // 2026-07-15 review 修复：waiting_user（用户拒绝权限/主动中止）不该跟 running/ready 一样
  // 渲染成 "active"（看起来还在跑）——ChainNodeVisualStatus 目前没有专门的"暂停等用户"视觉
  // 状态，借用 "aborted"（X 图标 + 醒目配色）传达"已经停下来了，不是还在进行中"，比继续显示
  // "进行中"更接近真实情况。后续如果要精确区分"失败终止"和"等用户"，再给 ChainNodeVisualStatus
  // 加专门的枚举值 + 图标/配色。
  if (node.status === "waiting_user") return "aborted";
  if (snapshot.currentNodeId === node.id || node.status === "ready" || node.status === "running") return "active";
  return "planned";
}

function deriveDebateNode(
  snapshot: WorkflowSnapshot | null,
  participants: { modelId: string; modelName: string }[] | null | undefined,
): ChainNodeView | null {
  if (!snapshot) return null;
  const node = snapshot.nodes.find((n) => n.phase === "debate") ?? null;
  if (!node) return null;
  const shouldShow =
    snapshot.intent.debateRequested ||
    snapshot.currentNodeId === node.id ||
    node.status !== "pending";
  if (!shouldShow) return null;

  // 2026-07-05 修复：真实参与者（模型名列表）没传时才回退到"dynamic"占位符（渲染层
  // ChainNodeGraph 把它转成"动态分配"）——参与者一旦解析出来，直接显示真实模型名单，
  // 不再让用户"点了开始博弈却不知道到底是谁在跟谁博弈"。
  const modelNameDisplay =
    participants && participants.length > 0
      ? participants.map((p) => p.modelName).join("、")
      : "dynamic";

  return {
    id: "workflow-debate",
    role: "debate",
    stepName: ROLE_STEP_NAME.debate,
    title: node.title,
    modelId: null,
    modelName: modelNameDisplay,
    status: debateNodeStatus(snapshot, node),
    pinned: false,
    locked: true,
  };
}

function workflowNodeStatus(snapshot: WorkflowSnapshot, node: WorkflowNode): ChainNodeVisualStatus {
  if (node.status === "done") return "done";
  if (node.status === "failed") return "aborted";
  if (node.status === "skipped") return "skipped";
  // 2026-07-15 review 修复：见 debateNodeStatus 同名分支的注释——waiting_user 不该跟
  // running/ready 一样渲染成"进行中"。
  if (node.status === "waiting_user") return "aborted";
  if (snapshot.currentNodeId === node.id || node.status === "ready" || node.status === "running") return "active";
  return "planned";
}

/**
 * 工作流"实际动作可视化"阶段1（2026-07-18）：这个阶段本轮是否被观测到真实动过手
 * （snapshot.context.lastObservedActivity.phases 命中）。没有观测数据（旧快照/纯问答轮）
 * 时恒为 false——只是"没有额外信息"，不代表"这个阶段没在动"，UI 上不应该因此产生任何
 * 负面视觉暗示，只是不点亮而已。
 */
function isPhaseObservedTouched(snapshot: WorkflowSnapshot, phase: WorkflowPhase): boolean {
  return snapshot.context.lastObservedActivity?.phases.includes(phase) ?? false;
}

function shouldShowWorkflowNode(snapshot: WorkflowSnapshot, node: WorkflowNode): boolean {
  if (node.status !== "pending" || snapshot.currentNodeId === node.id) return true;
  if (node.phase === "debate") return snapshot.intent.debateRequested;
  if (node.phase === "review") return snapshot.intent.reviewRequested;
  if (node.phase === "execute") return snapshot.intent.executionMode === "execute_directly";
  if (node.phase === "verify") return snapshot.intent.verificationRequired && snapshot.currentNodeId === node.id;
  return false;
}

function deriveWorkflowNodes(
  snapshot: WorkflowSnapshot | null,
  models: ModelListItem[],
  participants: { modelId: string; modelName: string }[] | null | undefined,
): ChainNodeView[] {
  if (!snapshot) return [];
  const nodes: ChainNodeView[] = snapshot.nodes
    .filter((node) => node.phase !== "debate")
    .filter((node) => shouldShowWorkflowNode(snapshot, node))
    .map<ChainNodeView>((node) => ({
      id: `workflow-${node.id}`,
      role: node.phase,
      stepName: ROLE_STEP_NAME[node.phase],
      title: node.title,
      modelId: node.assignedModelId ?? null,
      modelName:
        modelName(node.assignedModelId ?? null, models, "") ||
        (node.phase === "execute" || node.phase === "verify" ? "dynamic" : node.title),
      status: workflowNodeStatus(snapshot, node),
      pinned: false,
      locked: true,
      touched: isPhaseObservedTouched(snapshot, node.phase),
    }));
  const debateNode = deriveDebateNode(snapshot, participants);
  if (debateNode) nodes.push(debateNode);
  return nodes.sort(byStableRoleOrder);
}

export function deriveChainNodeGraph(args: {
  orchestration: OrchestrationState | null;
  workflowSnapshot?: WorkflowSnapshot | null;
  selectedModelId: string;
  selectedModelName: string;
  availableModels: ModelListItem[];
  chainRunning: boolean;
  chainExecutedRoles: RoleId[];
  chainSkippedRoles: RoleId[];
  chainAbortedRole: RoleId | null;
  /** 对弈进行中的真实参与模型（useChatStream 里 buildDebateParticipants 解析完就填，
   *  对弈结束/中止/失败清空）——没有时回退到"动态分配"占位符，见 deriveDebateNode。 */
  debateParticipants?: { modelId: string; modelName: string }[] | null;
}): ChainNodeGraphView {
  const leaderNode: ChainNodeView = {
    id: "main-chat",
    role: "leader",
    stepName: ROLE_STEP_NAME.leader,
    title: "当前主对话",
    modelId: args.selectedModelId || null,
    modelName: args.selectedModelName || modelName(args.selectedModelId || null, args.availableModels, "未选择模型"),
    status: args.orchestration?.currentNodeId ? "done" : args.chainRunning ? "running" : "active",
    pinned: false,
  };
  const workflowNodes = deriveWorkflowNodes(args.workflowSnapshot ?? null, args.availableModels, args.debateParticipants);

  if (!args.orchestration || args.orchestration.nodes.length === 0) {
    return { nodes: [leaderNode, ...workflowNodes].sort(byStableRoleOrder) };
  }

  const executed = new Set(args.chainExecutedRoles);
  const skipped = new Set(args.chainSkippedRoles);
  const progress = deriveChainProgress({
    chainPlan: args.orchestration.chainPlan ?? [],
    executedRoles: args.chainExecutedRoles,
    skippedRoles: args.chainSkippedRoles,
    abortedRole: args.chainAbortedRole,
  });
  const current = args.orchestration.nodes.find((n) => n.id === args.orchestration?.currentNodeId) ?? null;

  const views = args.orchestration.nodes
    .filter((node) => node.role !== "leader")
    .map<ChainNodeView>((node) => {
      let status: ChainNodeVisualStatus;
      if (node.role === args.chainAbortedRole) status = "aborted";
      else if (skipped.has(node.role)) status = "skipped";
      else if (args.chainRunning && progress.executingRole === node.role) status = "running";
      else if (executed.has(node.role) || node.status === "done") status = "done";
      else if (node.id === args.orchestration?.currentNodeId || current?.role === node.role) status = "active";
      else status = "planned";

      return {
        id: node.id,
        role: node.role,
        stepName: ROLE_STEP_NAME[node.role] ?? node.role,
        title: node.title,
        modelId: node.modelId,
        modelName: modelName(node.modelId, args.availableModels, "未绑定模型"),
        status,
        pinned: node.pinned,
      };
    })
    .sort(byStableRoleOrder);

  const workflowNodeIds = new Set(workflowNodes.map((node) => node.id));
  const nodes = [leaderNode, ...views, ...workflowNodes]
    .filter((node, index, all) => !workflowNodeIds.has(node.id) || all.findIndex((x) => x.id === node.id) === index)
    .sort(byStableRoleOrder);
  return { nodes };
}
