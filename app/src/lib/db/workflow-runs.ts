import type { WorkflowRunStatus, WorkflowSnapshot } from "../workflow/types";
import { deriveWorkflowAuditSummary, type WorkflowAuditSummary } from "./workflow-audit";
import { getDb } from "./connection";
import { newId, now } from "./utils";

// ============ workflowRuns CRUD（v0.10：持久任务工作流） ============

export interface WorkflowRunRow {
  id: string;
  conversation_id: string;
  project_id: string | null;
  status: WorkflowRunStatus;
  current_phase: string | null;
  snapshot_json: string;
  created_at: string;
  updated_at: string;
  snapshot_version: number;
}

export interface WorkflowRun {
  id: string;
  conversationId: string;
  projectId: string | null;
  status: WorkflowRunStatus;
  currentPhase: string | null;
  snapshotJson: string;
  snapshot: WorkflowSnapshot;
  createdAt: string;
  updatedAt: string;
  /** 乐观锁计数器，见下方 writeSnapshot 的 CAS 注释。 */
  snapshotVersion: number;
}

export interface WorkflowEventRow {
  id: string;
  workflow_run_id: string;
  conversation_id: string;
  event_type: string;
  payload_json: string;
  created_at: string;
}

export interface WorkflowEvent {
  id: string;
  workflowRunId: string;
  conversationId: string;
  eventType: string;
  payloadJson: string;
  createdAt: string;
}

function currentPhaseOf(snapshot: WorkflowSnapshot): string | null {
  const node = snapshot.nodes.find((n) => n.id === snapshot.currentNodeId);
  return node?.phase ?? null;
}

function mapWorkflowRunRow(r: WorkflowRunRow): WorkflowRun {
  const snapshot = JSON.parse(r.snapshot_json) as WorkflowSnapshot;
  return {
    id: r.id,
    conversationId: r.conversation_id,
    projectId: r.project_id,
    status: r.status,
    currentPhase: r.current_phase,
    snapshotJson: r.snapshot_json,
    snapshot,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    snapshotVersion: r.snapshot_version,
  };
}

function mapWorkflowEventRow(r: WorkflowEventRow): WorkflowEvent {
  return {
    id: r.id,
    workflowRunId: r.workflow_run_id,
    conversationId: r.conversation_id,
    eventType: r.event_type,
    payloadJson: r.payload_json,
    createdAt: r.created_at,
  };
}

/**
 * Task #9 独立复检发现的 MEDIUM 问题：saveSnapshot 是一条不带版本号/CAS 的
 * `UPDATE ... WHERE id = $runId`，谁后写谁赢。同一个 runId 现在有两条独立调用路径——
 * `prepare-turn-workflow.ts`（打字发消息，intent classifier 推进）和
 * `useOrchestration.ts` 的 `pickNextAction`（点 nextAction 按钮，确定性推进）——
 * 用户点完按钮、DB 写入还没落盘时如果立刻发下一条消息，两次 saveSnapshot 可能并发写同一行，
 * 写入完成的先后顺序不保证跟调用顺序一致，旧的快照可能把新的覆盖掉（内存里的 React state
 * 不会错，只有落盘的行会回退，刷新页面/切会话再切回来才会暴露）。
 * 按 runId 串行化：同一个 runId 的写入排成队列，前一个写完（无论成功失败）才轮到下一个，
 * 不同 runId 之间互不阻塞。错误被吞掉不重新抛出到队列里，避免一次失败的写永久卡住后续写。
 */
const snapshotWriteQueues = new Map<string, Promise<unknown>>();

/** 导出仅供单测直接验证串行化行为（见 __tests__/workflow-runs.test.ts）——不依赖真实 sqlite，
 *  用可控延迟的假 write 函数证明"先调用的先落盘"，而不是"先 resolve 的先落盘"。 */
export function enqueueSnapshotWrite<T>(runId: string, write: () => Promise<T>): Promise<T | undefined> {
  const prior = snapshotWriteQueues.get(runId) ?? Promise.resolve();
  const next = prior.then(write, write).catch(() => undefined);
  snapshotWriteQueues.set(runId, next);
  return next;
}

/**
 * 2026-07-16 review 修复：enqueueSnapshotWrite 只保证"同一个 runId 的写入按调用顺序
 * 执行"，不保证"数据新鲜度"——一次调用得早但算得慢的写入（比如 stream-finalization.ts
 * 的 runWorkflowVerificationInBackground，中间横跨好几个 await）依然会排在一次调用得晚
 * 但算得快的写入（比如用户紧接着发的下一条消息）后面执行，用旧数据把新数据覆盖掉，
 * 且没有任何报错提示——之前独立复检只发现并修了"调用顺序"这半个问题，这次修的是
 * "数据新鲜度"那另一半。
 *
 * expectedVersion 是可选的乐观锁比对值（调用方在开始计算前读到的 snapshot_version）：
 * - 传了：UPDATE 带 `AND snapshot_version = $expectedVersion`，如果这段时间内已经有
 *   更新的写入把版本号推高了，这次 UPDATE 影响 0 行——直接放弃这次陈旧写入（不重试，
 *   调用方的数据本来就是基于旧状态算出来的，重试也没有意义），返回 { applied: false }。
 * - 不传（其余几处正常前台推进的调用方，读写之间没有长时间 await 缺口，没有这个风险）：
 *   保持原有无条件 UPDATE 行为，仍然把 snapshot_version 往前推一格，不影响未来别的
 *   调用方接入 CAS 检查。
 */
