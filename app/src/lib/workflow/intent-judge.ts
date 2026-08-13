import { generateObject } from "ai";
import { z } from "zod";
import type { LanguageModel } from "@/lib/llm/provider-factory";
import { resolveMaxOutputTokens } from "@/lib/llm/model-limits";
import { createAbortScope } from "@/lib/llm/abort-scope";
import { classifyTurnIntent } from "./intent-classifier";
import {
  BUILTIN_INTENT_EXAMPLES,
  buildIntentJudgeContext,
  routeTurnIntentSemantically,
  type IntentExample,
  type IntentRouteAction,
  type SemanticIntentRoute,
} from "./semantic-intent-router";
import type { TurnIntentDecision, WorkflowSnapshot } from "./types";
// 5.1 修复（2026-07-02）：import classifyMessageComplexity 把难度档位合并到
// classifyTurnIntentWithJudge 返回值，message-router.ts 降级为兜底而不是另开一次独立判断。
import { classifyMessageComplexity } from "@/lib/llm/message-router";

const judgeSchema = z.object({
  action: z.enum([
    "answer_only",
    "start_run",
    "continue_run",
    "review",
    "debate",
    "execute",
    "verify",
    "plan",
    "reject_node",
    "pause_run",
    "cancel_run",
  ]),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
  objective: z.string().optional(),
  requestedOutcome: z.string().optional(),
});

type JudgeObject = z.infer<typeof judgeSchema>;

function activeRunSummary(activeRun: WorkflowSnapshot | null): string {
  if (!activeRun) return "当前没有正在推进的工作流。";
  const current = activeRun.nodes.find((n) => n.id === activeRun.currentNodeId);
  const nodes = activeRun.nodes.map((n) => `- ${n.id}/${n.phase}: ${n.status}`).join("\n");
  const next = activeRun.nextActions.length
    ? activeRun.nextActions.map((a) => `- ${a.id}: ${a.targetPhase}`).join("\n")
    : "无候选下一步。";
  return [
    `当前工作流：${activeRun.runId}`,
    `状态：${activeRun.status}`,
    `目标：${activeRun.intent.objective}`,
    `当前节点：${current ? `${current.id}/${current.phase}/${current.status}` : "无"}`,
    `节点：\n${nodes}`,
    `候选下一步：\n${next}`,
  ].join("\n");
}

function toDecision(args: {
  judged: JudgeObject;
  activeRun: WorkflowSnapshot | null;
  recentTurnIds?: string[];
  fallback: TurnIntentDecision;
  text: string;
}): TurnIntentDecision {
  const targetRunId = args.activeRun?.runId ?? null;
  const common = {
    targetRunId,
    confidence: args.judged.confidence,
    reason: args.judged.reason,
    evidenceTurnIds: args.recentTurnIds ?? [],
  };

  switch (args.judged.action) {
    case "cancel_run":
      return { action: "cancel_run", ...common };
    case "pause_run":
      return { action: "pause_run", ...common };
    case "reject_node":
      return { action: "reject_node", ...common };
    case "start_run":
      return {
        action: "start_run",
        ...common,
        targetRunId: null,
        patch: {
          objective: args.judged.objective ?? args.text,
          requestedOutcome: args.judged.requestedOutcome ?? "完成用户当前任务",
          executionMode: "plan_only",
        },
      };
    case "plan":
      return {
        action: args.activeRun ? "continue_run" : "start_run",
        ...common,
        patch: {
          objective: args.judged.objective ?? args.text,
          requestedOutcome: args.judged.requestedOutcome ?? "输出可执行方案",
          executionMode: "plan_only",
        },
      };
    case "review":
      return { action: "continue_run", ...common, patch: { reviewRequested: true } };
    case "debate":
      return { action: "continue_run", ...common, patch: { debateRequested: true } };
    case "execute":
      return {
        action: args.activeRun ? "approve_node" : "start_run",
        ...common,
        patch: {
          objective: args.judged.objective ?? args.text,
          requestedOutcome: args.judged.requestedOutcome ?? "执行用户要求",
          executionMode: "execute_directly",
          debateRequested: false,
          reviewRequested: false,
        },
      };
    case "verify":
      return {
        action: "continue_run",
        ...common,
        patch: { verificationRequired: true },
      };
    case "continue_run":
      return { action: "continue_run", ...common };
    case "answer_only":
      return { action: "answer_only", ...common };
    default:
      return args.fallback;
  }
}

function semanticActionToJudgeObject(
  route: SemanticIntentRoute,
  text: string,
): JudgeObject | null {
  if (route.noMatch || !route.top || route.confidence < 0.64) return null;
  return {
    action: route.top.action,
    confidence: route.confidence,
    reason: `语义样例路由命中 ${route.top.action}：${route.top.matchedExample.explanation}`,
    objective: route.top.action === "start_run" || route.top.action === "plan" || route.top.action === "execute" ? text : undefined,
  };
}

