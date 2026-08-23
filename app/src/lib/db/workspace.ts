import { getDb } from "./connection";
import { boolToInt, newId, now } from "./utils";
import { projectWebFetchExecutionRow } from "@/lib/security-invariants/web-fetch-privacy";

// ============ debateSessions CRUD（v0.8 阶段5：多角色对弈） ============

export interface DebateRoundData {
  role: string;
  modelId: string;
  content: string;
  inputTokens: number;
  outputTokens: number;
}

export interface DebateSessionRow {
  id: string;
  projectId: string | null;
  topic: string;
  status: string;
  quickMode: boolean;
  rounds: DebateRoundData[];
  finalSolution: string | null;
  createdAt: string;
  completedAt: string | null;
}

function mapDebateRow(r: any): DebateSessionRow {
  return {
    id: r.id,
    projectId: r.project_id,
    topic: r.topic,
    status: r.status,
    quickMode: !!r.quick_mode,
    rounds: JSON.parse(r.rounds || "[]"),
    finalSolution: r.final_solution,
    createdAt: r.created_at,
    completedAt: r.completed_at,
  };
}

export const debateSessions = {
  /** 保存一场完成的对弈 */
  async create(input: {
    projectId?: string | null;
    topic: string;
    quickMode: boolean;
    rounds: DebateRoundData[];
    finalSolution: string;
    status?: string;
  }): Promise<string> {
    const db = await getDb();
    const id = newId();
    const ts = now();
    await db.execute(
      `INSERT INTO debate_sessions
        (id, project_id, topic, status, quick_mode, rounds, final_solution, created_at, completed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        id, input.projectId ?? null, input.topic, input.status ?? "completed",
        boolToInt(input.quickMode), JSON.stringify(input.rounds), input.finalSolution, ts, ts,
      ]
    );
    return id;
  },

  /** 列出历史对弈（最近在前） */
  async list(limit = 50): Promise<DebateSessionRow[]> {
    const db = await getDb();
    const rows = await db.select<any[]>(
      "SELECT * FROM debate_sessions ORDER BY created_at DESC LIMIT $1",
      [limit]
    );
    return rows.map(mapDebateRow);
  },

  async getById(id: string): Promise<DebateSessionRow | null> {
    const db = await getDb();
    const rows = await db.select<any[]>("SELECT * FROM debate_sessions WHERE id = $1", [id]);
    return rows.length > 0 ? mapDebateRow(rows[0]) : null;
  },

  async delete(id: string): Promise<void> {
    const db = await getDb();
    await db.execute("DELETE FROM debate_sessions WHERE id = $1", [id]);
  },
};

// ============ toolExecutions CRUD（v0.7 阶段4：工具执行审计） ============

export interface ToolExecutionRow {
  id: string;
  projectId: string | null;
  conversationId: string | null;
  /** 2026-07-04 修复：这次工具调用真实归属的那条 assistant 消息 id。
   *  旧数据没有这一列（迁移补列后为 null）——UI 侧对 null 值仍走时间戳窗口兜底，
   *  不强制回填，避免对历史记录做不保真的猜测性归属。 */
  messageId: string | null;
  toolName: string;
  input: string;
  output: string;
  status: string;
  userConfirmed: boolean;
  reversible: boolean;
  durationMs: number;
  createdAt: string;
  /** 阶段2 工具结果协议 v2：完整结构化结果 JSON 序列化。
   *  老数据 result_json 为 null，UI 走 compatFromLegacy 兜底显示。 */
  resultJson: string | null;
  /** 阶段2：稳定的错误码（TOOL_DENIED / TOOL_TIMEOUT / TOOL_DOOM_LOOP 等），无错为 null。
   *  单独列出来方便 UI / 评估器按错误类型过滤，不必解析 result_json。 */
  errorCode: string | null;
}

function mapToolExecRow(r: any): ToolExecutionRow {
  const mapped = {
    id: r.id,
    projectId: r.project_id,
    conversationId: r.conversation_id,
    messageId: r.message_id ?? null,
    toolName: r.tool_name,
    input: r.input,
    output: r.output,
    status: r.status,
    userConfirmed: !!r.user_confirmed,
    reversible: !!r.reversible,
    durationMs: r.duration_ms,
    createdAt: r.created_at,
    resultJson: r.result_json ?? null,
    errorCode: r.error_code ?? null,
  };
  return mapped.toolName === "web_fetch" ? projectWebFetchExecutionRow(mapped) : mapped;
}

export const toolExecutions = {
  async create(input: {
    projectId?: string | null;
    conversationId?: string | null;
    messageId?: string | null;
    toolName: string;
    input: string;
    output: string;
    status: string;
    userConfirmed?: boolean;
    reversible?: boolean;
    durationMs: number;
    /** 阶段2：序列化好的 ToolResultV2，老数据 / 未迁移工具不传。 */
    resultJson?: string | null;
    /** 阶段2：从 ToolResultV2.error.code 取出来单独落库，方便 SQL 过滤。 */
    errorCode?: string | null;
  }): Promise<string> {
    const db = await getDb();
    const id = newId();
    const safeInput = input.toolName === "web_fetch"
      ? projectWebFetchExecutionRow({
          id,
          projectId: input.projectId ?? null,
          conversationId: input.conversationId ?? null,
          messageId: input.messageId ?? null,
          status: input.status,
          userConfirmed: input.userConfirmed ?? false,
          reversible: input.reversible ?? false,
          durationMs: input.durationMs,
          createdAt: now(),
          errorCode: input.errorCode ?? null,
        })
      : null;
    await db.execute(
      `INSERT INTO tool_executions
        (id, project_id, conversation_id, message_id, tool_name, input, output, status,
         user_confirmed, reversible, duration_ms, created_at, result_json, error_code)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        id, input.projectId ?? null, input.conversationId ?? null, input.messageId ?? null, input.toolName,
        safeInput?.input ?? input.input,
        safeInput?.output ?? input.output,
        safeInput?.status ?? input.status,
        boolToInt(safeInput?.userConfirmed ?? input.userConfirmed ?? false),
        boolToInt(safeInput?.reversible ?? input.reversible ?? false),
        input.durationMs, now(),
        safeInput?.resultJson ?? input.resultJson ?? null,
        safeInput?.errorCode ?? (safeInput ? null : input.errorCode ?? null),
      ]
    );
    return id;
  },

  /** 列出最近的工具执行（审计/侧边栏用） */
  async list(limit = 100): Promise<ToolExecutionRow[]> {
    const db = await getDb();
    const rows = await db.select<any[]>(
      "SELECT * FROM tool_executions ORDER BY created_at DESC LIMIT $1",
      [limit]
    );
    return rows.map(mapToolExecRow);
  },

  async listByConversation(conversationId: string): Promise<ToolExecutionRow[]> {
    const db = await getDb();
    const rows = await db.select<any[]>(
      "SELECT * FROM tool_executions WHERE conversation_id = $1 ORDER BY created_at ASC",
      [conversationId]
    );
    return rows.map(mapToolExecRow);
  },

  /** Harness 工程实施计划阶段1：查这条 assistant 消息本轮的工具执行，
   *  给 node-verifier 判断 userDeniedPermission（是否有 status=denied 的记录）。 */
  async listByMessage(messageId: string): Promise<ToolExecutionRow[]> {
    const db = await getDb();
    const rows = await db.select<any[]>(
      "SELECT * FROM tool_executions WHERE message_id = $1 ORDER BY created_at ASC",
      [messageId]
    );
    return rows.map(mapToolExecRow);
  },
};

// ============ workspaceConfigs CRUD（v0.7 阶段4b：项目级工具安全配置） ============

export const workspaceConfigs = {
  /** 取项目的自定义命令黑名单（无配置返回空数组） */
  async getBlockedCommands(projectId: string): Promise<string[]> {
    const db = await getDb();
    const rows = await db.select<any[]>(
      "SELECT blocked_commands FROM workspace_configs WHERE project_id = $1",
      [projectId]
    );
    if (rows.length === 0) return [];
    try {
      return JSON.parse(rows[0].blocked_commands || "[]");
    } catch {
      return [];
    }
  },

  /** 设置项目的自定义命令黑名单 */
  async setBlockedCommands(projectId: string, blocked: string[]): Promise<void> {
    const db = await getDb();
    await db.execute(
      `INSERT INTO workspace_configs (project_id, blocked_commands, updated_at)
       VALUES ($1,$2,$3)
       ON CONFLICT(project_id) DO UPDATE SET blocked_commands = excluded.blocked_commands, updated_at = excluded.updated_at`,
      [projectId, JSON.stringify(blocked), now()]
    );
  },
};
