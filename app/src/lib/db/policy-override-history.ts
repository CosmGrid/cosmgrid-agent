/**
 * policy_override_history 审计表 DAO。
 *
 * 写入策略：policyStore.set/clear/reset 在 mutate policy_overrides 的同时把动作记到 history，
 * 便于事后回查"用户改坏了链路"的根因（§5.4 R4 审计）。
 *
 * 不在此做去重/聚合；history 表是有序追加的事实流，UI 想聚合再单独读。
 */

import { getDb } from "./connection";
import { now } from "./utils";
import { keyToScope, scopeToKey, type ScopeLevelLiteral } from "@/lib/policy/scope-key";
import type { PolicyScope } from "@/lib/policy/types";

export type HistoryAction = "set" | "clear" | "bulk_clear";

export interface PolicyOverrideHistoryRow {
  id: string;
  policyKey: string;
  scopeLevel: ScopeLevelLiteral;
  scopeId: string;
  /** 解码后的内存 Scope。 */
  scope: PolicyScope;
  action: HistoryAction;
  oldValueJson: string | null;
  newValueJson: string | null;
  actor: string | null;
  at: string;
}

interface DbRow {
  id: string;
  policy_key: string;
  scope_level: string;
  scope_id: string;
  action: string;
  old_value_json: string | null;
  new_value_json: string | null;
  actor: string | null;
  at: string;
}

function mapRow(r: DbRow): PolicyOverrideHistoryRow {
  const level = r.scope_level as ScopeLevelLiteral;
  return {
    id: r.id,
    policyKey: r.policy_key,
    scopeLevel: level,
    scopeId: r.scope_id,
    scope: keyToScope(level, r.scope_id),
    action: r.action as HistoryAction,
    oldValueJson: r.old_value_json,
    newValueJson: r.new_value_json,
    actor: r.actor,
    at: r.at,
  };
}

export const policyOverrideHistory = {
  /**
   * 记一条审计事件。id 用时间戳 + 随机后缀的 UUID（newId 太纯，
   * 同一秒多事件会撞 PK，这里用 crypto.randomUUID 把概率压到 ~0）。
   */
  async record(input: {
    policyKey: string;
    scope: PolicyScope;
    action: HistoryAction;
    oldValueJson?: string | null;
    newValueJson?: string | null;
    actor?: string | null;
  }): Promise<void> {
    const { level, id } = scopeToKey(input.scope);
    const db = await getDb();
    await db.execute(
      `INSERT INTO policy_override_history
         (id, policy_key, scope_level, scope_id, action, old_value_json, new_value_json, actor, at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        crypto.randomUUID(),
        input.policyKey,
        level,
        id,
        input.action,
        input.oldValueJson ?? null,
        input.newValueJson ?? null,
        input.actor ?? null,
        now(),
      ],
    );
  },

  /** 一条 policy 的最近 history（按时间倒序）。 */
  async listByPolicy(policyKey: string, limit = 50): Promise<PolicyOverrideHistoryRow[]> {
    const db = await getDb();
    const rows = await db.select<DbRow[]>(
      "SELECT id, policy_key, scope_level, scope_id, action, old_value_json, new_value_json, actor, at " +
        "FROM policy_override_history WHERE policy_key = $1 ORDER BY at DESC LIMIT $2",
      [policyKey, limit],
    );
    return rows.map(mapRow);
  },
};