function shouldPreferSemanticFallback(action: IntentRouteAction): boolean {
  return action === "review"
    || action === "debate"
    || action === "execute"
    || action === "verify"
    || action === "start_run"
    || action === "plan"
    || action === "answer_only";
}

export async function judgeTurnIntent(args: {
  model: LanguageModel;
  text: string;
  activeRun: WorkflowSnapshot | null;
  recentTurnIds?: string[];
  semanticRoute?: SemanticIntentRoute;
  abortSignal?: AbortSignal;
}): Promise<JudgeObject> {
  const semanticContext = buildIntentJudgeContext(args.semanticRoute ?? routeTurnIntentSemantically(args.text));
  const abortScope = createAbortScope(args.abortSignal, 30_000);
  try {
    const { object } = await generateObject({
      model: args.model,
      schema: judgeSchema,
      maxOutputTokens: Math.min(resolveMaxOutputTokens(args.model.modelId), 1200),
      abortSignal: abortScope.signal,
      prompt: `你是 CosmGrid 的工作流意图裁判。你只判断用户这句话是否要推进工作流，不回答用户问题。

可选 action：
- answer_only：继续普通对话，不启动/推进工作流。
- start_run：用户要开始一个项目/代码/内容交付任务。
- continue_run：用户要继续当前工作流，但没有指定具体环节。
- plan：进入方案/计划阶段。
- review：让另一个 AI/审查者评估、复核、挑问题。
- debate：需要多方观点、正反方、PK、裁判、多个模型互相挑战。
- execute：开始实现、改代码、创建文件、落地执行。
- verify：跑测试、构建、检查结果、验证是否成功。
- reject_node：用户打回上一结果，要求重来或修改。
- pause_run / cancel_run：暂停或取消当前任务。

判断规则：
- 不要要求用户背关键词。根据语义判断。
- “让另外一个 AI 评估一下 / 找个审查者看看 / 让别的模型复核”通常是 review。
- “让几个模型互相反驳 / 正反方 / PK / 裁判 / 多个方案互相打”才是 debate。
- “继续吧 / 下一步”根据当前工作流候选下一步判断；不确定就 continue_run，低置信度。
- 写公众号、推广文、总结、解释、反馈文章风格，本身不是 debate，也不是 execute，除非用户明确要求保存文件或调用下个环节。
- 如果置信度低于 0.65，宁可 answer_only 或 continue_run，不要乱启动高成本环节。
- 下面的语义样例路由是参考信号，不是最终答案；如果当前 workflow 状态不允许，仍要保守。

${semanticContext}

${activeRunSummary(args.activeRun)}

用户这句话：
${args.text}`,
    });
    return object;
  } catch {
    // 超时/中断/模型错误：不要卡死整轮，降级为普通对话（外层的 classifyTurnIntentWithJudge
    // 也有 try/catch 兜底，这里再兜一层，确保 judgeTurnIntent 永不抛出、永挂起）
    return { action: "answer_only", confidence: 0, reason: "intent judge 超时/失败，降级为普通对话" };
  } finally {
    abortScope.dispose();
  }
}

export async function classifyTurnIntentWithJudge(args: {
  text: string;
  activeRun: WorkflowSnapshot | null;
  recentTurnIds?: string[];
  model?: LanguageModel | null;
  learnedExamples?: IntentExample[];
  abortSignal?: AbortSignal;
}): Promise<TurnIntentDecision> {
  const fallback = classifyTurnIntent(args);
  // 5.1 修复：统一算一次复杂度，所有 return path 都带上
  const complexity = classifyMessageComplexity(args.text) as "simple" | "standard" | "hard";
  if (fallback.action === "cancel_run" || fallback.action === "pause_run") return { ...fallback, complexity };
  const semanticExamples = args.learnedExamples?.length
    ? [...BUILTIN_INTENT_EXAMPLES, ...args.learnedExamples]
    : BUILTIN_INTENT_EXAMPLES;
  const semanticRoute = routeTurnIntentSemantically(args.text, semanticExamples);
  const semanticJudged = semanticActionToJudgeObject(semanticRoute, args.text);
  const semanticDecision = semanticJudged && shouldPreferSemanticFallback(semanticJudged.action)
    ? toDecision({
      judged: semanticJudged,
      activeRun: args.activeRun,
      recentTurnIds: args.recentTurnIds,
      fallback,
      text: args.text,
    })
    : null;
  if (!args.model) return { ...(semanticDecision ?? fallback), complexity, semanticRoute };

  try {
    const judged = await judgeTurnIntent({
      model: args.model,
      text: args.text,
      activeRun: args.activeRun,
      recentTurnIds: args.recentTurnIds,
      semanticRoute,
      abortSignal: args.abortSignal,
    });
    if (judged.confidence < 0.65) return { ...(semanticDecision ?? fallback), complexity, semanticRoute };
    return {
      ...toDecision({
        judged,
        activeRun: args.activeRun,
        recentTurnIds: args.recentTurnIds,
        fallback,
        text: args.text,
      }),
      complexity,
      semanticRoute,
    };
  } catch {
    return { ...fallback, complexity, semanticRoute };
  }
}
