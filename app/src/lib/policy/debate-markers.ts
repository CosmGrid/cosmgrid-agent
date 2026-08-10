/**
 * 引擎化改造方案 §6 阶段 3：DEBATE_MARKERS 引擎化。
 *
 * 原位置：src/lib/llm/debate-suggester.ts:9
 *
 * §4.1 P2：UX-only marker 列表。scope = ['distribution']：可被覆盖；不开 UI。
 *
 * "对比 + 权衡 + 选哪个" 这一类上下文开放式问题才建议对弈，比 HARD_MARKERS 更窄。
 */

import { z } from "zod";
import type { PolicyDefinition, PolicyScope } from "./types";
import { PolicyStore, policyStore } from "./policy-store";

export const BUILTIN_DEBATE_MARKERS: ReadonlyArray<string> = Object.freeze([
  "架构", "技术选型", "选型", "方案", "对比", "权衡", "利弊", "优劣",
  "哪个更好", "哪个好", "选哪个", "该用", "用哪个", "要不要", "值不值得",
  "怎么设计", "如何设计", "设计思路", "取舍", "划算",
  "architecture", "trade-off", "tradeoff", "pros and cons", "which is better",
  "should i use", "should we use", "compare", " versus ", " vs ", "better choice",
]);

const debateMarkersOverrideSchema = z.array(z.string().min(1));

export const debateMarkersPolicy: PolicyDefinition<ReadonlyArray<string>> = {
  key: "llm.debate_markers",
  builtin: BUILTIN_DEBATE_MARKERS,
  builtinVersion: "builtin-2026-07-12",
  mergeKind: "override",
  scopesAllowed: ["distribution"],

  parse(raw: string): ReadonlyArray<string> {
    return debateMarkersOverrideSchema.parse(JSON.parse(raw));
  },

  merge(
    builtin: ReadonlyArray<string>,
    override: ReadonlyArray<string>,
  ): ReadonlyArray<string> {
    return override.length > 0 ? override : builtin;
  },
};

/** 装载点：debate-suggester.ts 模块初始化时一次性 resolve（cached）。
 *
 * review T-F-8（2026-07-13）修复：原版缓存永不过期 — 测试无法注入新 store 验证 override
 * 路径；生产 distribution 覆盖在不重启进程的前提下不生效。改：缓存按 (store identity, version)
 * 维度 keyed，加 invalidateDebateMarkersCache() 函数 + set/clear/reset 时同步失效
 * （将来加订阅机制更优雅，本期先暴露手动失效钩子）。*/
let cachedDebateMarkers: ReadonlyArray<string> | null = null;
/** 用 store identity + policyStore 单例身份作为 cache key —— 测试用不同 store 时不命中。 */
let cachedDebateStoreIdentity: symbol | null = null;

export function invalidateDebateMarkersCache(): void {
  cachedDebateMarkers = null;
  cachedDebateStoreIdentity = null;
}

export async function resolveDebateMarkers(
  store: PolicyStore = policyStore,
): Promise<ReadonlyArray<string>> {
  const storeId = (store as { __debateCacheKey?: symbol }).__debateCacheKey
    ?? Symbol("default-policyStore");
  if (cachedDebateMarkers && cachedDebateStoreIdentity === storeId) return cachedDebateMarkers;
  const scope: PolicyScope = { level: "distribution", channel: "stable" };
  const json = await store.get(debateMarkersPolicy.key, scope);
  cachedDebateMarkers = json
    ? debateMarkersPolicy.parse(json)
    : BUILTIN_DEBATE_MARKERS;
  cachedDebateStoreIdentity = storeId;
  return cachedDebateMarkers;
}

/** 同步路径：模型内置候选优先走 builtin；UI 不接就拿 builtin。 */
export function builtinDebateMarkers(): ReadonlyArray<string> {
  return BUILTIN_DEBATE_MARKERS;
}

/**
 * 模块级生效缓存：默认 = builtin；hydrate 后并入 distribution override。
 * shouldSuggestDebate（同步消费方）通过 getDebateMarkers() 读它，保持同步。
 */
let activeDebateMarkers: ReadonlyArray<string> = BUILTIN_DEBATE_MARKERS;
let debateHydrated = false;

/** 启动时调用一次（chat-fallback 入口）；幂等，复用 resolveDebateMarkers 的 distribution 读取。 */
export async function hydrateDebateMarkers(store: PolicyStore = policyStore): Promise<void> {
  if (debateHydrated) return;
  activeDebateMarkers = await resolveDebateMarkers(store);
  debateHydrated = true;
}

/** 同步 getter：消费方读当前生效 marker（hydrate 后含 distribution override，否则 builtin）。 */
export function getDebateMarkers(): ReadonlyArray<string> {
  return activeDebateMarkers;
}

/** 单测复位用。 */
export function _resetDebateHydration(): void {
  activeDebateMarkers = BUILTIN_DEBATE_MARKERS;
  debateHydrated = false;
  invalidateDebateMarkersCache();
}

export const DEBATE_MARKERS_KEY = debateMarkersPolicy.key;
