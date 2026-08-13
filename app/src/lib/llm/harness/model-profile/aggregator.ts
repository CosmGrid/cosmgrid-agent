// Harness 工程实施计划 阶段6 — Aggregator（聚合模型弱点 → 建议 profile event）。
//
// `aggregateModelWeakness`：拉 eval + 生产失败数据，统计每类 FailureKind 的 frequency + confidence，
// 频率 > 阈值（默认 0.3）的 FailureKind 输出 WeaknessEntry。
//
// 关键不变量：
// - 第一版"只生成不启用"：aggregator 输出 WeaknessReport，caller 决定是否写 profile event
// - 已存在的 enabled event 不重复建议（existingEventKeys 查重）
// - sample_count < minSamples（默认 5）的不进 aggregator（统计无意义）

import { modelHarnessProfileEvents, type TaskOutcomeValue } from "@/lib/db";
import type { FailureKind, AdaptationRule, WeaknessReport, WeaknessEntry } from "./types";
import {
  failureKindFromEvalResult,
  failureKindFromTaskOutcome,
  failureKindFromToolResult,
} from "./failure-taxonomy";

export interface AggregateModelWeaknessInput {
  modelId: string | null;
  modelName: string;
  sinceIso?: string;
  minSamples?: number;
  frequencyThreshold?: number;
  evalFailureCounts?: Record<string, number>;
  taskOutcomeCounts?: Partial<Record<TaskOutcomeValue, number>>;
  toolErrorCounts?: Record<string, number>;
}

const DEFAULT_MIN_SAMPLES = 5;
const DEFAULT_FREQUENCY_THRESHOLD = 0.3;

export async function aggregateModelWeakness(
  input: AggregateModelWeaknessInput,
): Promise<WeaknessReport> {
  const minSamples = input.minSamples ?? DEFAULT_MIN_SAMPLES;
  const frequencyThreshold = input.frequencyThreshold ?? DEFAULT_FREQUENCY_THRESHOLD;
  // 1. 拉已存在的 enabled event key（modelName + failureKind）—— 避免重复建议
  const existingEventKeys = new Set<string>();
  for (const failureKind of ALL_FAILURE_KINDS) {
    const events = await modelHarnessProfileEvents.listEnabledByFailureKind(failureKind, input.modelName);
    for (const evt of events) {
      existingEventKeys.add(`${evt.failureKind}::${input.modelName}`);
    }
  }

  const counts = emptyFailureCounts();
  addEvalFailureCounts(counts, input.evalFailureCounts ?? {});
  addTaskOutcomeCounts(counts, input.taskOutcomeCounts ?? {});
  addToolErrorCounts(counts, input.toolErrorCounts ?? {});

  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  const entries: WeaknessEntry[] = [];
  if (total >= minSamples) {
    for (const failureKind of ALL_FAILURE_KINDS) {
      const sampleCount = counts[failureKind];
      if (sampleCount <= 0) continue;
      if (existingEventKeys.has(`${failureKind}::${input.modelName}`)) continue;
      const frequency = sampleCount / total;
      if (frequency < frequencyThreshold) continue;
      entries.push({
        failureKind,
        frequency,
        confidence: Math.min(0.95, 0.5 + frequency / 2),
        sampleCount,
        suggestedAdaptation: suggestAdaptationFor(failureKind),
      });
    }
  }

  return {
    modelId: input.modelId,
    modelName: input.modelName,
    generatedAt: new Date().toISOString(),
    entries,
    existingEventKeys,
  };
}

const ALL_FAILURE_KINDS: FailureKind[] = [
  "no_tool_completion", "partial_fabrication", "invalid_tool_args", "repeated_tool_call",
  "context_overflow", "premature_completion", "invalid_structured_output",
  "rate_limit", "session_limit", "stale_context",
];

function emptyFailureCounts(): Record<FailureKind, number> {
  return {
    no_tool_completion: 0, partial_fabrication: 0, invalid_tool_args: 0, repeated_tool_call: 0,
    context_overflow: 0, premature_completion: 0, invalid_structured_output: 0,
    rate_limit: 0, session_limit: 0, stale_context: 0,
  };
}

function increment(counts: Record<FailureKind, number>, failureKind: FailureKind, count: number): void {
  counts[failureKind] += Math.max(0, count);
}

function addEvalFailureCounts(counts: Record<FailureKind, number>, input: Record<string, number>): void {
  for (const [failureCode, count] of Object.entries(input)) {
    increment(counts, failureKindFromEvalResult({ passed: false, failureCode }), count);
  }
}

function addTaskOutcomeCounts(
  counts: Record<FailureKind, number>,
  input: Partial<Record<TaskOutcomeValue, number>>,
): void {
  for (const [outcome, count] of Object.entries(input)) {
    increment(
      counts,
      failureKindFromTaskOutcome({ outcome: outcome as TaskOutcomeValue, interventionKind: null }),
      count ?? 0,
    );
  }
}

function addToolErrorCounts(counts: Record<FailureKind, number>, input: Record<string, number>): void {
  for (const [errorCode, count] of Object.entries(input)) {
    increment(counts, failureKindFromToolResult({ toolName: "", status: "error", errorCode }), count);
  }
}

/** 工具：根据 frequency + confidence 生成默认 AdaptationRule */
export function suggestAdaptationFor(failureKind: FailureKind): AdaptationRule {
  switch (failureKind) {
    case "no_tool_completion":
      return {
        kind: "skill_instruction",
        content: "在做出'已完成'类结论前，必须至少调用一次工具；不要凭空说'已检查'。",
        tags: ["harness_v2", "no_tool_completion"],
      };
    case "partial_fabrication":
      return {
        kind: "tool_result_format_hint",
        templateKey: "evidence_grounded",
        snippet: "声称具体执行结果时，必须引用 tool_execution id 或 artifact 路径作为证据。",
      };
    case "invalid_tool_args":
      return {
        kind: "retry_policy_override",
        maxRetries: 1,
      };
    case "repeated_tool_call":
      return {
        kind: "tool_description_override",
        toolName: "bash",
        descriptionOverride:
          "执行命令前先确认命令格式（参数顺序、引号、路径）。如失败一次应换思路，不要原样重试。",
      };
    case "context_overflow":
      return {
        kind: "retry_policy_override",
        maxContextOverflowRetries: 2,
      };
    case "premature_completion":
      return {
        kind: "skill_instruction",
        content: "若本轮没有任何工具调用且任务未真正完成，请明确说'还需要 X 步骤'，不要用'已通过'等措辞。",
        tags: ["premature_completion"],
      };
    case "invalid_structured_output":
      return {
        kind: "tool_result_format_hint",
        templateKey: "structured_recovery",
        snippet: "工具返回结构化失败时，先 describe 一遍调用参数 + 期望输出格式再重试，不要盲改。",
      };
    case "rate_limit":
      return {
        kind: "skill_instruction",
        content: "遇到 429 限流时立即停手，让调用方切 fallback 模型，不要原地反复重试。",
        tags: ["rate_limit"],
      };
    case "session_limit":
      return {
        kind: "skill_instruction",
        content: "CLI session 耗尽时，让调用方放弃该 session 切 fallback，不要续接。",
        tags: ["session_limit"],
      };
    case "stale_context":
      return {
        kind: "skill_instruction",
        content: "跨模型 handoff 后先验证上下文完整，不要假设旧模型的承诺仍然成立。",
        tags: ["stale_context"],
      };
  }
}
