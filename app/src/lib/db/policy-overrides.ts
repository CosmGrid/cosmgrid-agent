/**
 * policy_overrides 表 DAO。
 *
 * 三类 scope（project / global / distribution）共享一张表，靠 (policy_key, scope_level, scope_id) 区分。
 * global scope 用 sentinel `"__global__"` 表达（见 lib/policy/scope-key.ts），无 NULL 列、
 * DAO 用普通 "=" 比较，不踩 SQLite PK NULL 边界。
 *
 * 命名风格跟 lib/db/workspace.ts 一致：namespace object + 入参 object + 显式返回类型。
 * 不依赖 lib/policy/* 的运行时值，只 import type（depcruse L0 状态真相源规则允许）。
 */

import { getDb } from "./connection";
import { now } from "./utils";
import { GLOBAL_SCOPE_ID, keyToScope, scopeToKey, type ScopeLevelLiteral } from "@/lib/policy/scope-key";
import type { PolicyScope } from "@/lib/policy/types";

export interface PolicyOverrideRow {
  policyKey: string;
  scopeLevel: ScopeLevelLiteral;
  scopeId: string;
  /** 解码后的内存 Scope 对象。 */
  scope: PolicyScope;
  valueJson: string;
  builtinVersion: string;
  updatedAt: string;
  updatedBy: string | null;
}

interface DbRow {
  policy_key: string;
  scope_level: string;
  scope_id: string;
  value_json: string;
  builtin_version: string;
  updated_at: string;
  updated_by: string | null;
}

function mapRow(r: DbRow): PolicyOverrideRow {
  const level = r.scope_level as ScopeLevelLiteral;
  return {
    policyKey: r.policy_key,
    scopeLevel: level,
    scopeId: r.scope_id,
    scope: keyToScope(level, r.scope_id),
    valueJson: r.value_json,
    builtinVersion: r.builtin_version,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
  };
}

export const policyOverrides = {
  /** 读一条 override；scope.id 用 sentinel，比较普通 "="。 */
  async get(
    policyKey: string,
    scope: PolicyScope,
  ): Promise<PolicyOverrideRow | null> {
    const { level, id } = scopeToKey(scope);
    const db = await getDb();
    const rows = await db.select<DbRow[]>(
      "SELECT policy_key, scope_level, scope_id, value_json, builtin_version, updated_at, updated_by " +
        "FROM policy_overrides WHERE policy_key = $1 AND scope_level = $2 AND scope_id = $3",
      [policyKey, level, id],
    );
    return rows.length === 0 ? null : mapRow(rows[0]!);
  },

  /** 写一条 override（upsert）；返回写入后的新行快照（含 updatedAt）。 */
  async set(input: {
    policyKey: string;
    scope: PolicyScope;
    valueJson: string;
    builtinVersion: string;
    actor?: string | null;
  }): Promise<PolicyOverrideRow> {
    const { level, id } = scopeToKey(input.scope);
    const db = await getDb();
    await db.execute(
      `INSERT INTO policy_overrides
         (policy_key, scope_level, scope_id, value_json, builtin_version, updated_at, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (policy_key, scope_level, scope_id) DO UPDATE SET
         value_json = excluded.value_json,
         builtin_version = excluded.builtin_version,
         updated_at = excluded.updated_at,
         updated_by = excluded.updated_by`,
      [
        input.policyKey,
        level,
        id,
        input.valueJson,
        input.builtinVersion,
        now(),
        input.actor ?? null,
      ],
    );
    const row = await this.get(input.policyKey, input.scope);
    if (!row) throw new Error(`[policy-overrides] set 后 read 失败：${input.policyKey} ${level}:${id}`);
    return row;
  },

  /** 删一条 scope override；返回是否真的删到了东西。
   *
   * review T-F-4（2026-07-13）修复：原版只 pre-read + DELETE，pre-read 与 DELETE 之间被并发
   * 删时 store.clear 会拿 `before.valueJson` 写 audit "clear"成功，但磁盘上其实早就没了。
   * 修法：DELETE 后再 get 一次确认磁盘真实状态 —— SQLite 单连接几乎不会触发，但接口要老实。
   * 同时保证 store.clear 收到 true 时就 100% 是它真清掉了。*/
  async clear(policyKey: string, scope: PolicyScope): Promise<boolean> {
    const { level, id } = scopeToKey(scope);
    const db = await getDb();
    const before = await this.get(policyKey, scope);
    if (!before) return false;
    await db.execute(
      "DELETE FROM policy_overrides WHERE policy_key = $1 AND scope_level = $2 AND scope_id = $3",
      [policyKey, level, id],
    );
    const after = await this.get(policyKey, scope);
    return after === null;
  },

  /** 删除一条 policy 的全部 scope overrides（用于 reset cascade）。 */
  async clearAllForPolicy(policyKey: string): Promise<PolicyOverrideRow[]> {
    const db = await getDb();
    const before = await this.listByPolicy(policyKey);
    if (before.length === 0) return [];
    await db.execute("DELETE FROM policy_overrides WHERE policy_key = $1", [policyKey]);
    return before;
  },

  /** 列一条 policy 的全部 override（各 scope）。 */
  async listByPolicy(policyKey: string): Promise<PolicyOverrideRow[]> {
    const db = await getDb();
    const rows = await db.select<DbRow[]>(
      "SELECT policy_key, scope_level, scope_id, value_json, builtin_version, updated_at, updated_by " +
        "FROM policy_overrides WHERE policy_key = $1 ORDER BY scope_level, scope_id",
      [policyKey],
    );
    return rows.map(mapRow);
  },

  /** 列全部有 override 的 policyKey（不含 value）。 */
  async listKeysWithOverrides(): Promise<string[]> {
    const db = await getDb();
    const rows = await db.select<Array<{ policy_key: string }>>(
      "SELECT DISTINCT policy_key FROM policy_overrides ORDER BY policy_key",
    );
    return rows.map((r) => r.policy_key);
  },
};

/** 工具：发现 global scope 的 sentinel 不是 "real project id"，防止误读历史脏数据。 */
export function isGlobalScopeId(id: string): boolean {
  return id === GLOBAL_SCOPE_ID;
}
