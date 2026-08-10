// 上下文压缩的"摘要式"补充（v0.9.1 阶段）
//
// 与 `compressHistory` 的关系：
//   - `compressHistory`（context-compressor.ts）做"抽取式裁剪"——直接丢弃早期消息，只留一句
//     "N 条已省略"提示；零成本、零延迟、可预测。
//   - 本文件做"摘要式浓缩"——拿到要被丢弃的早期消息，调用一次 LLM 把它浓缩成结构化摘要
//     （一句概览 + 关键决策 + 已确认事实 + 待解决问题），再把摘要作为一条 system 消息塞回上下文。
//
// 设计纪律（与 `checkpoint-generator.ts` 和 `fabrication-judge.ts` 同一套）：
//   1. 忠实约束：摘要器本身不能幻觉——prompt 明确禁止补充对话里没出现过的内容。
//      宁可漏不可编；和 L8 Harness 的防编造哲学一致。
//   2. 失败一律返回 null，绝不抛错阻断发送——调用方（compressHistoryWithSummary）
//      接到 null 后退回抽取式，保证摘要不可用时体验不比现在差。
//   3. maxOutputTokens 用 resolveMaxOutputTokens 钳住——避免推理型模型的结构化 JSON
//      被截断 → 解析失败。

import { generateObject } from "ai";
import { z } from "zod";
import type { LanguageModel } from "./provider-factory";
import { resolveMaxOutputTokens } from "./model-limits";
import type { ChatMsg } from "./context-compressor";
import { createAbortScope } from "./abort-scope";

/** 单条消息硬截断阈值——避免 dropped 多条长消息堆爆 prompt */
const MAX_DROPPED_MESSAGE_CHARS = 2000;

const historySummarySchema = z.object({
  summary: z.string().max(160).describe("这段对话历史的一句话概览（≤80 字 / ≤160 字符）"),
  keyDecisions: z
    .array(z.string())
    .describe("用户在对话里做出的关键决策 / 约束 / 选择（最重要、最该被后续轮记住的内容）"),
  factsEstablished: z
    .array(z.string())
    .describe("对话里已确认的事实、文件路径、数值、API 名称等具体信息"),
  openThreads: z
    .array(z.string())
    .describe("对话里提出但还没解决 / 还在进行中的问题或任务"),
});

export type HistorySummary = z.infer<typeof historySummarySchema>;

/**
 * 把"将要被丢弃的早期消息"浓缩成结构化摘要。
 *
 * - 失败（生成抛错 / 解析失败 / 输出结构不完整）一律返回 null，调用方退回抽取式
 * - prompt 带忠实约束：只能概括对话里真实出现过的内容，不得补充、不得编造
 * - 历史为空时直接返回 null（没必要调用 LLM）
 */
export async function summarizeDroppedHistory(
  dropped: ChatMsg[],
  model: LanguageModel,
  abortSignal?: AbortSignal,
): Promise<HistorySummary | null> {
  if (dropped.length === 0) return null;

  const transcript = dropped
    .map((m) => {
      const content = typeof m.content === "string" ? m.content : "[多模态内容]";
      // 截断单条消息，避免 prompt 过长——dropped 通常是早期对话，单条不会太长
      const truncated =
        content.length > MAX_DROPPED_MESSAGE_CHARS
          ? `${content.slice(0, MAX_DROPPED_MESSAGE_CHARS)}…`
          : content;
      return `[${m.role}] ${truncated}`;
    })
    .join("\n\n");

  const abortScope = createAbortScope(abortSignal, 30_000);
  try {
    const { object } = await generateObject({
      model,
      schema: historySummarySchema,
      maxOutputTokens: resolveMaxOutputTokens(model.modelId),
      abortSignal: abortScope.signal,
      prompt: `你是一个对话上下文压缩助手。下面是一段将被"丢弃"出上下文窗口的早期对话记录，
你的任务是把它浓缩成结构化摘要，让后续轮次的模型不需要读原始对话也能保留这些关键信息。

**忠实约束（最重要）**：
- 只能概括对话里**真实出现过**的内容——不得补充对话里没出现过的信息
- 不得为了"看起来完整"而编造决策、事实或问题
- 对话里没提到的字段：keyDecisions/factsEstablished/openThreads 留空数组即可
- summary 必须是一句话、≤80 字，不要逐句复述
- keyDecisions 是对话里**用户做出**的决策或明确约束——不是 AI 自己的动作
- factsEstablished 是**具体可验证**的事实（文件路径、数值、API 名、版本号等），不是泛泛描述
- openThreads 是**用户主动提出**但还没收口的问题，不是 AI 自己想到的优化建议

对话记录：
${transcript}`,
    });

    // 二次防御：zod 已经校验过结构，但空字符串/数组全空也算"无信息量"，不如让调用方走抽取式
    if (
      !object.summary.trim() &&
      object.keyDecisions.length === 0 &&
      object.factsEstablished.length === 0 &&
      object.openThreads.length === 0
    ) {
      return null;
    }

    return object;
  } catch {
    // 失败一律返回 null，调用方退回抽取式——绝不抛错阻断发送
    return null;
  } finally {
    abortScope.dispose();
  }
}
