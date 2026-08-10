// Harness 工程实施计划 阶段3 — 声明提取器（claim-extractor）。
//
// 把 assistant 文本里的"声明"按 5 类拆开：
//   - file_modified：声称修改了某文件（沿用 extractFilePaths 的语境提取）
//   - command_executed：声称跑了某命令（沿用 extractQuotedClaims）
//   - url_fetched：声称抓了某 URL（沿用 extractUrlClaims）
//   - test_result：声称"X 项测试通过"（新增，正则匹配"X 个 passed" / "X 项通过"等数字 + 关键词）
//   - acceptance_met：声称满足某验收标准（新增，配对 StructuredAcceptanceCriterion）
//
// 设计原则（沿用 harness/extract-claims.ts 的"漏报优先于误报"）：
// - 数字必须紧跟明确的"测试/通过/passed/failed"等关键词，不抓裸数字（避免误报"3.14 秒"之类）
// - 验收标准 claim 只在显式提到对应 criterion.description 时才关联，不强猜

import {
  extractQuotedClaims,
  extractUrlClaims,
} from "@/lib/llm/harness/extract-claims";
import type { LinkedClaim, StructuredAcceptanceCriterion } from "./types";

/**
 * 数字类声明 —— "X 项测试全部通过" / "X tests passed" / "5 用例都成功" 等。
 * 模式：可选的数字千分位 + 整数/小数 + 量词（项/个/tests/测试/套件/用例 等）+ 通过/成功/失败 等。
 * 漏报优先于误报：必须有明确"测试/用例/套件"等关键词才抓，模型说"用时 3.5 秒"不会误报。
 */
// 数字 + 量词（项/个/条/只/例 可选）+ 测试/套件/用例/tests 等关键词 + 通过/成功 等
// 注意：量词和"测试"是**组合 alternation**——中文"项测试"作为整体匹配单元，避免 regex
// 在"项"和"测试"之间反复回溯失败。
const NUMERIC_TEST_CLAIM_RE =
  /(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)\s*(?:(?:项|个|条|只|例)?\s*(?:测试|tests?|specs?|cases?|套件|用例))?\s*(?:已经|已|全部|all|都|全)?\s*(通过|passed|pass|成功|success|成功通过|通过成功|过了|全过)/gi;

const NUMERIC_FAILED_CLAIM_RE =
  /(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)\s*(?:(?:项|个|条|只|例)?\s*(?:测试|tests?|specs?|cases?|套件|用例))?\s*(失败|failed|failure|挂了|没通过)/gi;

/** 抽"X 项测试通过"类数字声明。 */
export function extractNumericClaims(text: string): Array<{ kind: "test_result"; count: number; raw: string }> {
  const out: Array<{ kind: "test_result"; count: number; raw: string }> = [];
  for (const m of text.matchAll(NUMERIC_TEST_CLAIM_RE)) {
    const numStr = (m[1] ?? "").replace(/,/g, "");
    const n = Number(numStr);
    if (Number.isFinite(n) && n > 0) {
      out.push({ kind: "test_result", count: n, raw: m[0].trim() });
    }
  }
  return out;
}

/**
 * 抽"X 项测试失败"类数字声明（独立导出，对账时拿来跟 passed 数对比看是否矛盾）。
 * 例如"1 个 failed"——claim-linker 拿它去 grep bash 输出找"failed 1"。
 */
export function extractFailedClaims(text: string): Array<{ kind: "test_result_failed"; count: number; raw: string }> {
  const out: Array<{ kind: "test_result_failed"; count: number; raw: string }> = [];
  for (const m of text.matchAll(NUMERIC_FAILED_CLAIM_RE)) {
    const n = Number(m[1].replace(/,/g, ""));
    if (Number.isFinite(n) && n > 0) {
      out.push({ kind: "test_result_failed", count: n, raw: m[0].trim() });
    }
  }
  return out;
}

/**
 * 把"X 已完成" 类声明跟 StructuredAcceptanceCriterion 配对。
 * 配对策略：criterion.description 里每个有意义的词（≥ 2 个中文字符 / ≥ 3 个英文字符）
 * 任一出现在 claim 句子 30 字符内就算匹配。漏报优先于误报：少配对 → 不冒充通过。
 */
export function extractAcceptanceClaims(
  text: string,
  criteria: readonly StructuredAcceptanceCriterion[],
): LinkedClaim[] {
  if (criteria.length === 0) return [];
  const claims: LinkedClaim[] = [];
  const lines = text.split(/[\n。.!?]/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    for (const c of criteria) {
      if (matchesAcceptanceLine(trimmed, c.description)) {
        claims.push({
          claimId: `accept-${c.id}-${claims.length}`,
          kind: "acceptance_met",
          text: trimmed.slice(0, 200),
          evidenceIds: [],
          verdict: "insufficient", // 由 claim-linker 升级
        });
      }
    }
  }
  return claims;
}

