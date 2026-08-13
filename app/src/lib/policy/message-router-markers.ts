/**
 * 引擎化改造方案 §6 阶段 2：消息难度分级标记词表。
 *
 * 原位置：src/lib/llm/message-router.ts:19, 27
 *
 * 两条独立 marker 列表（hard / simple）共用一个 key + scope 设置。
 * scope = ['distribution']：运营侧可调（K2），不开用户配置面。
 */

import { z } from "zod";
import type { PolicyDefinition, PolicyScope } from "./types";
import { PolicyStore, policyStore } from "./policy-store";

export const BUILTIN_HARD_MARKERS: ReadonlyArray<string> = [
  "架构", "设计", "重构", "调试", "排查", "为什么", "方案", "优化", "算法",
  "分析", "审查", "规划", "梳理", "怎么实现", "如何实现", "性能",
  "architecture", "design", "refactor", "debug", "optimize", "algorithm",
  "analyze", "review", "why ", "how should", "trade-off", "tradeoff",
];

export const BUILTIN_SIMPLE_MARKERS: ReadonlyArray<string> = [
  "翻译", "改名", "重命名", "格式化", "标点", "总结一下", "什么意思", "改个", "润色", "纠错",
  "translate", "rename", "format", "typo", "summarize", "what does", "what is the meaning",
  // 寒暄 / 确认类
  "你好", "您好", "嗨", "谢谢", "多谢", "好的", "在吗", "在不在",
  "hi", "hello", "thanks", "thank you", "ok", "okay",
];

export interface MessageRouterMarkers {
  hard: ReadonlyArray<string>;
  simple: ReadonlyArray<string>;
}

const overrideSchema = z.object({
  hard: z.array(z.string().min(1)),
  simple: z.array(z.string().min(1)),
});

export const messageRouterMarkersPolicy: PolicyDefinition<MessageRouterMarkers> = {
  key: "message.router.markers",
  builtin: { hard: BUILTIN_HARD_MARKERS, simple: BUILTIN_SIMPLE_MARKERS },
  builtinVersion: "builtin-2026-07-12",
  mergeKind: "override",
  scopesAllowed: ["distribution"],

  parse(raw: string): MessageRouterMarkers {
    const obj = JSON.parse(raw);
    return overrideSchema.parse(obj);
  },

  merge(builtin: MessageRouterMarkers, override: MessageRouterMarkers): MessageRouterMarkers {
    // distribution channel 是发布通道内置参数，覆盖语义：
    // 用户传 hard：[a,b] 时，整段替换 builtin；保留 builtin 也无意义（marker 是 disjunction）。
    // 我们仍然记下 builtin 形态，便于追查前后版本变化。
    return {
      hard: override.hard.length > 0 ? [...override.hard] : [...builtin.hard],
      simple: override.simple.length > 0 ? [...override.simple] : [...builtin.simple],
    };
  },
};

/** 装载点：message-router.ts 在模块初始化时一次性 resolve 后缓存。 */
export async function resolveMessageRouterMarkers(
  store: PolicyStore = policyStore,
): Promise<MessageRouterMarkers> {
  const scope: PolicyScope = { level: "distribution", channel: "stable" };
  const json = await store.get(messageRouterMarkersPolicy.key, scope);
  if (json) return messageRouterMarkersPolicy.parse(json);
  return { hard: BUILTIN_HARD_MARKERS, simple: BUILTIN_SIMPLE_MARKERS };
}

export const MESSAGE_ROUTER_MARKERS_KEY = messageRouterMarkersPolicy.key;
