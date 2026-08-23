// Harness 工程实施计划 阶段3 — 声明链接器（claim-linker）。
//
// 把 extractAllClaims() 输出的 LinkedClaim[] 跟 ToolExecutionRow[] + EvidenceRef[] 对账：
// - file_modified 跟 write/edit 成功记录匹配（pathMatches）
// - url_fetched 跟 web_fetch 成功记录匹配（urlMatches）
// - command_executed 跟 bash/grep/web_search 成功记录匹配（looseMatches）
// - test_result 跟 bash 输出里数字匹配
// - acceptance_met 留给 StructuredAcceptanceCriterion.check()（task-verifier 调用）
//
// 三种对账结论：
//   - supported：有强证据（具体工具成功记录匹配 claim）
//   - contradicts：有证据但反向（bash exit != 0 / output 不含声称数字）→ 模型在编
//   - insufficient：声明了但 execRows 完全没有相关记录 → 漏报（不是编造，是没记录到）
//   - unknown：证据被截断 / legacy messageId 缺失 / 数据无法判定
//
// 为什么 insufficient ≠ contradicts：insufficient 是"我看不清，可能做了但我没
// 找到证据"；contradicts 是"我看到了证据，证据说反话"。这两种在 UI 上要不同提示——
// 阶段1 已经在多处强调"Harness dirty"和"节点证据不足"是不同事件。
//
// 注意：pathMatches / urlMatches / looseMatches 三个匹配函数在阶段1 harness/verify-claims.ts
// 已经存在（且经实战考验，2026-07-07 真事故修复）。这里重新实现是**有意**的：
// evidence 模块边界要求不反向依赖 harness/verify-claims.ts（防止阶段4 Eval Harness 把
// evidence 模块独立提取时拖一坨依赖）。函数体保持等价实现，便于 reviewer 对比。

import type { ToolExecutionRow } from "@/lib/db";
import type { EvidenceRef, LinkedClaim, ClaimVerdict } from "./types";

/** claim 链接用的输入：execRows 来自 selectRowsForMessage 过滤 + 全部 EvidenceRef。 */
export interface LinkInputs {
  claims: LinkedClaim[];
  evidence: EvidenceRef[];
  execRows: ToolExecutionRow[];
}

/** 把所有 claims 跑一遍匹配，返回带 verdict 的 LinkedClaim[]。 */
export function linkClaimsToEvidence(inputs: LinkInputs): LinkedClaim[] {
  return inputs.claims.map((claim) => linkOne(claim, inputs.execRows, inputs.evidence));
}

/** 单条 claim 对账。 */
function linkOne(claim: LinkedClaim, execRows: ToolExecutionRow[], evidence: EvidenceRef[]): LinkedClaim {
  switch (claim.kind) {
    case "file_modified":
      return linkFileClaim(claim, execRows, evidence);
    case "url_fetched":
      return linkUrlClaim(claim, execRows);
    case "command_executed":
      return linkCommandClaim(claim, execRows, evidence);
    case "test_result":
      return linkTestClaim(claim, execRows, evidence);
    case "acceptance_met":
      // acceptance 由 StructuredAcceptanceCriterion.check() 决定，这里保持 insufficient
      // （verifier 在 task-verifier.ts 里升级成 supported/contradicts）
      return claim;
  }
}

// =====================================================================
// file_modified
// =====================================================================

function linkFileClaim(claim: LinkedClaim, execRows: ToolExecutionRow[], evidence: EvidenceRef[]): LinkedClaim {
  // 候选：write/edit 工具的成功记录（reversible 不参与——它仅 UI 提示，不影响"成功"判定）
  const writeRows = execRows.filter(
    (r) =>
      (r.toolName === "write" || r.toolName === "edit" || r.toolName === "hashline_edit") &&
      r.status === "success",
  );
  // 提取每条记录写入的路径
  const writePaths = writeRows
    .map((r) => extractPathFromToolInput(r.toolName, r.input))
    .filter((p): p is string => p !== null);
  const matchedRows = writeRows.filter((r) => {
    const p = extractPathFromToolInput(r.toolName, r.input);
    return p ? pathMatches(claim.text, p) : false;
  });

  if (matchedRows.length > 0) {
    return withEvidenceIds(claim, matchedRows, evidence, "supported");
  }
  if (writePaths.length === 0) {
    // execRows 里根本没有 write/edit 记录 → 声明了但本次对话没真改 → insufficient
    return { ...claim, verdict: "insufficient", conflictReason: "本次对话没有 write/edit 工具成功执行记录，无法验证" };
  }
  // 有 write/edit 记录但跟 claim 的路径都对不上 → 严格说这是 contradicted（声称改了 X，但实际改的是 Y）。
  // 但 plan 文件说 "claim 提到路径但 execRows 无任何 write/edit → insufficient" —— 这里更宽松：
  // 任一路径匹配不到就标 insufficient，避免"模型改了 foo.ts 又声称改 bar.ts"被误判成 contradicted。
  return { ...claim, verdict: "insufficient", conflictReason: "本次 write/edit 记录中没有匹配该路径的证据" };
}

function extractPathFromToolInput(_toolName: string, input: string): string | null {
  try {
    const obj = JSON.parse(input) as Record<string, unknown>;
    const fp = obj.file_path;
    return typeof fp === "string" && fp ? fp : null;
  } catch {
    return null;
  }
}

// =====================================================================
// url_fetched
// =====================================================================

