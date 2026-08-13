// 主对话「编排者」——后台滚动判断角色，按角色自动定模型。
//
// 阶段 C（2026-06-25 大改方案）：引入 8 个团队 Role，
// 让 LLM（作为 Leader）一次性输出"激活哪些角色"+"当前哪个角色"，不再做"全部 coding→backend"拐杖。
//
// 病根（产品真北）：主对话现在是"选一个模型一路聊到底"。规划、写代码、测试是不同的活，
// 该用不同的模型，但用户不该手动来回切。
//
// 解法：每轮回答后，用一个便宜模型在后台读对话历史，滚动判断"现在这场对话需要哪些角色上场，
// 以及当前是哪个角色"，并给每个角色定一个最合适的已接入模型。
// 全程折叠回执（一行小字），用户随时手点切换覆盖。
//
// 分层（本文件只管最上面一层）：
//   编排者（这里：定角色）→ pickBestModelWithPerformance（按角色的 workRole 选模型）→ outcome 反馈（已有）
//
// 设计原则（照搬 checkpoint-generator 的哲学）：
//   1. LLM 只规划"角色结构"（不碰具体 modelId）——模型分配交给纯函数 resolveOrchestration，可离线测、可预测
//   2. 失败兜底：解析/调用出错由调用方接住，绝不影响主对话（编排是锦上添花，不是主流程）
//   3. 滚动规划：传入 prevState，让模型在已有角色图上增补/推进，而不是每次从零重排
//   4. activatedRoles = 从 state.nodes 派生（unique set），不单独存字段——避免双源漂移（与 parse-thinking / detect-pseudo-tools 同教训）

import { generateObject } from "ai";
import { z } from "zod";
import type { LanguageModel } from "./provider-factory";
import { resolveMaxOutputTokens } from "./model-limits";
import { buildOrchestratorPlanPrompt } from "./prompts/orchestrator-plan-prompt";
import { detectModelTier, type ScorableModel } from "./model-capabilities";
import { pickBestModelWithRolePerformance, type RolePerformanceScores } from "./model-performance-scoring";
import type { WorkRole } from "../api";
import { ROLE_IDS, type RoleId } from "../roles";

export { ROLE_IDS, type RoleId };

/** 角色 → 用于模型评分的 workRole（复用 model-capabilities 的角色能力分）
 *  - security 暂用 final_review（终审）；runner 暂用 direct_generation（直生成）—— 13 个 workRoles 里没有专门的 terminal/security
 *  - D 阶段扩 project_template_roles 时可重新映射
 */
/**
 * 阶段 F2：8 角色 × Tailwind 文字/背景配色（单一来源）。
 *  - 跨 StatsPage 卡片 + ChainNodeGraph 共享——用户在 chat 看到角色跑完的颜色，stats 里也能对上
 *  - vibe coder 不用记颜色含义，光看色块大小就知道"哪个角色花得多"
 *  - stage 单独给（STAGE_COLOR）、NULL 单独给（UNKNOWN_COLOR），不在 8 角色映射里
 */
export const ROLE_COLOR: Record<RoleId, string> = {
  leader:    "text-primary bg-primary/10 border-primary/20",
  architect: "text-amber-500 bg-amber-500/10 border-amber-500/20",
  frontend:  "text-sky-500 bg-sky-500/10 border-sky-500/20",
  backend:   "text-violet-500 bg-violet-500/10 border-violet-500/20",
  runner:    "text-emerald-500 bg-emerald-500/10 border-emerald-500/20",
  tester:    "text-rose-500 bg-rose-500/10 border-rose-500/20",
  reviewer:  "text-cyan-500 bg-cyan-500/10 border-cyan-500/20",
  security:  "text-red-500 bg-red-500/10 border-red-500/20",
};
/** stage 不是 RoleId（ProjectDetailPage 工作区来源）—— 中性蓝灰 */
export const STAGE_COLOR = "text-slate-400 bg-slate-500/10 border-slate-500/20";
/** NULL roleKind（未分类/旧数据）—— 灰白 */
export const UNKNOWN_COLOR = "text-muted-foreground bg-white/[0.02] border-white/5";

export const ROLE_TO_WORK_ROLE: Record<RoleId, WorkRole> = {
  leader: "main_chat",
  architect: "planning",
  frontend: "frontend",
  backend: "backend",
  runner: "direct_generation",
  tester: "testing",
  reviewer: "review",
  security: "final_review",
};

export type NodeStatus = "planned" | "active" | "done";