async function writeSnapshot(input: {
  runId: string;
  snapshot: WorkflowSnapshot;
  eventType?: string;
  eventPayload?: unknown;
  expectedVersion?: number;
}): Promise<{ applied: boolean }> {
  const db = await getDb();
  const snapshotJson = JSON.stringify(input.snapshot);
  const currentPhase = currentPhaseOf(input.snapshot);
  const ts = now();
  const result =
    input.expectedVersion === undefined
      ? await db.execute(
          `UPDATE workflow_runs
           SET status = $1, current_phase = $2, snapshot_json = $3, updated_at = $4,
               snapshot_version = snapshot_version + 1
           WHERE id = $5`,
          [input.snapshot.status, currentPhase, snapshotJson, ts, input.runId],
        )
      : await db.execute(
          `UPDATE workflow_runs
           SET status = $1, current_phase = $2, snapshot_json = $3, updated_at = $4,
               snapshot_version = snapshot_version + 1
           WHERE id = $5 AND snapshot_version = $6`,
          [input.snapshot.status, currentPhase, snapshotJson, ts, input.runId, input.expectedVersion],
        );
  if (result.rowsAffected === 0) {
    // CAS 未命中：这段时间内已经有更新的写入了，陈旧数据放弃写入，不落事件。
    return { applied: false };
  }
  if (input.eventType) {
    await workflowRuns.appendEvent({
      workflowRunId: input.runId,
      conversationId: input.snapshot.conversationId,
      eventType: input.eventType,
      payload: input.eventPayload ?? { status: input.snapshot.status, currentPhase },
    });
  }
  return { applied: true };
}

export const workflowRuns = {
  async create(input: {
    conversationId: string;
    projectId?: string | null;
    snapshot: WorkflowSnapshot;
  }): Promise<WorkflowRun> {
    const db = await getDb();
    const ts = now();
    const snapshotJson = JSON.stringify(input.snapshot);
    const currentPhase = currentPhaseOf(input.snapshot);
    await db.execute(
      `INSERT INTO workflow_runs
        (id, conversation_id, project_id, status, current_phase, snapshot_json, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        input.snapshot.runId,
        input.conversationId,
        input.projectId ?? input.snapshot.projectId ?? null,
        input.snapshot.status,
        currentPhase,
        snapshotJson,
        ts,
        ts,
      ],
    );
    await this.appendEvent({
      workflowRunId: input.snapshot.runId,
      conversationId: input.conversationId,
      eventType: "workflow.created",
      payload: { status: input.snapshot.status, currentPhase },
    });
    const rows = await db.select<WorkflowRunRow[]>("SELECT * FROM workflow_runs WHERE id = $1", [input.snapshot.runId]);
    return mapWorkflowRunRow(rows[0]!);
  },

  async getById(id: string): Promise<WorkflowRun | null> {
    const db = await getDb();
    const rows = await db.select<WorkflowRunRow[]>("SELECT * FROM workflow_runs WHERE id = $1 LIMIT 1", [id]);
    return rows[0] ? mapWorkflowRunRow(rows[0]) : null;
  },

  async getActiveByConversation(conversationId: string): Promise<WorkflowRun | null> {
    const db = await getDb();
    const rows = await db.select<WorkflowRunRow[]>(
      `SELECT * FROM workflow_runs
       WHERE conversation_id = $1 AND status IN ('running', 'waiting_user', 'paused')
       ORDER BY updated_at DESC
       LIMIT 1`,
      [conversationId],
    );
    return rows[0] ? mapWorkflowRunRow(rows[0]) : null;
  },

  /**
   * 返回 { applied } 而不是 void：调用方（目前只有 stream-finalization.ts 的后台验收会传
   * expectedVersion 参与 CAS）可以据此判断这次写入有没有因为陈旧被放弃，从而决定要不要
   * 跟着把这份陈旧结果应用到当前 UI 状态（applyWorkflowSnapshot）——不传 expectedVersion
   * 的调用方永远拿到 applied: true，不用改动。
   */
  async saveSnapshot(input: {
    runId: string;
    snapshot: WorkflowSnapshot;
    eventType?: string;
    eventPayload?: unknown;
    expectedVersion?: number;
  }): Promise<{ applied: boolean }> {
    // 按 runId 串行化，见上面 enqueueSnapshotWrite 的注释——避免"点按钮"和"打字发消息"
    // 两条独立调用路径并发写同一个 runId 时，写入完成顺序跟调用顺序不一致导致旧快照覆盖新快照。
    const result = await enqueueSnapshotWrite(input.runId, () => writeSnapshot(input));
    return result ?? { applied: false };
  },

  async appendEvent(input: {
    workflowRunId: string;
    conversationId: string;
    eventType: string;
    payload: unknown;
  }): Promise<string> {
    const db = await getDb();
    const id = newId();
    await db.execute(
      `INSERT INTO workflow_events
        (id, workflow_run_id, conversation_id, event_type, payload_json, created_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, input.workflowRunId, input.conversationId, input.eventType, JSON.stringify(input.payload), now()],
    );
    return id;
  },

  async listEvents(workflowRunId: string): Promise<WorkflowEvent[]> {
    const db = await getDb();
    const rows = await db.select<WorkflowEventRow[]>(
      "SELECT * FROM workflow_events WHERE workflow_run_id = $1 ORDER BY created_at ASC",
      [workflowRunId],
    );
    return rows.map(mapWorkflowEventRow);
  },

  async getAuditSummary(workflowRunId: string): Promise<WorkflowAuditSummary | null> {
    const run = await this.getById(workflowRunId);
    if (!run) return null;
    const events = await this.listEvents(workflowRunId);
    return deriveWorkflowAuditSummary({
      snapshot: run.snapshot,
      events: events.map((event) => ({
        id: event.id,
        eventType: event.eventType,
        createdAt: event.createdAt,
        payloadJson: event.payloadJson,
      })),
    });
  },
};
