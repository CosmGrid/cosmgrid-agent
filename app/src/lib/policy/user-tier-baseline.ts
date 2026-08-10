/**
 * 引擎化改造方案 §6 阶段 3：USER_TIER_BASELINE 引擎化。
 *
 * 原位置：src/lib/llm/user-tier-baseline.ts:20
 *
 * §4.1 P2：纯 UX 评分兜底。真表现数据（model_performance_stats）覆盖时
 * pickBestModelWithPerformance 走真值，但 builtin 仍然是冷启动的兜底依据。
 * scope = ['distribution']：可被发布/开发通道覆盖（"运营侧可调"），不开用户 UI。
 */

import { z } from "zod";
import type { PolicyDefinition, PolicyScope } from "./types";
import { PolicyStore, policyStore } from "./policy-store";

export interface UserTierEntry {
  aliases: string[];
  score: number;
  strongRoles: string[];
}

export const BUILTIN_USER_TIER_BASELINE: ReadonlyArray<UserTierEntry> = Object.freeze([
  {
    aliases: ["opus-4-8", "opus4.8", "opus 4.8", "opus-4.8", "claude-opus-4-8"],
    score: 95,
    strongRoles: ["planning", "main_chat", "review", "final_review", "backend", "frontend", "testing", "ios", "android", "direct_generation", "general"],
  },
  {
    aliases: ["gpt5.5", "gpt-5.5", "gpt 5.5", "gpt-5"],
    score: 92,
    strongRoles: ["planning", "main_chat", "review", "final_review", "backend", "frontend", "testing", "ios", "android", "direct_generation", "general"],
  },
  {
    aliases: ["gemini3.1", "gemini-3.1", "gemini 3.1", "gemini-3"],
    score: 86,
    strongRoles: ["planning", "main_chat", "frontend"],
  },
  {
    aliases: ["glm5.2", "gml5.2", "glm-5.2", "glm 5.2", "glm5.2"],
    score: 85,
    strongRoles: ["backend", "testing", "review", "final_review"],
  },
  {
    aliases: ["deepseek-v4", "deepseek v4", "deepseekv4", "deepseek"],
    score: 80,
    strongRoles: ["backend", "testing"],
  },
  {
    aliases: ["kimi-2.7", "kimi2.7", "kimi 2.7", "kimi"],
    score: 76,
    strongRoles: ["planning", "main_chat", "backend", "review"],
  },
  {
    aliases: ["minimax-m3", "minimax m3", "minimaxm3", "m3"],
    score: 70,
    strongRoles: ["backend", "review"],
  },
  {
    aliases: ["qwen3.7", "qwen 3.7", "qwen-3.7", "qwen3"],
    score: 70,
    strongRoles: [],
  },
  {
    aliases: ["minimax-m2.5", "minimax m2.5", "m2.5"],
    score: 55,
    strongRoles: ["backend"],
  },
  {
    aliases: ["glm-5", "glm5", "glm 5"],
    score: 61,
    strongRoles: ["backend"],
  },
  {
    aliases: ["agnes", "agnes-ai", "agnes ai"],
    score: 60,
    strongRoles: [],
  },
]);

const userTierBaselineOverrideSchema = z.array(
  z.object({
    aliases: z.array(z.string().min(1)),
    score: z.number().int().min(0).max(100),
    strongRoles: z.array(z.string()),
  }),
);

export const userTierBaselinePolicy: PolicyDefinition<ReadonlyArray<UserTierEntry>> = {
  key: "model.user_tier_baseline",
  builtin: BUILTIN_USER_TIER_BASELINE,
  builtinVersion: "builtin-2026-07-12",
  mergeKind: "override",
  scopesAllowed: ["distribution"],

  parse(raw: string): ReadonlyArray<UserTierEntry> {
    return userTierBaselineOverrideSchema.parse(JSON.parse(raw));
  },

  merge(
    builtin: ReadonlyArray<UserTierEntry>,
    override: ReadonlyArray<UserTierEntry>,
  ): ReadonlyArray<UserTierEntry> {
    return override.length > 0 ? override : builtin;
  },
};

export async function resolveUserTierBaseline(
  store: PolicyStore = policyStore,
): Promise<ReadonlyArray<UserTierEntry>> {
  const scope: PolicyScope = { level: "distribution", channel: "stable" };
  const json = await store.get(userTierBaselinePolicy.key, scope);
  if (json) return userTierBaselinePolicy.parse(json);
  return BUILTIN_USER_TIER_BASELINE;
}

/**
 * 模块级生效缓存：默认 = builtin；hydrate 后并入 distribution override。
 * scoreByUserBaseline（同步消费方）读它，保持同步签名。未 hydrate / 失败时兜底 builtin。
 */
let activeBaseline: ReadonlyArray<UserTierEntry> = BUILTIN_USER_TIER_BASELINE;
let userTierHydrated = false;

/** 启动时调用一次（chat-fallback 入口）；幂等，distribution override 缺失时保持 builtin。 */
export async function hydrateUserTierBaseline(store: PolicyStore = policyStore): Promise<void> {
  if (userTierHydrated) return;
  activeBaseline = await resolveUserTierBaseline(store);
  userTierHydrated = true;
}

/** 单测复位用。 */
export function _resetUserTierHydration(): void {
  activeBaseline = BUILTIN_USER_TIER_BASELINE;
  userTierHydrated = false;
}

/**
 * 按 builtin 表给模型在某角色的分。
 * 兼容老 API 形态：null = 模型不在表，调用方 fallback 名字查表。
 */
export function scoreByUserBaseline(modelName: string, role: string): number | null {
  const lower = modelName.toLowerCase();
  const entry = activeBaseline.find((e) => e.aliases.some((a) => lower.includes(a)));
  if (!entry) return null;
  if (entry.strongRoles.length === 0) return Math.round(entry.score * 0.6);
  if (entry.strongRoles.includes(role)) return entry.score;
  return Math.round(entry.score * 0.6);
}

export const USER_TIER_BASELINE_KEY = userTierBaselinePolicy.key;