export interface OrchestrationNode {
  id: string;
  role: RoleId;
  title: string;
  status: NodeStatus;
  /** 该节点当前绑定的模型 id（编排自动定，或用户手动指定） */
  modelId: string | null;
  /** 用户手动指定过这个节点的模型 → 编排不再自动覆盖（尊重接管） */
  pinned: boolean;
}

/** 落库到 conversations.orchestration 的整体状态 */
export interface OrchestrationState {
  version: number;
  nodes: OrchestrationNode[];
  currentNodeId: string | null;
  updatedAt: string;
  /** watch 图步进后的接力链（不含 leader）。派生自 plan.nodes，按其顺序取前 MAX_CHAIN_LENGTH 个非 leader 角色。
   *  - optional：v2 数据可能无此字段（向后兼容，parseOrchestration 不强制要求）
   *  - 现已用于真实多角色接力执行；ChatPage / chain-runner 会直接消费这条链
   *  - 计算纯函数：computeChain(plan)
   *  - 不可变更新：withChainPlan(state, chain) */
  chainPlan?: RoleId[];
}

/** v2（2026-06-25 阶段 C）：RoleId 方案上线。v1 数据 parseOrchestration 会返回 null（编排是低频临时态，无损重规划）。 */
export const ORCHESTRATION_VERSION = 2;

/**
 * 6.2 修复（2026-07-02）：编排宏观状态（派生字段，不入 schema 避免双源漂移）。
 * - `idle`：state 为 null / 只有 leader 节点 / chainPlan 为空 → 无接力任务，闲着
 * - `chaining`：state 有非 leader 节点且 chainPlan 非空 → 正在/即将接力
 * - `stuck_recoverable`：state 有非 leader 节点但 chainPlan 为空 → 卡死了（prev 还在专业节点，
 *   但 chainPlan 已空，无法接力），下次编排**必须**强制更新覆盖，不能跳过（避免卡死在旧节点）
 *
 * 派生自 nodes / chainPlan / currentNodeId，不入 OrchestrationState 持久化字段，
 * 延续 activatedRoles 那种"派生不单存"的哲学。
 */
export type OrchestrationPhase = "idle" | "chaining" | "stuck_recoverable";

export function derivePhase(state: OrchestrationState | null): OrchestrationPhase {
  if (!state || state.nodes.length === 0) return "idle";
  const hasNonLeaderNodes = state.nodes.some((n) => n.role !== "leader");
  const chainLen = state.chainPlan?.length ?? 0;
  if (hasNonLeaderNodes && chainLen > 0) return "chaining";
  if (hasNonLeaderNodes && chainLen === 0) return "stuck_recoverable";
  return "idle";
}

/**
 * 6.2 修复：判断新 plan 是否值得更新到 orchestrationRef。
 *
 * 关键规则（坑.md 6.2 描述）：
 * - prev=idle + next=idle → true（无事发生，跳过）
 * - prev=chaining + next=idle → false（之前在跑接力，现在没事了，必须更新）
 * - prev=chaining + next=chaining → 看 diff（这块原逻辑由 diffOrchestration 处理）
 * - prev=stuck_recoverable → 一律 false（强制走完整流程，避免卡死）
 * - prev=null + next=anything → false（首次规划必须落库）
 *
 * 新 plan 是否 idle 的判断：chainPlan.length === 0 && nodes.length === 1 && nodes[0].role === "leader"
 */
export function shouldSkipOrchestrationUpdate(
  prev: OrchestrationState | null,
  next: OrchestrationState,
  nextChainPlan: RoleId[],
): boolean {
  // 强制更新场景（绝不能跳过）
  if (!prev) return false; // 首次规划
  const prevPhase = derivePhase(prev);
  if (prevPhase === "stuck_recoverable") return false; // 卡死状态必须恢复
  // next 不是 idle（要切到 chaining/新规划）→ 必须更新
  const nextIsIdle =
    nextChainPlan.length === 0 && next.nodes.length === 1 && next.nodes[0]?.role === "leader";
  if (!nextIsIdle) return false;
  // 双向都 idle：无事发生，可以跳过
  return prevPhase === "idle";
}

/**
 * 阶段 E1：watch 订阅图（硬编码，**不扩 schema**）。
 * 语义：A.watch = [B1, B2, ...] 表示「A 听 B1/B2 的产出」(MetaGPT role.py:410 cause_by∈watch)。
 * 接力顺序由 plan.nodes 数组顺序（LLM 排的 topological）+ watch 图约束共同决定。
 * leader 是起点（watch=[]），不进接力链。
 */