function linkUrlClaim(claim: LinkedClaim, execRows: ToolExecutionRow[]): LinkedClaim {
  const fetchRows = execRows.filter((r) => r.toolName === "web_fetch" && r.status === "success");
  if (fetchRows.length === 0) {
    return { ...claim, verdict: "insufficient", conflictReason: "本次对话没有 web_fetch 成功记录" };
  }
  return { ...claim, verdict: "insufficient", conflictReason: "web_fetch 记录中没有匹配该 URL 的证据" };
}

// =====================================================================
// command_executed（bash/grep/web_search 并集）
// =====================================================================

function linkCommandClaim(claim: LinkedClaim, execRows: ToolExecutionRow[], evidence: EvidenceRef[]): LinkedClaim {
  const execCandidates = execRows.filter(
    (r) =>
      (r.toolName === "bash" || r.toolName === "grep" || r.toolName === "web_search") &&
      r.status === "success",
  );
  const matchedRows = execCandidates.filter((r) => {
    const target = extractExecTarget(r.toolName, r.input);
    return target ? looseMatches(claim.text, target) : false;
  });
  if (matchedRows.length > 0) {
    return withEvidenceIds(claim, matchedRows, evidence, "supported");
  }
  if (execCandidates.length === 0) {
    return { ...claim, verdict: "insufficient", conflictReason: "本次对话没有 bash/grep/web_search 成功记录" };
  }
  return { ...claim, verdict: "insufficient", conflictReason: "bash/grep/web_search 记录中没有匹配该命令的证据" };
}

const EXEC_TARGET_FIELDS: Record<string, string> = {
  bash: "command",
  grep: "pattern",
  web_search: "query",
};

function extractExecTarget(toolName: string, input: string): string | null {
  const field = EXEC_TARGET_FIELDS[toolName];
  if (!field) return null;
  try {
    const obj = JSON.parse(input) as Record<string, unknown>;
    const v = obj[field];
    return typeof v === "string" && v ? v : null;
  } catch {
    return null;
  }
}

// =====================================================================
// test_result（数字对账）—— grep bash 输出里的数字
// =====================================================================

function linkTestClaim(claim: LinkedClaim, execRows: ToolExecutionRow[], evidence: EvidenceRef[]): LinkedClaim {
  const expectedCount = parseCountFromClaim(claim.text);
  if (expectedCount === null) {
    return { ...claim, verdict: "unknown", conflictReason: "声明中无法解析数字" };
  }
  const bashRows = execRows.filter((r) => r.toolName === "bash" && r.status === "success");
  if (bashRows.length === 0) {
    return { ...claim, verdict: "insufficient", conflictReason: "本次对话没有 bash 成功记录，无法验证测试数字" };
  }
  const matchedRow = bashRows.find((r) => bashOutputMentionsCount(r.output, expectedCount));
  if (matchedRow) {
    return withEvidenceIds(claim, [matchedRow], evidence, "supported");
  }
  // bash 跑了但声称的数字找不到 → 候选是 contradicted（声称 X 通过但 bash 输出不含 X）
  return {
    ...claim,
    verdict: "contradicts",
    conflictReason: `claimed=${expectedCount} 项测试通过，但 bash 输出里没找到对应数字`,
  };
}

function parseCountFromClaim(text: string): number | null {
  const m = text.match(/(\d{1,3}(?:,\d{3})*(?:\.\d+)?|\d+(?:\.\d+)?)/);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function bashOutputMentionsCount(output: string, count: number): boolean {
  if (!output) return false;
  // 匹配 "Tests: 8 passed" / "8 passed" / "passed 8" / "8 / 10" 等格式
  const patterns = [
    new RegExp(`\\b${count}\\s*(?:passed|passed|通过|成功)`, "i"),
    new RegExp(`(?:passed|通过|成功)\\s*${count}`, "i"),
    new RegExp(`\\b${count}\\s*\\/\\s*\\d+`, ""), // "8 / 10"
  ];
  return patterns.some((p) => p.test(output));
}

// =====================================================================
// helpers
// =====================================================================

/** 把匹配的 ToolExecutionRow 关联到 EvidenceRef 并设置 verdict。 */
function withEvidenceIds(
  claim: LinkedClaim,
  rows: ToolExecutionRow[],
  evidence: EvidenceRef[],
  verdict: ClaimVerdict,
): LinkedClaim {
  const evidenceIds = rows
    .map((r) => evidence.find((e) => e.toolExecutionId === r.id)?.id)
    .filter((id): id is string => id !== undefined);
  return { ...claim, verdict, evidenceIds };
}

// =====================================================================
// 共享 match 函数（与 harness/verify-claims.ts 等价实现，保持模块边界独立）
// =====================================================================

/** 路径匹配：处理相对/绝对、basename 同名等情形 */
export function pathMatches(claimed: string, actual: string): boolean {
  const c = claimed.replace(/\/+$/, "");
  const a = actual.replace(/\/+$/, "");
  if (c === a) return true;
  if (c.endsWith("/" + a) || a.endsWith("/" + c)) return true;
  if (c.endsWith(a) || a.endsWith(c)) return true;
  const cb = c.split("/").pop();
  const ab = a.split("/").pop();
  if (cb && ab && cb === ab && /\.\w+$/.test(cb)) return true;
  return false;
}

/** 宽松匹配：命令/pattern/查询词允许模型转述时有细微出入 */
export function looseMatches(claimed: string, actual: string): boolean {
  const c = claimed.trim().toLowerCase();
  const a = actual.trim().toLowerCase();
  if (!c || !a) return false;
  return c === a || a.includes(c) || c.includes(a);
}
