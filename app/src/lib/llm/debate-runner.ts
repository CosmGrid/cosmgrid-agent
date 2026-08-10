// v0.8 阶段5 — 对弈引擎的真实 LLM 执行器
//
// 把 debate-engine 的可注入 RunRole 接到实际模型调用（Vercel AI SDK generateText）+ 落 UsageEvent。
// 用 generateText（非流式）：对弈每个角色是一次性产出，不需要流式中间态。

import { generateObject, generateText } from "ai";
import { z } from "zod";
import { getLanguageModel } from "./provider-factory";
import { resolveMaxOutputTokens } from "./model-limits";
import { recordUsageEvent } from "./usage-tracker";
import { isCliProviderType } from "./cli-protocol";
import { streamViaCli } from "./cli-engine";
import { markModelFailed, markModelSucceeded } from "./model-cooldown";
import { judgeSystemPrompt, parseJudgeDecision, type RunRole, type JudgeRunner, type JudgeDecision } from "./debate-engine";

/** 生产用 RunRole：调真实模型 + 记录用量（role 记成 debate_<角色>，StatsPage 可见对弈成本） */
export const realRunRole: RunRole = async ({ systemPrompt, userPrompt, config, signal }) => {
  let content = "";
  let inputTokens = 0;
  let outputTokens = 0;

  try {
    if (isCliProviderType(config.providerType)) {
      // CLI 引擎路径：把 system+user 合并成一段对话喂给本机 CLI
      const cli = await streamViaCli(
        {
          providerType: config.providerType,
          modelName: config.modelName,
          ...(config.baseUrl ? { program: config.baseUrl } : {}),
          ...(config.workingDirectory ? { workingDirectory: config.workingDirectory } : {}),
        },
        [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        { onDelta: (d) => { content += d; } },
        { signal },
      );
      inputTokens = cli.inputTokens;
      outputTokens = cli.outputTokens;
    } else {
      const lm = getLanguageModel(config.providerType, config.modelName, config.apiKey, config.baseUrl);
      // 按 models.dev 该模型真实输出上限给足预算，避免推理型模型把额度耗在思考、正文被截断
      const res = await generateText({
        model: lm,
        system: systemPrompt,
        prompt: userPrompt,
        maxOutputTokens: resolveMaxOutputTokens(config.modelName),
        abortSignal: signal,
      });
      content = res.text;
      inputTokens = res.usage?.inputTokens ?? 0;
      outputTokens = res.usage?.outputTokens ?? 0;
    }
  } catch (err) {
    // 用户中止：原样抛，让上层按"已停止"处理，不污染成模型错误。
    if ((err as { name?: string })?.name === "AbortError" || signal?.aborted) throw err;
    markModelFailed(config.modelId);
    // 其余失败：带上「哪个模型 / 哪个角色 / 原因」再抛——否则博弈只剩一句 "Load failed"，无从排查。
    const reason = err instanceof Error ? err.message : String(err);
    const tagged = new Error(`模型「${config.modelName}」（${config.role}）调用失败：${reason}`);
    (tagged as { cause?: unknown }).cause = err;
    throw tagged;
  }

  void recordUsageEvent({
    modelId: config.modelId,
    modelName: config.modelName,
    providerType: config.providerType,
    providerId: config.providerId,
    apiCredentialId: config.apiCredentialId,
    role: `debate_${config.role}`,
    usage: { inputTokens, outputTokens },
    finishReason: "stop",
  });

  markModelSucceeded(config.modelId);
  return { content, inputTokens, outputTokens };
};

// ====== 2026-07-09 P8②：production 结构化 Judge runner ======

/** generateObject 的 zod schema：和 parseJudgeDecision 的 JudgeDecision 形状一致 */
const judgeDecisionSchema = z.object({
  approved: z.boolean(),
  feedback: z.array(z.string()),
  finalSolution: z.string(),
});

function dynamicJudgeStructuredUserPrompt(args: {
  topic: string;
  proposalContent: string;
  critiques: { role: string; modelId: string; content: string }[];
}): string {
  const parts = [
    `任务/方案上下文：\n${args.topic}`,
    `\n原方案：\n${args.proposalContent}`,
  ];
  if (args.critiques.length > 0) {
    parts.push("\n反驳 / PK 意见：");
    for (const c of args.critiques) {
      parts.push(`\n## ${c.role} (${c.modelId})\n${c.content}`);
    }
  }
  parts.push("\n请按 system 提示的三步独立判断后返回 JSON。");
  return parts.join("\n");
}

/**
 * production 结构化 JudgeRunner。
 * - API 路径：generateObject + zod schema，严格类型保证。
 * - CLI 路径：直接返 null，调用方走 parseJudgeDecision 旧路径。
 * - 任何异常：返 null（让 debate-engine 兜底到 runRole + parseJudgeDecision）。
 */
export const runJudgeDecisionStructured: JudgeRunner = async ({
  topic,
  proposalContent,
  critiques,
  judgeConfig,
  signal,
}) => {
  // CLI provider 不一定支持 generateObject，直接 fallback
  if (isCliProviderType(judgeConfig.providerType)) {
    return null;
  }

  try {
    const lm = getLanguageModel(
      judgeConfig.providerType,
      judgeConfig.modelName,
      judgeConfig.apiKey,
      judgeConfig.baseUrl,
    );
    const res = await generateObject({
      model: lm,
      schema: judgeDecisionSchema,
      system: judgeSystemPrompt(),
      prompt: dynamicJudgeStructuredUserPrompt({ topic, proposalContent, critiques }),
      maxOutputTokens: resolveMaxOutputTokens(judgeConfig.modelName),
      abortSignal: signal,
    });
    const obj = res.object;
    const decision: JudgeDecision = {
      approved: obj.approved === true,
      feedback: Array.isArray(obj.feedback) ? obj.feedback : [],
      finalSolution: typeof obj.finalSolution === "string" ? obj.finalSolution : "",
    };
    void recordUsageEvent({
      modelId: judgeConfig.modelId,
      modelName: judgeConfig.modelName,
      providerType: judgeConfig.providerType,
      providerId: judgeConfig.providerId,
      apiCredentialId: judgeConfig.apiCredentialId,
      role: "debate_judge_structured",
      usage: {
        inputTokens: res.usage?.inputTokens ?? 0,
        outputTokens: res.usage?.outputTokens ?? 0,
      },
      finishReason: "stop",
    });
    markModelSucceeded(judgeConfig.modelId);
    return decision;
  } catch (err) {
    if ((err as { name?: string })?.name === "AbortError" || signal?.aborted) throw err;
    markModelFailed(judgeConfig.modelId);
    // 返 null 让 debate-engine 兜底到 parseJudgeDecision（不阻断主对话）
    return null;
  }
};

// 复用旧 parser 作为额外的 fallback helper（外部 module 调用方便）
export { parseJudgeDecision };
