import { defaultNextActionsForPhase } from "./code-task-template";
import type { NodeOutcome } from "./node-outcome";
import type { TurnIntentDecision, WorkflowActiveSkill, WorkflowNode, WorkflowPhase, WorkflowPlanSource, WorkflowSnapshot } from "./types";
import type { VerificationResult } from "@/lib/llm/evidence/types";

function updateNode(snapshot: WorkflowSnapshot, nodeId: string, patch: Partial<WorkflowNode>): WorkflowSnapshot {
  return {
    ...snapshot,
    nodes: snapshot.nodes.map((node) => node.id === nodeId ? { ...node, ...patch } : node),
  };
}

function phaseNode(snapshot: WorkflowSnapshot, phase: WorkflowPhase): WorkflowNode | null {
  return snapshot.nodes.find((node) => node.phase === phase) ?? null;
}

function setCurrentPhase(snapshot: WorkflowSnapshot, phase: WorkflowPhase): WorkflowSnapshot {
  const node = phaseNode(snapshot, phase);
  if (!node) return snapshot;
  return {
    ...snapshot,
    currentNodeId: node.id,
    nodes: snapshot.nodes.map((n) =>
      n.id === node.id && n.status === "pending" ? { ...n, status: "ready" } : n,
    ),
  };
}

export function completeCurrentWorkflowNode(args: {
  snapshot: WorkflowSnapshot;
  summary?: string;
  planSource?: WorkflowPlanSource;
  artifactIds?: string[];
  toolExecutionIds?: string[];
  /** 阶段3（2026-07-11）：Task Verifier 产生的 EvidenceRef.id 列表，透传到 outputs.evidenceIds。 */
  evidenceIds?: string[];
  /** 阶段3：Task Verifier 结构化结果，透传到 outputs.verification。 */
  verification?: VerificationResult;
}): WorkflowSnapshot {
  const node = args.snapshot.nodes.find((n) => n.id === args.snapshot.currentNodeId);
  if (!node) return args.snapshot;
  const summary = args.summary;
  const context = { ...args.snapshot.context };

  if (summary) {
    if (node.phase === "plan") {
      context.planSummary = summary;
      context.planSource = args.planSource ?? {
        kind: "message",
        ref: `workflow:${args.snapshot.runId}:${node.id}`,
        summary,
        phase: "plan",
        boundAt: new Date().toISOString(),
      };
    } else if (node.phase === "review") {
      context.reviewSummary = summary;
    } else if (node.phase === "debate") {
      context.debateSummary = summary;
      context.planSummary = summary;
      context.planSource = args.planSource ?? {
        kind: "degraded_debate",
        ref: `workflow:${args.snapshot.runId}:${node.id}`,
        summary,
        phase: "debate",
        boundAt: new Date().toISOString(),
      };
    } else if (node.phase === "verify") {
      context.verificationSummary = summary;
      // 阶段3：把人类可读的对账摘要塞进 context，普通用户 UI 默认折叠时直接显示这一行
      if (args.verification) {
        context.lastVerificationSummary = args.verification.humanSummary;
      }
    }
  }

  const next = updateNode(args.snapshot, node.id, {
    status: "done",
    outputs: {
      ...(node.outputs ?? {}),
      ...(summary ? { summary } : {}),
      ...(args.artifactIds ? { artifactIds: args.artifactIds } : {}),
      ...(args.toolExecutionIds ? { toolExecutionIds: args.toolExecutionIds } : {}),
      ...(args.evidenceIds && args.evidenceIds.length > 0 ? { evidenceIds: args.evidenceIds } : {}),
      ...(args.verification ? { verification: args.verification } : {}),
    },
  });

  // 2026-07-15 review 修复：defaultNextActionsForPhase 对 verify 阶段返回空数组（管线走到
  // 头了，没有"下一步"可选）。旧实现不管 nextActions 是否为空都把 status 设成 "waiting_user"
  // ——但 WorkflowRunStatus 从来没有任何路径把它转成 "completed"，getActiveByConversation
  // 又把 waiting_user 当"活跃"状态继续复用同一个 run。结果是：任务真正做完一次（走到
  // verify 通过）之后，这个 run 会在同一对话的所有后续消息里被反复捞出来，currentNodeId
  // 恒定在 verify 节点，capabilitiesForPhase("verify") 只给"跑测试/跑构建/看报错"三项能力，
  // 不含 edit_files——用户往后所有"帮我改一下 XX"的写文件请求都会被 K7 门控静默拒绝，
  // 没有任何提示告诉用户为什么。
  //
  // 2026-07-15 二次修复（同一轮会话，动手前自查发现的回归）：最初这里写的是
  // "nextActions.length === 0 就判定管线终点"，想的是"不用每加一个终点阶段都回来改"。
  // 但 defaultNextActionsForPhase 对 review/debate 阶段也落进同一个 `return []` 默认分支
  // ——review/debate 不是管线终点，是从 plan 分出去的旁支，完成后应该回到"可以继续 execute"
  // 的状态（debate 完成时 context.planSummary 会被设成 debate 的结论，就是当"这就是最终
  // 方案"在用）。旧的宽松判定会把刚做完一次 debate/review 的 run 也标成 "completed"，
  // getActiveByConversation 后续再也捞不到它，用户接下来说"那就执行吧"会因为拿不到
  // activeRun 而被分类成全新任务，debate/review 好不容易产出的方案被无声丢弃——这是本次
  // review 流程里我自己写的 fix 又引入的一个新 bug，动手前自查时发现，改成只认 verify 这一个
  // 真正意义上的管线终点，不再用"nextActions 是否为空"这个过宽的代理判定。
  const nextActions = defaultNextActionsForPhase(node.phase);
  const isPipelineEnd = node.phase === "verify";

  return {
    ...next,
    context,
    status: isPipelineEnd ? "completed" : "waiting_user",
    nextActions,
    pendingDecision: nextActions.length > 0
      ? {
          nodeId: node.id,
          kind: "pick_next_step",
          choices: nextActions.map((action) => action.id),
        }
      : undefined,
  };
}

