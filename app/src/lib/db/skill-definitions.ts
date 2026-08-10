/**
 * skill_definitions 表 DAO。
 *
 * Skill 是引擎化改造方案 §6 阶段 1b 落地的实体：以前 SkillId 是闭合联合类型
 * （写死在源码的 3 个值），现在开放为 string，靠这张表 + 审核流程让用户/运营可以
 * 加技能而不重编译。
 *
 * 三类 source：
 *   - builtin：内核启动时 seed（项目 seedBuiltIn* 同模式），来源稳定，由源码控制
 *   - user：用户自添加（受审核、数量上限、来源标注三重保护）
 *   - ops：运营/管理员添加（同样受审核，但走的审批通道可能不同）
 *
 * 三档 review_status：
 *   - approved：active 集合用
 *   - pending：待审；UI 可见但 selector 不装载
 *   - rejected：拒绝，不对外可见
 *
 * selector 调用 listActive() 只返回 approved 的全部行；注册/审核（approve/reject）
 * 单独走流程并落 audit_log。
 */

import { getDb } from "./connection";
import { now } from "./utils";
import type { SkillDefinition, SkillSource, SkillReviewStatus } from "@/lib/skills/types";

export interface SkillDefinitionRow {
  id: string;
  builtinVersion: string | null;
  label: string;
  purpose: string;
  triggerPhases: string[];
  triggerKeywords: string[];
  requiredCapabilities: string[];
  systemGuidance: string[];
  acceptanceCriteria: unknown[];
  source: SkillSource;
  reviewStatus: SkillReviewStatus;
  reviewedBy: string | null;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 把 row 还原成 in-memory SkillDefinition（acceptanceCriteria 保持 unknown[] 留给上层 narrow）。 */
export function rowToDefinition(row: SkillDefinitionRow): SkillDefinition {
  return {
    id: row.id,
    label: row.label,
    purpose: row.purpose,
    triggerPhases: row.triggerPhases as SkillDefinition["triggerPhases"],
    triggerKeywords: row.triggerKeywords,
    requiredCapabilities: row.requiredCapabilities,
    systemGuidance: row.systemGuidance,
    acceptanceCriteria: row.acceptanceCriteria as SkillDefinition["acceptanceCriteria"],
    source: row.source,
    reviewStatus: row.reviewStatus,
  };
}

interface DbRow {
  id: string;
  builtin_version: string | null;
  label: string;
  purpose: string;
  trigger_phases: string;
  trigger_keywords: string;
  required_capabilities: string;
  system_guidance: string;
  acceptance_criteria: string;
  source: string;
  review_status: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
}

function safeJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function mapRow(r: DbRow): SkillDefinitionRow {
  return {
    id: r.id,
    builtinVersion: r.builtin_version,
    label: r.label,
    purpose: r.purpose,
    triggerPhases: safeJson<string[]>(r.trigger_phases, []),
    triggerKeywords: safeJson<string[]>(r.trigger_keywords, []),
    requiredCapabilities: safeJson<string[]>(r.required_capabilities, []),
    systemGuidance: safeJson<string[]>(r.system_guidance, []),
    acceptanceCriteria: safeJson<unknown[]>(r.acceptance_criteria, []),
    source: r.source as SkillSource,
    reviewStatus: r.review_status as SkillReviewStatus,
    reviewedBy: r.reviewed_by,
    reviewedAt: r.reviewed_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export const skillDefinitions = {
  /** 列全部 active（approved）skill。selector 启动时调一次。 */
  async listActive(): Promise<SkillDefinitionRow[]> {
    const db = await getDb();
    const rows = await db.select<DbRow[]>(
      "SELECT * FROM skill_definitions WHERE review_status = 'approved' ORDER BY source, id",
    );
    return rows.map(mapRow);
  },

  /** 列全部（含 pending/rejected），给管理 UI。 */
  async listAll(): Promise<SkillDefinitionRow[]> {
    const db = await getDb();
    const rows = await db.select<DbRow[]>(
      "SELECT * FROM skill_definitions ORDER BY review_status, source, id",
    );
    return rows.map(mapRow);
  },

  /** 按 id 取一条。 */
  async getById(id: string): Promise<SkillDefinitionRow | null> {
    const db = await getDb();
    const rows = await db.select<DbRow[]>(
      "SELECT * FROM skill_definitions WHERE id = $1",
      [id],
    );
    return rows.length === 0 ? null : mapRow(rows[0]!);
  },

  /** 写一条；onConflict 走 builtin upsert 路径。返回写入行。 */
  async upsert(input: {
    id: string;
    builtinVersion?: string | null;
    label: string;
    purpose: string;
    triggerPhases: ReadonlyArray<string>;
    triggerKeywords: ReadonlyArray<string>;
    requiredCapabilities: ReadonlyArray<string>;
    systemGuidance: ReadonlyArray<string>;
    acceptanceCriteria: ReadonlyArray<unknown>;
    source: SkillSource;
    reviewStatus: SkillReviewStatus;
    reviewedBy?: string | null;
    reviewedAt?: string | null;
  }): Promise<SkillDefinitionRow> {
    const db = await getDb();
    const ts = now();
    await db.execute(
      `INSERT INTO skill_definitions (
         id, builtin_version, label, purpose,
         trigger_phases, trigger_keywords, required_capabilities,
         system_guidance, acceptance_criteria,
         source, review_status, reviewed_by, reviewed_at, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14)
       ON CONFLICT (id) DO UPDATE SET
         builtin_version = excluded.builtin_version,
         label = excluded.label,
         purpose = excluded.purpose,
         trigger_phases = excluded.trigger_phases,
         trigger_keywords = excluded.trigger_keywords,
         required_capabilities = excluded.required_capabilities,
         system_guidance = excluded.system_guidance,
         acceptance_criteria = excluded.acceptance_criteria,
         source = excluded.source,
         review_status = excluded.review_status,
         reviewed_by = COALESCE(excluded.reviewed_by, skill_definitions.reviewed_by),
         reviewed_at = excluded.reviewed_at,
         updated_at = excluded.updated_at`,
      [
        input.id,
        input.builtinVersion ?? null,
        input.label,
        input.purpose,
        JSON.stringify([...input.triggerPhases]),
        JSON.stringify([...input.triggerKeywords]),
        JSON.stringify([...input.requiredCapabilities]),
        JSON.stringify([...input.systemGuidance]),
        JSON.stringify([...input.acceptanceCriteria]),
        input.source,
        input.reviewStatus,
        input.reviewedBy ?? null,
        input.reviewedAt ?? null,
        ts,
      ],
    );
    const row = await this.getById(input.id);
    if (!row) throw new Error(`[skill-definitions] upsert 后读失败：${input.id}`);
    return row;
  },

  /** 把一条 review_status 改成 approved。审核流程入口。 */
  async approve(id: string, reviewer: string): Promise<SkillDefinitionRow | null> {
    const db = await getDb();
    await db.execute(
      "UPDATE skill_definitions SET review_status = 'approved', reviewed_by = $2, reviewed_at = $3, updated_at = $3 WHERE id = $1",
      [id, reviewer, now()],
    );
    return this.getById(id);
  },

  async reject(id: string, reviewer: string): Promise<SkillDefinitionRow | null> {
    const db = await getDb();
    await db.execute(
      "UPDATE skill_definitions SET review_status = 'rejected', reviewed_by = $2, reviewed_at = $3, updated_at = $3 WHERE id = $1",
      [id, reviewer, now()],
    );
    return this.getById(id);
  },

  /** 撤回（软删），置 review_status=rejected 不丢失记录。 */
  async retire(id: string): Promise<void> {
    const db = await getDb();
    await db.execute(
      "UPDATE skill_definitions SET review_status = 'rejected', updated_at = $2 WHERE id = $1",
      [id, now()],
    );
  },

  /** 用户/ops 已注册数量（pending + approved 都算占位，受数量上限约束用）。 */
  async countBySource(source: SkillSource): Promise<number> {
    const db = await getDb();
    const rows = await db.select<Array<{ n: number }>>(
      "SELECT COUNT(*) AS n FROM skill_definitions WHERE source = $1 AND review_status IN ('pending','approved')",
      [source],
    );
    return rows[0]?.n ?? 0;
  },

  /** 内置 seed：项目启动时按 builtin version 戳幂等 seed（已存在就不覆盖）。 */
  async seedBuiltinIfMissing(input: {
    id: string;
    builtinVersion: string;
    label: string;
    purpose: string;
    triggerPhases: ReadonlyArray<string>;
    triggerKeywords: ReadonlyArray<string>;
    requiredCapabilities: ReadonlyArray<string>;
    systemGuidance: ReadonlyArray<string>;
    acceptanceCriteria: ReadonlyArray<unknown>;
  }): Promise<"inserted" | "skipped"> {
    const existing = await this.getById(input.id);
    if (existing) return "skipped";
    await this.upsert({
      ...input,
      builtinVersion: input.builtinVersion,
      source: "builtin",
      reviewStatus: "approved",
      reviewedBy: "builtin-seed",
      reviewedAt: now(),
    });
    return "inserted";
  },
};
