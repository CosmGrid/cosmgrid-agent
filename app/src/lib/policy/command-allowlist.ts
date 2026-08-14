/**
 * 引擎化改造方案 §6 阶段 1a：命令白名单引擎化。
 *
 * builtin = command-program-spec.ts 中固定分类程序的键集合。
 * 用户/项目可在 DB override 追加程序名，但未进入分类事实源的名称会 fail closed。
 *
 * 设计关键：
 *   - 合并语义 union：override 在 builtin 基础上累加，永不删除 builtin——黑名单仍走原始
 *     security-invariants 通道，安全底线不被削弱。
 *   - scopesAllowed = ['project', 'global']：distribution 是发布通道内置，用户切不到；
 *     这条策略允许用户/全局两端写，但新增名称仍需经过分类事实源才能执行。
 *   - checkCommand 仍可同步（见 command-safety.ts）；调用方 resolve 一次后把 Set 传进去。
 */

import { z } from "zod";
import type { PolicyDefinition, PolicyScope } from "./types";
import { PolicyStore, policyStore } from "./policy-store";
import { scopeToKey } from "./scope-key";
import { COMMAND_PROGRAM_SPECS } from "./command-program-spec";

/**
 * 内置允许程序（v3.1：补 pip3）。
 *
 * 设计原则（与 command-safety.ts 顶部注释 §1 一致）：
 *   - 分类与 argv grammar 由 command-safety.ts 统一判定；path/network/unsupported 当前阻断。
 *   - 新增程序必须先进入分类事实源并经过 PR 评审，override 不能绕过分类。
 *
 * 引擎化后这条 Set 是 policyDefinition.builtin；用户/项目可通过 DB 追加但不删除。
 */
export const BUILTIN_ALLOWED_PROGRAMS: ReadonlySet<string> = Object.freeze(
  new Set(Object.keys(COMMAND_PROGRAM_SPECS)),
);

/** zod schema：override value_json 必须是 string[]（不允许对象等其它结构）。 */
const allowedProgramsOverrideSchema = z.array(z.string().min(1));

/**
 * 命令白名单策略定义。
 *
 * key 选用 "command.allowed_programs"——通用"domain.field"风格，§5.2 推荐写法。
 * builtinVersion 用 "builtin-2026-07-12"：日后 builtin 增删条目时改这个戳，§5.4 versioning
 * banner 借此判断"用户的 override 是按哪个 builtin 时代并入的"。
 */
export const commandAllowlistPolicy: PolicyDefinition<Set<string>> = {
  key: "command.allowed_programs",
  builtin: new Set(BUILTIN_ALLOWED_PROGRAMS),
  builtinVersion: "builtin-2026-07-16",
  mergeKind: "union",
  scopesAllowed: ["project", "global"], // distribution scope 是发版内置，用户切不到

  parse(raw: string): Set<string> {
    const arr = allowedProgramsOverrideSchema.parse(JSON.parse(raw));
    return new Set(arr);
  },

  merge(builtin: Set<string>, override: Set<string>): Set<string> {
    // union：builtin ∪ override（只增不减，安全姿态不放宽）
    const merged = new Set(builtin);
    for (const p of override) merged.add(p);
    return merged;
  },
};

/**
 * 一次性 resolve：把 builtin 与该项目级 override 合并成一个最终生效的 Set。
 * 装载点：executor-security.ts 在调 checkCommand 之前调用一次。
 *
 * 没项目上下文（项目级 scope 不可用）→ 只看 builtin + 全局 override。
 *
 * `extraPrograms` 是从原始 builtin 升一档给的快捷选项；通常不用，是给 1a 之前的
 * 单测和 fallback 路径用的（不参与生产代码）。
 *
 * `store` 是可选注入点：生产代码不传走单例 `policyStore`；测试可注入 mock。
 *
 * review S-F-05 / T-F-19 修复（2026-07-13）：
 *   - 加 process-lifetime cache（避免每次 executeTool 都走 2 次 DAO）
 *   - Promise.all 并发读 global + project override（原版串行）
 *
 * 缓存失效策略见 §缓存节（下方）。`invalidateAllowlistResolveCache()` 暴露给上层
 * 做"运营侧覆盖写完后立即失效缓存"路径。本期没有 set 写入钩子，下轮迭代加。
 */