/**
 * Harness 工程实施计划阶段1 —— 节点验收未通过时的落库路径。
 * 跟 completeCurrentWorkflowNode 对称，但节点状态标 "failed" 而不是 "done"，
 * 不推进 nextActions/pendingDecision（不能让用户以为可以选"下一步"）。
 * 调用方（stream-finalization.ts）先跑 verifyNodeOutcome，只有 outcome.status !== "passed"
 * 时才走这条路径；needs_user（用户拒绝权限/主动取消）不应该调这个函数——那种情况节点
 * 保持原状即可，不是"验收失败"。
 */
export function failCurrentWorkflowNode(args: {
  snapshot: WorkflowSnapshot;
  outcome: NodeOutcome;
}): WorkflowSnapshot {
  const node = args.snapshot.nodes.find((n) => n.id === args.snapshot.currentNodeId);
  if (!node) return args.snapshot;

  const next = updateNode(args.snapshot, node.id, {
    status: "failed",
    outputs: {
      ...(node.outputs ?? {}),
      summary: args.outcome.summary,
      ...(args.outcome.artifactIds.length > 0 ? { artifactIds: args.outcome.artifactIds } : {}),
      ...(args.outcome.toolExecutionIds.length > 0 ? { toolExecutionIds: args.outcome.toolExecutionIds } : {}),
      // 阶段3：NodeOutcome 已预留 evidenceIds 字段，透传即可（不破接口）。
      ...(args.outcome.evidenceIds.length > 0 ? { evidenceIds: args.outcome.evidenceIds } : {}),
    },
  });

  // 2026-07-15 review 复检发现的遗漏：这里跟 completeCurrentWorkflowNode 是同一类 bug，
  // 只是触发条件从"成功走完"变成"失败到终态"——调用方（stream-finalization.ts）只在
  // outcome.status === "failed" || "blocked" 时才调这个函数，两者都是明确的终态判定
  // （failed 是直接判定失败，blocked 是 verify 重试打回 execute 修复 MAX_REPAIR_ATTEMPTS
  // 次后仍不通过），不会再被自动重试。旧实现把 run 状态设成 "waiting_user"，而
  // getActiveByConversation 把 waiting_user 当"活跃"继续复用——一次判死的任务会在同一
  // 对话后续所有消息里被反复捞回，currentNodeId 仍停在这个失败节点，
  // capabilitiesForPhase(该节点 phase) 继续按那个阶段的门控卡写工具，跟"成功但卡在 verify"
  // 是完全一样的永久锁死症状。改用 WorkflowRunStatus 里本来就定义了但一直没用过的
  // "failed" 终态（跟 completeCurrentWorkflowNode 用 "completed" 是同一个思路），
  // getActiveByConversation 的查询条件不含 "failed"，后续消息不会再捞到这个 run。
  return {
    ...next,
    context: {
      ...args.snapshot.context,
      // 阶段3：失败也把失败原因里挂的 evidence id 落到 context.lastVerificationSummary
      // （同一字段，UI 复用），便于用户在 UI 里直接看到"缺哪条证据"。
      lastVerificationSummary: args.outcome.summary,
    },
    status: "failed",
    nextActions: [],
    pendingDecision: undefined,
  };
}