export const ROLE_WATCH_GRAPH: Readonly<Record<RoleId, readonly RoleId[]>> = {
  leader:    [],                                          // 起点
  architect: ["leader"],                                  // 听 leader 的需求
  frontend:  ["architect", "leader"],                     // 听 architect 的方案
  backend:   ["architect", "leader"],                     // 同上
  runner:    ["frontend", "backend"],                     // 写完才能跑
  tester:    ["frontend", "backend", "runner"],           // 跑完才能测
  reviewer:  ["frontend", "backend", "runner", "tester"], // 测完才能审
  security:  ["frontend", "backend", "runner", "tester", "reviewer"],
};

/** 阶段 E1：单次编排最多接力几个后续角色（不含 leader）。
 *  先设 3，跑顺再放 5。E2 真执行时也用此上限——硬封顶不依赖 LLM 是否自觉 */
export const MAX_CHAIN_LENGTH = 3;

/**
 * 纯函数：按 watch 依赖把 plan.nodes 里的角色排成接力链。
 *
 * 设计要点：
 *  - **零 LLM 调用**：plan 来自 planNodes（已跑一次），这里只做确定性排序。
 *  - plan.nodes 提供同级角色的稳定顺序；watch 图负责纠正明显违反依赖的先后关系。
 *  - leader 过滤掉（leader 是对话主，不算被接力的角色）。
 *  - 封顶 MAX_CHAIN_LENGTH：硬上限防失控（token 爆炸、用户重点核①③）。
 *
 * @returns 接力链（不含 leader），最长 MAX_CHAIN_LENGTH；空数组 = 不接力
 */
export function computeChain(plan: OrchestrationPlan): RoleId[] {
  const roles = plan.nodes
    .filter((n) => n.status !== "done")
    .map((n) => n.role)
    .filter((r, idx, arr) => r !== "leader" && arr.indexOf(r) === idx);
  const roleSet = new Set<RoleId>(roles);
  const indegree = new Map<RoleId, number>(roles.map((r) => [r, 0]));
  const dependents = new Map<RoleId, RoleId[]>(roles.map((r) => [r, []]));

  for (const role of roles) {
    const deps = ROLE_WATCH_GRAPH[role].filter((dep) => roleSet.has(dep));
    indegree.set(role, deps.length);
    for (const dep of deps) dependents.get(dep)?.push(role);
  }

  const ready = roles.filter((role) => (indegree.get(role) ?? 0) === 0);
  const ordered: RoleId[] = [];
  while (ready.length > 0) {
    const role = ready.shift()!;
    ordered.push(role);
    for (const next of dependents.get(role) ?? []) {
      const remaining = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) ready.push(next);
    }
  }

  const unresolved = roles.filter((role) => !ordered.includes(role));
  return [...ordered, ...unresolved].slice(0, MAX_CHAIN_LENGTH);
}

/**
 * helper：不可变更新 OrchestrationState 的 chainPlan 字段。
 * resolveOrchestration 只管节点和模型分配；ChatPage 调用方先 resolveOrchestration → computeChain → withChainPlan。
 */
export function withChainPlan(state: OrchestrationState, chainPlan: RoleId[]): OrchestrationState {
  return { ...state, chainPlan };
}

// ============ 阶段 E2b：chain 进度派生（单一来源） ============
//
// 数据流：chainPlan（来自 state.chainPlan，E1）+ executedRoles（E2a runChain 返回的已完成角色）
//        + skippedRoles（无模型可用）+ abortedRole（中止停在的角色）
// 派生 8 角色各自状态 → ChainNodeGraph 渲染。**不另存 state**。
//
// 状态机：
//   "start"     → leader 永远（特殊图标，不参与 chainPlan）
//   "pending"   → chainPlan 里的角色，还没轮到
//   "executing" → chainPlan 里第一个不在 done/skipped/aborted 的角色
//   "done"      → 已在 executedRoles
//   "skipped"   → 在 skippedRoles（无模型可用跳过）
//   "aborted"   → == abortedRole（中止停在）

export type RoleProgressState = "start" | "pending" | "executing" | "done" | "skipped" | "aborted";

export interface ChainProgress {
  /** 8 角色当前状态（key 是 RoleId） */
  states: Record<RoleId, RoleProgressState>;
  /** 已完成（含 aborted 的部分）计数 */
  doneCount: number;
  /** chainPlan 总跳数 */
  totalCount: number;
  /** 当前 executing 的角色（null = chain 已结束或没在跑） */
  executingRole: RoleId | null;
}