/** 工具：把 override value_json 反序列化成 string[]，便于 UI 草稿展示。 */
export function parseAllowedProgramsOverride(raw: string): string[] {
  // 注意：与 commandAllowlistPolicy.parse 不同，这里返回普通数组（UI 草稿编辑用）。
  // commandAllowlistPolicy.parse 返回 Set<string>（runtime merge 用）。
  const data = JSON.parse(raw);
  return allowedProgramsOverrideSchema.parse(data);
}

/** 工具：把 string[] 序列化成 value_json，校验后再写（zod 自动 throw）。 */
export function serializeAllowedProgramsOverride(programs: string[]): string {
  const arr = allowedProgramsOverrideSchema.parse(programs);
  return JSON.stringify(arr);
}

/** 命令白名单策略在 audit / 列表接口里要有个稳定来源标识。 */
export const COMMAND_ALLOWLIST_KEY = commandAllowlistPolicy.key;

/** scope helper，供 UI 写 override 时不用记得 sentinel。 */
export function commandAllowlistGlobalScope(): PolicyScope {
  return { level: "global" };
}

export function commandAllowlistProjectScope(projectId: string): PolicyScope {
  return { level: "project", projectId };
}

// 把 scopeToKey 留一份 re-export，省 UI 端再 import 一次。
export { scopeToKey };

/**
 * 进程级 resolve 缓存（review S-F-05 / T-F-19 修复）。
 *
 * 为什么需要：bash 工具是热路径，runSecurityPrecheck 每次 executeTool 都跑
 * resolveAllowedPrograms —— 没缓存就每次走 2 次 DAO.select，按项目规模放大明显。
 *
 * 失效策略：模块单例 + builtin 版本戳；调用方调一次 invalidateResolveCache() 或
 * 重新调用时一个新 process 重建。production 当前没有 invalidate 钩子（缺事件总线）——
 * 留个函数让未来"运营侧覆盖 store.set 时"主动失效。
 *
 * 替代方案：listener 订阅 policyStore.set，每次写完调用 invalidateResolveCache()。
 * 本期先做"process-lifetime cache + invalidate 函数"，下轮迭代再加订阅。
 */
type ResolveCache<T> = { value: T; version: string };

let allowlistCache: ResolveCache<ReadonlySet<string>> | null = null;

function key(projectId: string | undefined): string {
  return projectId ?? "__no_project__";
}

export function invalidateAllowlistResolveCache(projectId?: string): void {
  if (!projectId) {
    allowlistCache = null;
    return;
  }
  // 单 key 缓存：现在只有一份未 projectId 区分的 cache，简单粗暴全清。
  allowlistCache = null;
}

export async function resolveAllowedPrograms(
  projectId?: string,
  extraPrograms?: ReadonlySet<string>,
  store: PolicyStore = policyStore,
): Promise<ReadonlySet<string>> {
  const builtin = extraPrograms ?? BUILTIN_ALLOWED_PROGRAMS;
  // 缓存：相同 builtin + 相同 projectId + 同 store 时直接返回（resolve 内已 freeze）。
  if (!extraPrograms && allowlistCache && allowlistCache.version === key(projectId)) {
    return Object.isFrozen(allowlistCache.value)
      ? allowlistCache.value
      : Object.freeze(allowlistCache.value);
  }

  const projectScope: PolicyScope | null = projectId
    ? { level: "project", projectId }
    : null;

  // 并发读 global + project override（review S-F-05 修复：原版串行 2 次 DAO）。
  const [globalOverrideJson, projectOverrideJson] = await Promise.all([
    store.get(commandAllowlistPolicy.key, { level: "global" }),
    projectScope ? store.get(commandAllowlistPolicy.key, projectScope) : Promise.resolve(null),
  ]);

  const merged = new Set<string>(builtin);
  if (globalOverrideJson) {
    const arr = commandAllowlistPolicy.parse(globalOverrideJson);
    for (const p of arr) merged.add(p);
  }
  if (projectOverrideJson) {
    const arr = commandAllowlistPolicy.parse(projectOverrideJson);
    for (const p of arr) merged.add(p);
  }
  const frozen = Object.freeze(merged);
  // 缓存写：仅在不带 extraPrograms（生产路径）时缓存。
  if (!extraPrograms) {
    allowlistCache = { value: frozen, version: key(projectId) };
  }
  return frozen;
}

// 把旧的同步 resolveAllowedPrograms 替换为可缓存版本（alias 保留方便其它文件 import）
// —— 实际上是覆盖，所以这个 export 等于上面那个 export。删除会导致编译失败，
// 所以重新 export 时去掉重复：
// （JS 不允许重复 export const 同名，删去重复由模块顶部 export 完成）