/**
 * Harness 工程实施计划阶段1 —— verify 验收 outcome.status === "retryable" 时的落库路径。
 * 跟 failCurrentWorkflowNode 不同：不是终态锁死，而是把 verify 节点打回 pending、
 * 把 currentNodeId 切回 execute 节点等待下一轮修复，同时把 repairAttempts 计数 +1
 * （持久化在 snapshot_json 里，重启后从这个计数继续算，不会无限重试）。
 * 调用方（stream-finalization.ts）只在 outcome.status === "retryable" 时调用这个函数；
 * 达到 node-verifier.ts 的 MAX_REPAIR_ATTEMPTS 上限后 outcome.status 会变成 "blocked"，
 * 那种情况走 failCurrentWorkflowNode 锁死，不再调这里。
 */
export function repairCurrentWorkflowNode(args: {
  snapshot: WorkflowSnapshot;
  outcome: NodeOutcome;
}): WorkflowSnapshot {
  const verifyNode = args.snapshot.nodes.find((n) => n.id === args.snapshot.currentNodeId);
  if (!verifyNode) return args.snapshot;

  const withRepairCount = updateNode(args.snapshot, verifyNode.id, {
    status: "pending",
    repairAttempts: (verifyNode.repairAttempts ?? 0) + 1,
    outputs: {
      ...(verifyNode.outputs ?? {}),
      summary: args.outcome.summary,
      // 2026-07-14：跟 failCurrentWorkflowNode 对齐——之前这里只写 summary，把
      // outcome.evidenceIds/artifactIds/toolExecutionIds 全丢了。细对账（verifyTask）
      // 接入真门控后，这些字段第一次真的带着具体证据 id（如 lint 失败的 bash 记录），
      // 不再是恒为空数组；不透传的话，重试循环期间（还没到 blocked 终态前）审计面板
      // 看不到"具体是哪条证据证明失败的"，只有走到终态才补得上。
      ...(args.outcome.artifactIds.length > 0 ? { artifactIds: args.outcome.artifactIds } : {}),
      ...(args.outcome.toolExecutionIds.length > 0 ? { toolExecutionIds: args.outcome.toolExecutionIds } : {}),
      ...(args.outcome.evidenceIds.length > 0 ? { evidenceIds: args.outcome.evidenceIds } : {}),
    },
  });

  const executeNode = withRepairCount.nodes.find((n) => n.phase === "execute");
  if (!executeNode) {
    return { ...withRepairCount, status: "waiting_user", nextActions: [], pendingDecision: undefined };
  }

  return {
    ...withRepairCount,
    currentNodeId: executeNode.id,
    nodes: withRepairCount.nodes.map((n) => (n.id === executeNode.id ? { ...n, status: "ready" } : n)),
    status: "running",
    nextActions: [],
    pendingDecision: undefined,
  };
}