export function deriveChainProgress(args: {
  chainPlan: RoleId[];
  executedRoles: RoleId[];
  skippedRoles: RoleId[];
  abortedRole: RoleId | null;
}): ChainProgress {
  const states = {} as Record<RoleId, RoleProgressState>;
  const executedSet = new Set(args.executedRoles);
  const skippedSet = new Set(args.skippedRoles);

  // leader 永远 start
  states.leader = "start";

  // chainPlan 外的角色默认 pending（不参与 chain）
  for (const r of ROLE_IDS) {
    if (r === "leader") continue;
    if (!args.chainPlan.includes(r)) states[r] = "pending";
  }

  // chainPlan 里的角色：done / skipped / aborted / pending / executing
  // 注：leader 即使出现在 chainPlan（理论上不会，computeChain 已过滤）也强制 start
  let executingRole: RoleId | null = null;
  for (const r of args.chainPlan) {
    if (r === "leader") {
      states.leader = "start";
      continue;
    }
    if (executedSet.has(r)) states[r] = "done";
    else if (skippedSet.has(r)) states[r] = "skipped";
    else if (r === args.abortedRole) states[r] = "aborted";
    else if (executingRole === null) {
      states[r] = "executing";
      executingRole = r;
    } else states[r] = "pending";
  }

  const doneCount = args.executedRoles.length;
  return { states, doneCount, totalCount: args.chainPlan.length, executingRole };
}

/** LLM 输出的角色规划（只规划结构，不碰 modelId；不存单独的 activatedRoles，从 nodes 派生） */
const planSchema = z.object({
  currentNodeRole: z.enum(ROLE_IDS).describe("当前对话进行到哪个角色"),
  nodes: z
    .array(
      z.object({
        role: z.enum(ROLE_IDS),
        title: z.string().describe("这个角色在做什么，简短一句，如「搭项目骨架」"),
        status: z.enum(["planned", "active", "done"]),
      }),
    )
    .min(1)
    .describe("本次任务激活的角色列表（不是全员，按 Leader 判断上场的子集），按推进顺序"),
  reason: z.string().describe("为什么这样判断，一句话"),
});

export type OrchestrationPlan = z.infer<typeof planSchema>;

export interface OrchestrationTurn {
  role: "user" | "assistant" | "system";
  content: string;
}

/** 节点最小可分配模型形状（兼容 ModelListItem） */
export type AssignableModel = ScorableModel;

export const ROLE_LABELS: Record<RoleId, string> = {
  leader: "团队 Leader（编排者 / 日常答疑）",
  architect: "方案 / 架构评审",
  frontend: "前端工程师",
  backend: "后端工程师",
  runner: "运行执行员（build / lint / 起服务）",
  tester: "测试工程师",
  reviewer: "审查工程师（代码质量 / 可维护性）",
  security: "安全工程师（密钥 / 注入 / 支付安全）",
};

/**
 * 用一个（便宜的）模型读对话历史，滚动规划上场角色。
 * 只产出角色结构 + 当前角色，不碰模型分配（那是 resolveOrchestration 的纯函数活）。
 * 失败不在此吞掉——调用方负责兜底（编排失败不该影响主对话）。
 */
export async function planNodes(
  languageModel: LanguageModel,
  history: OrchestrationTurn[],
  prevState?: OrchestrationState | null,
): Promise<OrchestrationPlan> {
  const transcript =
    history.length > 0
      ? history.map((m) => `[${m.role}] ${m.content}`).join("\n\n")
      : "（这段对话还没有任何内容）";

  const prevPlan =
    prevState && prevState.nodes.length > 0
      ? prevState.nodes.map((n) => `- [${n.status}] ${n.role}：${n.title}`).join("\n")
      : "（还没有规划过角色，这是第一次）";

  const roleMenu = ROLE_IDS.map((r) => `  - ${r}：${ROLE_LABELS[r]}`).join("\n");

  const { object } = await generateObject({
    model: languageModel,
    schema: planSchema,
    // 按模型真实上限给足预算，避免推理型模型在结构化 JSON 没写完就被截断 → 解析失败
    maxOutputTokens: resolveMaxOutputTokens(languageModel.modelId),
    prompt: buildOrchestratorPlanPrompt({ roleMenu, prevPlan, transcript }),
  });

  return object;
}

