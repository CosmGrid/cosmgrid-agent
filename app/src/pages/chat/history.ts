import type { ToolExecutionRow, DbMessage } from "@/lib/db";
import { parseAttachments } from "@/lib/llm/attachments";
import { ROLE_IDS, type RoleId } from "@/lib/llm/orchestrator";
import type { ReadRecord, FetchRecord, ExecRecord } from "@/lib/llm/harness/verify-claims";
import type { ModelListItem } from "@/lib/api";
import type { ChatMessage, ReceiptContent } from "./types";

/** 按工具名 + 起始时间筛 tool_executions，harness 各类 claim 校验的共用底座 */
function filterToolRecordsSince(
  rows: ToolExecutionRow[],
  sinceIso: string | null,
  toolNames: readonly string[],
): { input: string; status: string }[] {
  const sinceTs = sinceIso ? Date.parse(sinceIso) : Number.NEGATIVE_INFINITY;
  return rows
    .filter((r) => toolNames.includes(r.toolName) && Date.parse(r.createdAt) >= sinceTs)
    .map((r) => ({ input: r.input, status: r.status }));
}

export function filterReadRecordsSince(rows: ToolExecutionRow[], sinceIso: string | null): ReadRecord[] {
  return filterToolRecordsSince(rows, sinceIso, ["read"]);
}

export function filterFetchRecordsSince(rows: ToolExecutionRow[], sinceIso: string | null): FetchRecord[] {
  return filterToolRecordsSince(rows, sinceIso, ["web_fetch"]);
}

/** bash/grep/web_search 三个工具的执行记录并集，喂给 verifyCommandClaims */
export function filterExecRecordsSince(rows: ToolExecutionRow[], sinceIso: string | null): ExecRecord[] {
  return filterToolRecordsSince(rows, sinceIso, ["bash", "grep", "web_search"]);
}

function parseReceipt(content: string): ReceiptContent | null {
  try {
    const obj = JSON.parse(content) as unknown;
    if (obj && typeof obj === "object" && typeof (obj as ReceiptContent).summary === "string") {
      const r = obj as ReceiptContent;
      return { summary: r.summary, detail: typeof r.detail === "string" ? r.detail : "" };
    }
    return null;
  } catch {
    return null;
  }
}

export function dbMessagesToChat(hist: DbMessage[], models: ModelListItem[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  const validRoles = new Set<string>(ROLE_IDS);
  for (const m of hist) {
    if (m.role === "note") {
      const receipt = parseReceipt(m.content);
      if (receipt) out.push({ id: m.id, role: "assistant", content: "", createdAt: m.createdAt, kind: "receipt", receipt });
      continue;
    }
    if (m.role !== "user" && m.role !== "assistant") continue;
    out.push({
      id: m.id,
      role: m.role,
      content: m.content,
      createdAt: m.createdAt,
      kind: m.kind === "system-notice" ? "system-notice" : "chat",
      modelLabel: (m.modelId ? models.find((x) => x.id === m.modelId)?.displayName : undefined) ?? undefined,
      usage: m.outputTokens > 0 ? { inputTokens: m.inputTokens, outputTokens: m.outputTokens } : undefined,
      attachments: parseAttachments(m.attachments),
      roleId: m.actorRole && validRoles.has(m.actorRole) ? (m.actorRole as RoleId) : undefined,
      chainStep: m.chainStepIndex && m.chainStepTotal ? { index: m.chainStepIndex, total: m.chainStepTotal } : undefined,
      chainDone: m.chainDone ?? undefined,
      toolCallCount: m.toolCallCount ?? undefined,
      parts: m.parts ?? undefined,
    });
  }
  return out;
}