/**
 * 2026-07-15 review 修复：verifyNodeOutcome 判定为 "needs_user"（用户拒绝了写权限确认 /
 * 主动中止这一轮）时，旧实现完全不更新快照——注释写的是"节点保持原状，不落新事件"，
 * 但"原状"就是节点还停在 "running"（或调用方传进来时的状态），
 * WorkPanel 的 derive-chain-node-graph.ts 靠 `currentNodeId === node.id || status ===
 * "running"` 判定"active"（渲染成"进行中"），于是用户拒绝权限/点了停止之后，这个节点会
 * 一直显示"进行中"，直到用户再发一条能推进节点的消息为止——纯视觉上的卡住，跟真实执行
 * 状态完全对不上。
 *
 * 修复：只改节点自己的 status 为 "waiting_user"（WorkflowNodeStatus 已有这个值，一直没
 * 被这条路径用过），不动 currentNodeId、不动 run 级 status、不推进 nextActions——这条依然
 * 遵守"不落新事件、等用户下一步指示"的原设计，只是让节点的视觉状态如实反映"已经停下来了"
 * 而不是"还在跑"。
 */
export function markCurrentWorkflowNodeNeedsUser(args: {
  snapshot: WorkflowSnapshot;
}): WorkflowSnapshot {
  const node = args.snapshot.nodes.find((n) => n.id === args.snapshot.currentNodeId);
  if (!node) return args.snapshot;
  return updateNode(args.snapshot, node.id, { status: "waiting_user" });
}

/**
 * 工作流"实际动作可视化"阶段1（2026-07-18）—— 把 deriveObservedActivity 的结果合并进
 * snapshot.context，返回新 snapshot（spread 复制，不 mutate）。
 *
 * 硬性纪律：这是纯粹的"观测字段"写入，**绝不**触碰 currentNodeId / nodes / status /
 * nextActions / pendingDecision——那些都各有权威 owner（completeCurrentWorkflowNode /
 * failCurrentWorkflowNode / repairCurrentWorkflowNode 等），动它们会拆掉防死循环熔断。
 * 调用方（stream-finalization.ts）应该在拿到权威 reducer 的返回值之后，再用这个函数包一层，
 * 合并进同一次要保存的 snapshot，不单独新开一次 DB 写。
 */
export function attachObservedActivity(
  snapshot: WorkflowSnapshot,
  activity: { phases: WorkflowPhase[]; dominant: WorkflowPhase | null },
): WorkflowSnapshot {
  return {
    ...snapshot,
    context: {
      ...snapshot.context,
      lastObservedActivity: {
        phases: activity.phases,
        dominant: activity.dominant,
        observedAt: new Date().toISOString(),
      },
    },
  };
}

export function attachPlanSourceToWorkflow(args: {
  snapshot: WorkflowSnapshot;
  summary: string;
  source: WorkflowPlanSource;
}): WorkflowSnapshot {
  return {
    ...args.snapshot,
    context: {
      ...args.snapshot.context,
      planSummary: args.summary,
      planSource: args.source,
    },
  };
}

export function attachActiveSkillToWorkflow(args: {
  snapshot: WorkflowSnapshot;
  skill: WorkflowActiveSkill;
}): WorkflowSnapshot {
  return {
    ...args.snapshot,
    context: {
      ...args.snapshot.context,
      activeSkill: args.skill,
    },
  };
}

