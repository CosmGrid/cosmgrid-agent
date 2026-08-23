import { getDb } from "./connection";
import { boolToInt, newId, now } from "./utils";
import { projectStructuredParts } from "@/lib/security-invariants/web-fetch-privacy";

// ============ messages CRUD ============

export interface MessageRow {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  model_id: string | null;
  input_tokens: number;
  output_tokens: number;
  cost: number;
  attachments: string | null;
  actor_role: string | null;
  chain_step_index: number | null;
  chain_step_total: number | null;
  chain_done: number | null;
  kind: string | null;
  tool_call_count: number | null;
  /** 结构化 ModelMessage 部件（text/tool-call/tool-result）的 JSON 串；null = 旧数据/纯文本轮 */
  parts: string | null;
  created_at: string;
}

export interface DbMessage {
  id: string;
  conversationId: string;
  role: string;
  content: string;
  modelId: string | null;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  attachments?: string | null;
  actorRole?: string | null;
  chainStepIndex?: number | null;
  chainStepTotal?: number | null;
  chainDone?: boolean | null;
  kind?: string | null;
  /** 本轮真实工具调用次数；null = 未记录（旧数据/不适用），非工具场景不应据此判断 */
  toolCallCount?: number | null;
  /** 结构化 ModelMessage 部件的 JSON 串（回放用真相源）；null = 旧数据/纯文本轮，回放退化回 content 文本 */
  parts?: string | null;
  createdAt: string;
}

function mapMessageRow(r: MessageRow): DbMessage {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    role: r.role,
    content: r.content,
    modelId: r.model_id,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cost: r.cost,
    attachments: r.attachments,
    actorRole: r.actor_role,
    chainStepIndex: r.chain_step_index,
    chainStepTotal: r.chain_step_total,
    chainDone: r.chain_done === null ? null : r.chain_done === 1,
    kind: r.kind,
    toolCallCount: r.tool_call_count,
    parts: projectStructuredParts(r.parts),
    createdAt: r.created_at,
  };
}

export const messages = {
  async listByConversation(conversationId: string): Promise<DbMessage[]> {
    const db = await getDb();
    const rows = await db.select<MessageRow[]>(
      "SELECT * FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC",
      [conversationId]
    );
    return rows.map(mapMessageRow);
  },

  async create(input: {
    conversationId: string;
    role: string;
    content: string;
    modelId?: string | null;
    inputTokens?: number;
    outputTokens?: number;
    cost?: number;
    attachments?: string | null;
    actorRole?: string | null;
    chainStepIndex?: number | null;
    chainStepTotal?: number | null;
    chainDone?: boolean | null;
    kind?: string | null;
    toolCallCount?: number | null;
    /** 结构化 ModelMessage 部件的 JSON 串（回放真相源）；不传/null = 纯文本轮 */
    parts?: string | null;
  }): Promise<DbMessage> {
    const db = await getDb();
    const id = newId();
    const ts = now();
    await db.execute(
      `INSERT INTO messages
        (id, conversation_id, role, content, model_id, input_tokens, output_tokens, cost, attachments,
         actor_role, chain_step_index, chain_step_total, chain_done, kind, tool_call_count, parts, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [
        id,
        input.conversationId,
        input.role,
        input.content,
        input.modelId ?? null,
        input.inputTokens ?? 0,
        input.outputTokens ?? 0,
        input.cost ?? 0,
        input.attachments ?? null,
        input.actorRole ?? null,
        input.chainStepIndex ?? null,
        input.chainStepTotal ?? null,
        input.chainDone === undefined || input.chainDone === null ? null : boolToInt(input.chainDone),
        input.kind ?? null,
        input.toolCallCount ?? null,
        projectStructuredParts(input.parts),
        ts,
      ]
    );
    const rows = await db.select<MessageRow[]>("SELECT * FROM messages WHERE id = $1", [id]);
    return mapMessageRow(rows[0]!);
  },

  async updateChainMessage(id: string, input: {
    content?: string;
    chainDone?: boolean | null;
    inputTokens?: number;
    outputTokens?: number;
    cost?: number;
    modelId?: string | null;
  }): Promise<DbMessage | null> {
    const db = await getDb();
    const sets: string[] = [];
    const vals: unknown[] = [];
    let i = 1;
    if (input.content !== undefined) { sets.push(`content = $${i++}`); vals.push(input.content); }
    if (input.chainDone !== undefined) { sets.push(`chain_done = $${i++}`); vals.push(input.chainDone === null ? null : boolToInt(input.chainDone)); }
    if (input.inputTokens !== undefined) { sets.push(`input_tokens = $${i++}`); vals.push(input.inputTokens); }
    if (input.outputTokens !== undefined) { sets.push(`output_tokens = $${i++}`); vals.push(input.outputTokens); }
    if (input.cost !== undefined) { sets.push(`cost = $${i++}`); vals.push(input.cost); }
    if (input.modelId !== undefined) { sets.push(`model_id = $${i++}`); vals.push(input.modelId); }
    if (sets.length === 0) {
      const rows = await db.select<MessageRow[]>("SELECT * FROM messages WHERE id = $1", [id]);
      return rows[0] ? mapMessageRow(rows[0]) : null;
    }
    vals.push(id);
    await db.execute(`UPDATE messages SET ${sets.join(", ")} WHERE id = $${i}`, vals);
    const rows = await db.select<MessageRow[]>("SELECT * FROM messages WHERE id = $1", [id]);
    return rows[0] ? mapMessageRow(rows[0]) : null;
  },
};