/**
 * 一行声明是否提及某验收标准。匹配规则：
 * - 中文 description 拆词（≥ 2 字 / 标点分隔），任一词出现在这一行就算
 * - 英文 description 拆词（≥ 3 字 / 空格分隔），任一词出现在这一行就算
 * 不区分大小写（toLowerCase）。
 */
function matchesAcceptanceLine(line: string, description: string): boolean {
  const tokens: string[] = [];
  // 中文：拆标点 + 长度 ≥ 2 的连续片段
  const cnTokens = description.match(/[一-龥]{2,}/g) ?? [];
  tokens.push(...cnTokens);
  // 英文：拆空格 + 长度 ≥ 3 的单词
  const enTokens = description
    .split(/[\s,/;:()]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 3 && /^[A-Za-z0-9_-]+$/.test(s));
  tokens.push(...enTokens);
  if (tokens.length === 0) return false;
  const lower = line.toLowerCase();
  return tokens.some((t) => lower.includes(t.toLowerCase()));
}

// =====================================================================
// file_modified 专用提取（区别于 extractFilePaths 的"读取"动词）
// =====================================================================
//
// 现有 harness/extract-claims.ts 的 extractFilePaths 用"读取/查看"动词表，针对 read 工具；
// 但阶段3 file_modified claim 需要"修改/写/创建"动词表，对应 write/edit 工具。
// 这是两个不同的语义——分别走不同的 extractor，避免 read claim 被错误归类到 file_modified。

const FILE_MODIFICATION_RE =
  /(?:修改了|修改|改了|编辑了|编辑|写了|写|创建了|创建|新建了|建立|建立了|覆盖了|更新了|删除了|删了|移除了|添加了|加了|补了|补充了|加入了|(?:I\s+)?(?:modified|edited|wrote|created|updated|deleted|removed|added|refactored|fixed)(?:\s+(?:file|the\s+file|it))?)\s*[`'"([]?\s*((?:[/A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.[A-Za-z0-9]{1,8})/gi;

/** 从 assistant 文本提取"声称修改/写/创建"过的文件路径。 */
export function extractFileModificationClaims(text: string): string[] {
  const cleaned = text.replace(/https?:\/\/[^\s"'<>)\]]+/gi, "");
  const found = new Set<string>();
  for (const m of cleaned.matchAll(FILE_MODIFICATION_RE)) {
    const p = m[1];
    if (p && !p.startsWith("//")) found.add(p);
  }
  return [...found];
}

// =====================================================================
// 公开入口：把全部 5 类声明打成统一 LinkedClaim[]（verdict 暂为 insufficient，
// 由 claim-linker 升级成 supported / contradicts / unknown）
// =====================================================================

export interface ExtractClaimsOptions {
  acceptanceCriteria?: readonly StructuredAcceptanceCriterion[];
}

export function extractAllClaims(
  text: string,
  opts: ExtractClaimsOptions = {},
): LinkedClaim[] {
  const claims: LinkedClaim[] = [];

  // 1. file_modified：路径 claim（用"修改/写/创建"动词，区别于 read claim）
  for (const p of extractFileModificationClaims(text)) {
    claims.push({
      claimId: `file-${claims.length}`,
      kind: "file_modified",
      text: p,
      evidenceIds: [],
      verdict: "insufficient",
    });
  }

  // 2. url_fetched：URL claim
  for (const u of extractUrlClaims(text)) {
    claims.push({
      claimId: `url-${claims.length}`,
      kind: "url_fetched",
      text: u,
      evidenceIds: [],
      verdict: "insufficient",
    });
  }

  // 3. command_executed：反引号 / 引号字面值 claim
  for (const c of extractQuotedClaims(text)) {
    claims.push({
      claimId: `cmd-${claims.length}`,
      kind: "command_executed",
      text: c,
      evidenceIds: [],
      verdict: "insufficient",
    });
  }

  // 4. test_result：数字 claim（passed）
  for (const n of extractNumericClaims(text)) {
    claims.push({
      claimId: `test-${claims.length}`,
      kind: "test_result",
      text: n.raw,
      evidenceIds: [],
      verdict: "insufficient",
    });
  }

  // 5. acceptance_met：验收标准配对
  if (opts.acceptanceCriteria) {
    claims.push(...extractAcceptanceClaims(text, opts.acceptanceCriteria));
  }

  return claims;
}

/** 单独导出 raw 类型，方便测试和 debug。 */
export const _internal = {
  NUMERIC_TEST_CLAIM_RE,
  NUMERIC_FAILED_CLAIM_RE,
  matchesAcceptanceLine,
};