export function applyTurnIntentDecision(args: {
  snapshot: WorkflowSnapshot;
  decision: TurnIntentDecision;
}): WorkflowSnapshot {
  const { snapshot, decision } = args;
  const intent = decision.patch ? { ...snapshot.intent, ...decision.patch } : snapshot.intent;

  if (decision.action === "pause_run") {
    return { ...snapshot, intent, status: "paused" };
  }

  if (decision.action === "cancel_run") {
    return { ...snapshot, intent, status: "cancelled", pendingDecision: undefined, nextActions: [] };
  }

  if (decision.action === "reject_node") {
    const current = snapshot.nodes.find((node) => node.id === snapshot.currentNodeId);
    if (!current) return { ...snapshot, intent };
    return {
      ...updateNode(snapshot, current.id, { status: "waiting_user" }),
      intent,
      status: "waiting_user",
      pendingDecision: {
        nodeId: current.id,
        kind: "resolve_ambiguity",
        choices: ["modify_run", "restart_phase"],
      },
    };
  }

  if (decision.action === "approve_node" || decision.patch?.executionMode === "execute_directly") {
    return {
      ...setCurrentPhase({ ...snapshot, intent, status: "running", pendingDecision: undefined }, "execute"),
      nextActions: [],
    };
  }

  if (decision.patch?.reviewRequested) {
    return {
      ...setCurrentPhase({ ...snapshot, intent, status: "running", pendingDecision: undefined }, "review"),
      nextActions: [],
    };
  }

  if (decision.patch?.debateRequested) {
    return {
      ...setCurrentPhase({ ...snapshot, intent, status: "running", pendingDecision: undefined }, "debate"),
      nextActions: [],
    };
  }

  if (decision.patch?.verificationRequired && decision.action === "continue_run") {
    return {
      ...setCurrentPhase({ ...snapshot, intent, status: "running", pendingDecision: undefined }, "verify"),
      nextActions: [],
    };
  }

  if (decision.action === "continue_run") {
    if (snapshot.nextActions.length === 1) {
      return {
        ...setCurrentPhase({ ...snapshot, intent, status: "running", pendingDecision: undefined }, snapshot.nextActions[0]!.targetPhase),
        nextActions: [],
      };
    }
    return {
      ...snapshot,
      intent,
      status: "waiting_user",
      pendingDecision: snapshot.nextActions.length > 1
        ? {
            nodeId: snapshot.currentNodeId ?? "workflow",
            kind: "pick_next_step",
            choices: snapshot.nextActions.map((a) => a.id),
          }
        : snapshot.pendingDecision,
    };
  }

  return { ...snapshot, intent };
}

/**
 * Task #9（2026-07-15）：completeCurrentWorkflowNode 算出来的 nextActions/pendingDecision
 * 一直只是数据，没有任何 UI 渲染——用户只能靠打字，再指望 intent classifier（classifyTurnIntentWithJudge）
 * 猜中"这句话对应哪个 next action"，猜错就走错分支或者卡在 waiting_user 里出不去。
 *
 * 这个函数给"用户直接点了某个 nextAction 按钮"这条路径用：actionId 精确匹配
 * snapshot.nextActions 里的某一项，直接按 targetPhase 推进，不经过 LLM 分类器——用户已经
 * 明确点了具体选项，不该有歧义，也不该再让分类器有二次误判的机会。
 *
 * actionId 在 nextActions 里找不到（比如快照已经在别处被推进过、按钮已经陈旧）时原样
 * 返回 snapshot，调用方按"没有变化"处理，不抛错。
 */
export function applyNextActionChoice(args: {
  snapshot: WorkflowSnapshot;
  actionId: string;
}): WorkflowSnapshot {
  const { snapshot, actionId } = args;
  const action = snapshot.nextActions.find((a) => a.id === actionId);
  if (!action) return snapshot;
  return {
    ...setCurrentPhase({ ...snapshot, status: "running", pendingDecision: undefined }, action.targetPhase),
    nextActions: [],
  };
}