let nodeCounter = 0;
function newNodeId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  nodeCounter += 1;
  return `node-${Date.now()}-${nodeCounter}`;
}

/**
 * 纯函数：把 LLM 的角色规划 + 旧状态，合并成新的 OrchestrationState，并给每个角色定模型。
 *
 * 选模型三层优先级（阶段 D 引入 roleBindings，**不破坏 pinned 语义**）：
 *   L1: prevState 用户手动 pin（pinned=true && inherited.modelId） → 永远用，不被任何东西覆盖（铁律：编排绝不覆盖用户手选）
 *   L2: roleBindings[role] 有值且 modelId 在 availableModels → 用绑定（**不标 pinned=true**，pinned 只留给用户手动点节点；绑定每轮从模板重读，改了即时生效又不冒充手选）
 *   L3: 都没命中 → fallback pickBestModelWithPerformance
 *
 * - 按 role 继承旧节点的 id / pinned / modelId（保住用户接管的选择）
 * - currentNodeId 指向 plan.currentNodeRole 对应的节点
 *
 * @param roleBindings 阶段 D 引入：用户在 TemplatesPage 给 8 角色配的模型绑定。workRole=RoleId 直接当 RoleId 用，不做 13 枚举 ↔ 8 角色映射（一列一义）。
 * @param now 注入时间戳便于测试；不传用当前时间
 */
export function resolveOrchestration(
  plan: OrchestrationPlan,
  models: AssignableModel[],
  prevState?: OrchestrationState | null,
  roleBindings?: Map<RoleId, string>,
  rolePerformanceScoresOrNow?: RolePerformanceScores | (() => string),
  nowArg?: () => string,
): OrchestrationState {
  const rolePerformanceScores = typeof rolePerformanceScoresOrNow === "function" ? undefined : rolePerformanceScoresOrNow;
  const now = typeof rolePerformanceScoresOrNow === "function"
    ? rolePerformanceScoresOrNow
    : nowArg ?? (() => new Date().toISOString());
  // 旧节点按 role 分组（同 role 可能多个，逐个消费，先到先继承）
  const prevByRole = new Map<RoleId, OrchestrationNode[]>();
  for (const n of prevState?.nodes ?? []) {
    const arr = prevByRole.get(n.role) ?? [];
    arr.push({ ...n });
    prevByRole.set(n.role, arr);
  }

  const nodes: OrchestrationNode[] = plan.nodes.map((pn) => {
    const inherited = prevByRole.get(pn.role)?.shift();
    const id = inherited?.id ?? newNodeId();
    // pinned 只继承用户手动设的（inherited.pinned），绑定不会把它变 true
    const pinned = inherited?.pinned ?? false;

    // L1: 用户手动 pin → 永远用，不被任何东西覆盖（防倒退：绑定的 modelId 不能覆盖用户在节点手动 pin 的模型）
    if (pinned && inherited?.modelId) {
      return { id, role: pn.role, title: pn.title, status: pn.status, modelId: inherited.modelId, pinned };
    }

    // L2: 用户在 TemplatesPage 给该角色绑了模型 → 用绑定（每轮从模板重读）
    //   - 不标 pinned=true（pinned 只留给用户手动点节点；模板绑定改了即时生效，但不应冒充用户手选）
    //   - 绑定 modelId 必须真的在 availableModels 里（防模板配的模型被删了之后崩）
    const binding = roleBindings?.get(pn.role);
    if (binding && models.some((m) => m.id === binding)) {
      return { id, role: pn.role, title: pn.title, status: pn.status, modelId: binding, pinned: false };
    }

    // L3: 都没命中 → fallback 按角色自动选最合适的（继承旧 modelId 兜底）
    const picked = pickBestModelWithRolePerformance(ROLE_TO_WORK_ROLE[pn.role], pn.role, models, rolePerformanceScores);
    const modelId = picked?.id ?? inherited?.modelId ?? null;
    return { id, role: pn.role, title: pn.title, status: pn.status, modelId, pinned };
  });

  // 当前节点：优先取 currentNodeRole 里状态为 active 的，否则该 role 第一个，否则第一个节点
  const sameRole = nodes.filter((n) => n.role === plan.currentNodeRole);
  const current = sameRole.find((n) => n.status === "active") ?? sameRole[0] ?? nodes[0] ?? null;

  return {
    version: ORCHESTRATION_VERSION,
    nodes,
    currentNodeId: current?.id ?? null,
    updatedAt: now(),
  };
}

