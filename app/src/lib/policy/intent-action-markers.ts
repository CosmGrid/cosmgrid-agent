/**
 * 引擎化改造方案 §6 阶段 2：意图关键词表 ACTION_MARKERS 引擎化。
 *
 * 原位置：src/lib/workflow/semantic-intent-router.ts:197
 *
 * 设计要点：
 *   - 关键词这一端补 DB 通道（F3 修正：与 BUILTIN_INTENT_EXAMPLES 协同，分值 0.24 上限）
 *   - scopesAllowed = ['distribution']：运营侧 K2 通道可调；不暴露用户配置面（§4.1 P1）
 *   - mergeKind = 'override'：distribution override 直接替换 builtin（同语义层覆盖）
 */

import { z } from "zod";
import type { PolicyDefinition, PolicyScope } from "./types";
import { PolicyStore, policyStore } from "./policy-store";

export const BUILTIN_ACTION_MARKERS = {
  answer_only: ["解释", "说明", "润色", "改自然", "太硬", "继续写", "文案", "软文", "啥意思"],
  start_run: ["盘查", "分析项目", "读取项目", "理解项目", "写一篇", "完整了解", "仓库"],
  continue_run: ["继续", "下一步", "接着", "go on", "continue", "next"],
  plan: ["方案", "计划", "规划", "路线", "架构", "proposal", "plan"],
  review: ["评估", "评审", "审查", "复核", "挑问题", "另一个 ai", "另外一个 ai", "别的模型", "看看方案"],
  debate: ["互相反驳", "裁判", "正方", "反方", "pk", "PK", "博弈", "对弈", "辩论", "多个模型"],
  execute: ["改代码", "实现", "落地", "开始改", "按这个方案", "直接做", "执行"],
  verify: ["测试", "验证", "构建", "检查", "build", "test", "verify", "typecheck"],
  reject_node: ["不对", "不是这个", "重来", "打回", "改一下", "reject", "redo"],
  pause_run: ["暂停", "先停", "等一下", "pause", "hold"],
  cancel_run: ["取消", "算了", "不要继续", "cancel", "停止这个任务"],
} as const satisfies Record<string, string[]>;

const actionMarkersOverrideSchema = z.record(z.string(), z.array(z.string().min(1)));

export const intentActionMarkersPolicy: PolicyDefinition<Record<string, string[]>> = {
  key: "intent.action_markers",
  builtin: { ...BUILTIN_ACTION_MARKERS },
  builtinVersion: "builtin-2026-07-12",
  mergeKind: "override",
  scopesAllowed: ["distribution"],

  parse(raw: string): Record<string, string[]> {
    const obj = JSON.parse(raw);
    return actionMarkersOverrideSchema.parse(obj);
  },

  merge(builtin: Record<string, string[]>, override: Record<string, string[]>): Record<string, string[]> {
    // distribution 是发布通道：override 直接覆盖 builtin（F3 协同权重的关键词端）
    return { ...builtin, ...override };
  },
};

/** 装载点：semantic-intent-router.ts 的 markerScore 一次性 resolve 后缓存。 */
export async function resolveIntentActionMarkers(
  store: PolicyStore = policyStore,
): Promise<Record<string, ReadonlyArray<string>>> {
  const scope: PolicyScope = { level: "distribution", channel: "stable" };
  const json = await store.get(intentActionMarkersPolicy.key, scope);
  if (json) {
    return intentActionMarkersPolicy.parse(json);
  }
  return BUILTIN_ACTION_MARKERS;
}

export const INTENT_ACTION_MARKERS_KEY = intentActionMarkersPolicy.key;
