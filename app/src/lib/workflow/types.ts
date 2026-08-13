import type { RoleId } from "@/lib/roles";
import type { SemanticIntentRoute } from "./semantic-intent-router";

export type TurnAction =
  | "start_run"
  | "continue_run"
  | "modify_run"
  | "approve_node"
  | "reject_node"
  | "pause_run"
  | "resume_run"
  | "cancel_run"
  | "answer_only";

export type ExecutionMode =
  | "answer_only"
  | "plan_only"
  | "plan_then_execute"
  | "execute_directly";

export interface WorkflowIntent {
  objective: string;
  requestedOutcome: string;
  taskKind: "bugfix" | "feature" | "refactor" | "analysis" | "setup" | "unknown";
  executionMode: ExecutionMode;
  reviewRequested: boolean;
  debateRequested: boolean;
  verificationRequired: boolean;
  securitySensitive: boolean;
  needsWorkspace: boolean;
  stickyUntil: Array<"completed" | "user_override" | "scope_change" | "hard_failure">;
}

export interface TurnIntentDecision {
  action: TurnAction;
  targetRunId: string | null;
  confidence: number;
  reason: string;
  evidenceTurnIds: string[];
  patch?: Partial<WorkflowIntent>;
  /**
   * 5.1 修复（2026-07-02）：消息难度档位（simple/standard/hard）。
   * 与 lib/llm/message-router.ts 的 MessageComplexity 保持一致，但这里内联定义避免循环依赖。
   * 调用方（如 message-router.ts）可以用此字段而不再独立跑一次 classifyMessageComplexity。
   */
  complexity?: "simple" | "standard" | "hard";
  /**
   * M1 修复（2026-07-09）：classifyTurnIntentWithJudge 内部已经跑过一次语义路由，
   * 顺手把结果挂在这里——调用方（如意图诊断面板）不用为了拿同一份 route 再调一次
   * routeTurnIntentSemantically（省一次 keywordEmbed + 逐样例余弦相似度）。
   * cancel_run/pause_run 走 L0 硬规则短路时不会算语义路由，此时为 undefined。
   */
  semanticRoute?: SemanticIntentRoute;
}

export type WorkflowPhase =
  | "read_project"
  | "plan"
  | "review"
  | "debate"
  | "execute"
  | "verify";

export type WorkflowPlanSourceKind =
  | "message"
  | "file"
  | "debate_result"
  | "degraded_debate";

export interface WorkflowPlanSource {
  kind: WorkflowPlanSourceKind;
  ref: string;
  summary: string;
  boundAt: string;
  phase?: WorkflowPhase;
  label?: string;
}

export interface WorkflowActiveSkill {
  id: string;
  label: string;
  selectedAt: string;
  reason: string;
}

export type WorkflowRunStatus =
  | "running"
  | "waiting_user"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export type WorkflowNodeStatus =
  | "pending"
  | "ready"
  | "running"
  | "waiting_user"
  | "done"
  | "failed"
  | "skipped";

export interface WorkflowNode {
  id: string;
  phase: WorkflowPhase;
  title: string;
  status: WorkflowNodeStatus;
  optional: boolean;
  dependsOn: string[];
  assignedRoles: RoleId[];
  assignedModelId?: string | null;
  autoAdvance: "always" | "if_confident" | "never";
  /** Harness 工程实施计划阶段1：verify 阶段验收失败后已经自动打回 execute 修复的次数。
   *  达到 node-verifier.ts 的 MAX_REPAIR_ATTEMPTS 后不再自动重试，进入 blocked。 */
  repairAttempts?: number;
  outputs?: {
    summary?: string;
    artifactIds?: string[];
    toolExecutionIds?: string[];
    /**
     * 阶段3（2026-07-11）：证据链 ID 列表。EvidenceRef.id 集合（存在
     * `app/src/lib/llm/evidence/types.ts`），用于声明 ↔ 证据对账。UI EvidencePanel
     * 通过这个 ID 列表从 WorkflowSnapshot.outputs.verification.conflicts[*].evidenceIds
     * 反查渲染。
     */
    evidenceIds?: string[];
    /**
     * 阶段3：Task Verifier 结构化结果（声明对账 + 验收标准判定）。
     * failureCode 区分阶段1 粗筛（harness_dirty / no_tool_evidence / empty_output）
     * vs 阶段3 细对账（evidence_contradicts / evidence_insufficient / evidence_truncated）。
     */
    verification?: import("@/lib/llm/evidence/types").VerificationResult;
  };
}

export interface NextAction {
  id: string;
  labelKey: string;
  targetPhase: WorkflowPhase;
  recommended: boolean;
  reason: string;
  risk: "low" | "medium" | "high";
  estimatedCost: "low" | "medium" | "high";
}

export interface WorkflowSnapshot {
  version: 1;
  runId: string;
  conversationId: string;
  projectId?: string | null;
  status: WorkflowRunStatus;
  intent: WorkflowIntent;
  currentNodeId: string | null;
  nodes: WorkflowNode[];
  nextActions: NextAction[];
  context: {
    workspacePath?: string | null;
    projectFacts: string[];
    activeSkill?: WorkflowActiveSkill;
    planSummary?: string;
    planSource?: WorkflowPlanSource;
    reviewSummary?: string;
    debateSummary?: string;
    changedFiles: string[];
    verificationSummary?: string;
    /**
     * 阶段3（2026-07-11）：上一次 Task Verifier 决策的人类可读摘要，1 行 ≤ 200 字符。
     * 由 stream-finalization 写入，用于普通用户 UI（不展开 dev 模式时直接显示这行）。
     */
    lastVerificationSummary?: string;
    riskLevel: "low" | "medium" | "high";
    /**
     * 工作流"实际动作可视化"阶段1（2026-07-18）：非权威的"观测字段"——回合结束时根据
     * 本轮真实调用的工具类型（见 lib/workflow/observed-activity.ts deriveObservedActivity）
     * 算出的"这轮主要活动是读/写/命令"。只给展示层（derive-chain-node-graph.ts）加视觉态用，
     * **不是**权威状态机的一部分，不影响 currentNodeId / node.status / run.status 的推进。
     * 可选字段，不破坏现有快照（旧快照没有这个字段时按"无观测数据"处理）。
     */
    lastObservedActivity?: {
      phases: WorkflowPhase[];
      dominant: WorkflowPhase | null;
      observedAt: string;
    };
  };
  pendingDecision?: {
    nodeId: string;
    kind: "approve_execute" | "pick_next_step" | "resolve_ambiguity";
    choices: string[];
  };
}

export const WORKFLOW_VERSION = 1 as const;
