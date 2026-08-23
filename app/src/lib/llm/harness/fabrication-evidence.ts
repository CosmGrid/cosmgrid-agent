// 「工具证据摘要」—— fabrication-judge 的事实底座。
//
// 病根：现有 verify-claims 用 `toolName + sinceIso` 时间窗口过滤证据，对账精度够用
// 但 fabrication 裁判需要的不只是「有没有」还要「结果是什么」——需要 status + output。
// 同时旧时间窗口在相邻轮次/并发执行下会借到上一轮的记录，必须优先按 messageId 归属。
//
// 设计取舍：
// - 纯函数：吃 ToolExecutionRow[] + assistantMessageId + sinceIso → 限长的可读文本
// - messageId 优先：当前消息的记录全收；旧记录（messageId === null）才回退到 sinceIso 时间窗口
// - 限长：单条 output ≤ 600 字符；总摘要 ≤ 4000 字符（防止成本失控，对账够用）
// - 脱敏：input/output 里像密钥/api_key/token/password 的字段值替换为 <redacted>
// - 不反向依赖 workflow / db——本模块只做「数据整形」，是 L8 Harness 的内部函数
//
// 调用方（useChatStream evalHarnessForConversation）：
//   selectRowsForMessage(rows, { assistantMessageId, sinceIso })
//   buildFabricationEvidenceSummary(rows)
//   → 喂给 judgeFabrication(content, model, summary)

import type { ToolExecutionRow } from "@/lib/db";
import { projectWebFetchExecutionRow } from "@/lib/security-invariants/web-fetch-privacy";
import {
  FABRICATION_PER_INPUT_MAX,
  FABRICATION_PER_OUTPUT_MAX,
  FABRICATION_TOTAL_MAX,
} from "./fabrication-constants";

/** input/output 字段里需要遮蔽的值（极简启发式，覆盖最常见泄露点）。 */
const SECRET_KEYS = [
  /api[_-]?key/i,
  /token/i,
  /secret/i,
  /password/i,
  /passwd/i,
  /authorization/i,
  /bearer/i,
];

/** 把 input/output 里疑似密钥的值替换成 <redacted>。覆盖：key=value / "key":"value" / Authorization: Bearer xxx。 */
function redactSecrets(text: string): string {
  if (!text) return text;
  try {
    let out = text;
    // 先整段处理 Authorization: Bearer / Authorization: Token 头部模式（值带整个 token）
    out = out.replace(
      /\b(Authorization|Bearer)\s*[:=]?\s*["']?(?:Bearer|Token)\s+([A-Za-z0-9._\-+/=]{8,})["']?/gi,
      "$1=<redacted>",
    );
    // 再 key=value / key:value / "key":"value"（JSON 风格 key 后可能跟引号）
    for (const re of SECRET_KEYS) {
      out = out.replace(
        new RegExp(`(["']?(${re.source})["']?\\s*["':=]\\s*["']?)([^"'\\s,}{]+)(["']?)`, "gi"),
        "$1<redacted>$4",
      );
    }
    return out;
  } catch {
    // 脱敏失败不能让整条 evidence pipeline 挂掉——回退原文，由调用方负责"已脱敏"的承诺
    return text;
  }
}

/** 单行限制在 max 字符内。中文按 1 字符算（粗略够用，裁判只看不严格分词）。 */
function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…(truncated)`;
}

/**
 * 选本轮应当归属到当前 assistant 消息的工具记录。
 *
 * 归属优先级：
 *   1. 优先按 messageId === assistantMessageId 精确匹配
 *   2. 缺 messageId 的旧记录，回退到 sinceIso 时间窗口兜底（不会污染已有真实归属的新行）
 *   3. 没传 messageId 也没 sinceIso → 返回空（防御性，宁漏勿串）
 */
export function selectRowsForMessage(
  rows: readonly ToolExecutionRow[],
  args: { assistantMessageId: string | null; sinceIso: string | null },
): ToolExecutionRow[] {
  const project = (selected: ToolExecutionRow[]): ToolExecutionRow[] => selected.map((r) =>
    r.toolName === "web_fetch" ? projectWebFetchExecutionRow(r) : r,
  );
  if (!rows.length) return [];
  const withMessageId: ToolExecutionRow[] = [];
  const legacyRows: ToolExecutionRow[] = [];
  for (const r of rows) {
    if (r.messageId !== null) withMessageId.push(r);
    else legacyRows.push(r);
  }

  if (args.assistantMessageId) {
    // 单次扫：边过滤边复用
    const exact: ToolExecutionRow[] = [];
    for (const r of withMessageId) {
      if (r.messageId === args.assistantMessageId) exact.push(r);
    }
    if (exact.length > 0) return project(exact);

    if (legacyRows.length === 0) return [];
    if (!args.sinceIso) return [];
    const sinceTs = Date.parse(args.sinceIso);
    if (Number.isNaN(sinceTs)) return [];
    return project(legacyRows.filter((r) => Date.parse(r.createdAt) >= sinceTs));
  }

  // 没传 messageId → 退化到 sinceIso 时间窗口
  if (!args.sinceIso) return [];
  const sinceTs = Date.parse(args.sinceIso);
  if (Number.isNaN(sinceTs)) return [];
  return project(rows.filter((r) => Date.parse(r.createdAt) >= sinceTs));
}

/**
 * 单条记录 → 单行文本（喂给 LLM 裁判）。限长 + 脱敏 + 含 messageId 便于审计。
 * 任何单条错误（脱敏/截断）都不影响其他行——返回降级行。
 */
function rowToLine(r: ToolExecutionRow): string {
  try {
    const safeInput = redactSecrets(truncate(r.input ?? "", FABRICATION_PER_INPUT_MAX));
    const safeOutput = redactSecrets(truncate(r.output ?? "", FABRICATION_PER_OUTPUT_MAX));
    return `toolName=${r.toolName} | status=${r.status} | messageId=${r.messageId ?? "<legacy>"} | input=${safeInput} | output=${safeOutput}`;
  } catch {
    return `[evidence-format-failed id=${r.id} toolName=${r.toolName}]`;
  }
}

/**
 * 把工具记录列表拼成一条限长、可喂给 LLM 的纯文本摘要。
 * 总长 ≤ FABRICATION_TOTAL_MAX，超出时尾部追加 "[...还有 N 条记录省略]"。
 */
export function buildFabricationEvidenceSummary(rows: readonly ToolExecutionRow[]): string {
  if (rows.length === 0) return "";
  const lines: string[] = [];
  let used = 0;
  for (const r of rows) {
    const line = rowToLine(r);
    const projected = used + line.length + 1;
    if (projected > FABRICATION_TOTAL_MAX) {
      lines.push(`[...还有 ${rows.length - lines.length} 条记录省略]`);
      break;
    }
    lines.push(line);
    used = projected;
  }
  return lines.join("\n");
}