/** 派生函数：从 OrchestrationState.nodes 派生"激活了哪些角色"（unique set，按 ROLE_IDS 顺序）—— 单一来源。
 *  下游（D 阶段的 watch 引擎、E 阶段的接力）用这个取代任何独立字段。 */
export function activatedRoles(state: OrchestrationState | null): RoleId[] {
  if (!state) return [];
  const seen = new Set<RoleId>();
  const result: RoleId[] = [];
  for (const r of ROLE_IDS) {
    if (state.nodes.some((n) => n.role === r)) {
      seen.add(r);
      result.push(r);
    }
  }
  return result;
}

/** 取当前节点（找不到返回 null） */
export function currentNode(state: OrchestrationState | null): OrchestrationNode | null {
  if (!state) return null;
  return state.nodes.find((n) => n.id === state.currentNodeId) ?? null;
}

/**
 * 用户手动把某模型指定给「指定节点」→ 钉住该节点（pinned=true），编排后续不再自动覆盖。
 * 可钉任意节点（含还没轮到的 planned 节点）——用户可提前给"下个任务"指定模型。
 * 纯函数，返回新 state（不可变）。
 */
export function pinModelToNode(
  state: OrchestrationState,
  nodeId: string,
  modelId: string,
  now: () => string = () => new Date().toISOString(),
): OrchestrationState {
  return {
    ...state,
    nodes: state.nodes.map((n) => (n.id === nodeId ? { ...n, modelId, pinned: true } : n)),
    updatedAt: now(),
  };
}

/** 钉模型到当前节点（pinModelToNode 的便捷封装） */
export function pinModelToCurrentNode(
  state: OrchestrationState,
  modelId: string,
  now: () => string = () => new Date().toISOString(),
): OrchestrationState {
  if (!state.currentNodeId) return { ...state, updatedAt: now() };
  return pinModelToNode(state, state.currentNodeId, modelId, now);
}

export interface OrchestrationChange {
  /** 是否进入了新节点（当前节点 id 变了） */
  nodeChanged: boolean;
  /** 当前节点绑定的模型是否变了（用于决定要不要自动切 + 写回执） */
  modelChanged: boolean;
  node: OrchestrationNode | null;
  /** 变化前当前节点的模型（用于回执文案） */
  prevModelId: string | null;
}

/**
 * 纯函数：对比新旧状态，告诉 ChatPage「该不该自动切模型 + 写回执」。
 * - 全新状态（prev 为空）且有当前节点 → 算作进入节点
 */
export function diffOrchestration(
  prev: OrchestrationState | null,
  next: OrchestrationState,
): OrchestrationChange {
  const nextNode = currentNode(next);
  const prevNode = currentNode(prev);
  const nodeChanged = (prevNode?.id ?? null) !== (nextNode?.id ?? null);
  const prevModelId = prevNode?.modelId ?? null;
  const modelChanged = prevModelId !== (nextNode?.modelId ?? null);
  return { nodeChanged, modelChanged, node: nextNode, prevModelId };
}

/** 把状态序列化成可落库的 JSON 字符串 */
export function serializeOrchestration(state: OrchestrationState): string {
  return JSON.stringify(state);
}

/** 安全解析落库的 JSON（坏数据/旧版本/null/非 v2 一律返回 null，绝不抛错；v1 数据失效可接受，编排是低频临时态） */
export function parseOrchestration(json: string | null): OrchestrationState | null {
  if (!json) return null;
  try {
    const obj = JSON.parse(json) as unknown;
    if (
      obj &&
      typeof obj === "object" &&
      Array.isArray((obj as OrchestrationState).nodes) &&
      (obj as OrchestrationState).version === ORCHESTRATION_VERSION
    ) {
      // 兜底：v2 数据若缺少 role 字段（旧字段名 kind）也当 null 处理——防落库漂移
      const nodes = (obj as OrchestrationState).nodes;
      if (nodes.some((n: Partial<OrchestrationNode>) => typeof (n as { role?: unknown }).role !== "string")) {
        return null;
      }
      return obj as OrchestrationState;
    }
    return null;
  } catch {
    return null;
  }
}

/** 选一个最省的模型来跑编排（编排是粗活）：优先 fast 档，否则数组第一个 */
export function pickOrchestratorModel<T extends { name: string }>(models: T[]): T | null {
  if (models.length === 0) return null;
  const fast = models.find((m) => detectModelTier(m.name) === "fast");
  return fast ?? models[0]!;
}
