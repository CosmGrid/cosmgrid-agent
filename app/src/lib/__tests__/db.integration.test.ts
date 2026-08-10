// db.ts 集成测试：用 node:sqlite 真跑 SQL（不是浅 mock execute）
// 覆盖此前 0% 的表 + initSchema 全部 DDL。$N 占位符转 ? 按出现顺序绑定（支持重复 $1）。
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";

type SqlVal = string | number | bigint | null | Uint8Array;

const sqlite = new DatabaseSync(":memory:");

function bind(sql: string, params: unknown[] = []): { sql: string; values: SqlVal[] } {
  const values: SqlVal[] = [];
  const converted = sql.replace(/\$(\d+)/g, (_m, n: string) => {
    values.push((params[Number(n) - 1] ?? null) as SqlVal);
    return "?";
  });
  return { sql: converted, values };
}

const adapter = {
  execute: async (sql: string, params?: unknown[]) => {
    const { sql: s, values } = bind(sql, params);
    const info = sqlite.prepare(s).run(...values);
    return { rowsAffected: Number(info.changes), lastInsertId: Number(info.lastInsertRowid) };
  },
  select: async <T>(sql: string, params?: unknown[]): Promise<T> => {
    const { sql: s, values } = bind(sql, params);
    return sqlite.prepare(s).all(...values) as T;
  },
};

vi.mock("@tauri-apps/plugin-sql", () => ({
  default: { load: vi.fn(async () => adapter) },
}));

const db = await import("../db");
const retrieval = await import("../memory/retrieval");
const workflowTemplate = await import("../workflow/code-task-template");

beforeAll(async () => {
  await db.initSchema();
});

describe("initSchema", () => {
  it("建出全部核心表", async () => {
    const tables = (
      await adapter.select<Array<{ name: string }>>(
        "SELECT name FROM sqlite_master WHERE type='table'",
      )
    ).map((r) => r.name);
    for (const t of [
      "providers",
      "api_credentials",
      "models",
      "conversations",
      "messages",
      "usage_events",
      "model_performance_stats",
      "semantic_cache",
      "debate_sessions",
      "tool_executions",
      "workspace_configs",
      "project_memories",
      "project_memory_vectors",
      "workflow_runs",
      "workflow_events",
      "intent_examples",
      "intent_feedback_events",
    ]) {
      expect(tables).toContain(t);
    }
  });

  it("不再建已删的死表 conversation_model_snapshots", async () => {
    const tables = (
      await adapter.select<Array<{ name: string }>>(
        "SELECT name FROM sqlite_master WHERE type='table'",
      )
    ).map((r) => r.name);
    expect(tables).not.toContain("conversation_model_snapshots");
  });

  it("记录 schema 迁移版本并补齐历史增量列", async () => {
    const migrationRows = await adapter.select<Array<{ version: string }>>(
      "SELECT version FROM schema_migrations ORDER BY version ASC",
    );
    expect(migrationRows.map((r) => r.version)).toEqual([
      "202607010001-conversation-orchestration-workspace",
      "202607010002-message-attachments-chain-kind",
      "202607010003-usage-event-routing-pricing",
      "202607010004-semantic-cache-provider",
      "202607010005-savings-price-catalog-links",
      "202607040001-tool-execution-message-id",
      "202607040002-conversation-archived-at",
      "202607040003-message-tool-call-count",
      "202607090001-mcp-secret-credential",
      // 阶段2（2026-07-11）：tool_executions 加 result_json + error_code 两列
      "202607110001-tool-execution-result-v2",
      "202607110002-tool-execution-error-code",
      // 阶段2 code-review-loop：listByMessage 全表扫补索引
      "202607110003-tool-execution-msg-error-index",
      // 阶段3（2026-07-11）：证据链 workflow_evidence 表 schema 预留
      "202607120001-evidence-store",
      // 阶段5（2026-07-11）：上下文 Playbook 9 字段 + memory_playbook_events 表
      "202607120002-project-memories-playbook-fields",
      "202607120003-memory-playbook-events",
      // 引擎化改造方案阶段 0（2026-07-12）：策略引擎抽象层（2 表）
      "202607120010-policy-overrides",
      "202607120011-policy-override-history",
      // 引擎化改造方案阶段 1b（2026-07-12）：Skill 引擎化（2 表）
      "202607120020-skill-definitions",
      "202607120021-skill-audit-log",
      // 阶段4（2026-07-11）：任务级 Eval Harness（4 表 + usage_events.latency_ms）
      "202607130001-eval-cases",
      "202607130002-eval-runs",
      "202607130003-eval-results",
      "202607130004-task-outcomes",
      "202607130005-usage-events-latency",
      // 阶段6（2026-07-11）：模型 Harness Profile（2 表 + model_performance_stats 拆 4 指标）
      "202607160001-model-harness-profiles",
      "202607160002-model-harness-profile-events",
      "202607160003-model-perf-stats-4-indicators",
      // 阶段7/8（2026-07-11）：Agent Job + 受控 Harness 候选优化
      "202607170001-agent-jobs",
      "202607180001-harness-candidates",
      "202607180002-harness-version-single-active",
    ]);

    const usageColumns = await adapter.select<Array<{ name: string }>>("PRAGMA table_info(usage_events)");
    expect(usageColumns.map((c) => c.name)).toEqual(
      expect.arrayContaining(["conversation_id", "role_kind", "pricing_known", "price_catalog_id", "outcome"]),
    );

    const messageColumns = await adapter.select<Array<{ name: string }>>("PRAGMA table_info(messages)");
    expect(messageColumns.map((c) => c.name)).toEqual(
      expect.arrayContaining(["actor_role", "chain_step_index", "chain_step_total", "chain_done", "kind", "tool_call_count"]),
    );

    const mcpColumns = await adapter.select<Array<{ name: string }>>("PRAGMA table_info(mcp_servers)");
    expect(mcpColumns.map((c) => c.name)).toContain("secret_credential_id");
  });
});

describe("mcpServers", () => {
  it("rejects non-HTTP remote transports at the database boundary", async () => {
    await expect(db.mcpServers.create({
      name: "unsafe",
      transport: "remote_http",
      url: "file:///tmp/mcp",
    })).rejects.toThrow("http or https");
  });

  it("stores only a keychain credential reference, never header/env secret values", async () => {
    const server = await db.mcpServers.create({
      name: "secure MCP",
      transport: "remote_http",
      url: "https://example.test/mcp",
      headers: { Authorization: "Bearer should-not-enter-sqlite" },
      env: { TOKEN: "should-not-enter-sqlite" },
      secretCredentialId: "mcp-server:secure",
    });
    expect(server.headers).toEqual({});
    expect(server.env).toEqual({});
    expect(server.secretCredentialId).toBe("mcp-server:secure");

    const raw = await adapter.select<Array<{ headers_json: string; env_json: string }>>(
      "SELECT headers_json, env_json FROM mcp_servers WHERE id = $1",
      [server.id],
    );
    expect(raw[0]).toEqual({ headers_json: "{}", env_json: "{}" });
  });

  it("persists and revokes workspace-scoped launch approvals", async () => {
    const server = await db.mcpServers.create({
      name: "local MCP",
      transport: "local_stdio",
      command: "node",
      args: ["server.js"],
    });
    const approval = {
      serverId: server.id,
      workspacePath: "/workspace-a",
      configFingerprint: "fingerprint",
    };
    expect(await db.mcpServerApprovals.isApproved(approval)).toBe(false);
    await db.mcpServerApprovals.approve(approval);
    expect(await db.mcpServerApprovals.isApproved(approval)).toBe(true);
    await db.mcpServers.setEnabled(server.id, false);
    expect(await db.mcpServerApprovals.isApproved(approval)).toBe(false);
  });
});

describe("workflowRuns", () => {
  it("create / getActiveByConversation / saveSnapshot / events", async () => {
    const conv = await db.conversations.create({ title: "workflow conv", projectId: null });
    const runId = crypto.randomUUID();
    const snapshot = workflowTemplate.createCodeTaskWorkflowSnapshot({
      runId,
      conversationId: conv.id,
      objective: "看项目并制定方案",
      workspacePath: "/tmp/demo",
    });

    const created = await db.workflowRuns.create({ conversationId: conv.id, snapshot });
    expect(created.id).toBe(runId);
    expect(created.status).toBe("running");
    expect(created.currentPhase).toBe("read_project");
    expect(created.snapshot.context.workspacePath).toBe("/tmp/demo");

    const active = await db.workflowRuns.getActiveByConversation(conv.id);
    expect(active?.id).toBe(runId);

    const next = {
      ...snapshot,
      status: "waiting_user" as const,
      currentNodeId: "plan",
      nodes: snapshot.nodes.map((n) =>
        n.id === "read_project" ? { ...n, status: "done" as const }
          : n.id === "plan" ? { ...n, status: "waiting_user" as const }
          : n,
      ),
    };
    await db.workflowRuns.saveSnapshot({
      runId,
      snapshot: next,
      eventType: "workflow.node_waiting_user",
      eventPayload: { nodeId: "plan" },
    });

    const updated = await db.workflowRuns.getById(runId);
    expect(updated?.status).toBe("waiting_user");
    expect(updated?.currentPhase).toBe("plan");

    const events = await db.workflowRuns.listEvents(runId);
    expect(events.map((e) => e.eventType)).toEqual([
      "workflow.created",
      "workflow.node_waiting_user",
    ]);

    const audit = await db.workflowRuns.getAuditSummary(runId);
    expect(audit).toMatchObject({
      runId,
      conversationId: conv.id,
      status: "waiting_user",
      currentPhase: "plan",
      objective: "看项目并制定方案",
      latestEventType: "workflow.node_waiting_user",
    });
    expect(audit?.eventCounts).toMatchObject({
      "workflow.created": 1,
      "workflow.node_waiting_user": 1,
    });
  });
});

describe("intentLearning", () => {
  it("records feedback events and persists corrected examples", async () => {
    const eventId = await db.intentLearning.recordFeedback({
      userText: "不是，我不是要博弈，我是要评审",
      predictedAction: "debate",
      correctedAction: "review",
      workflowState: "plan",
      source: "user_text",
      reason: "用户明确纠正了系统误判",
    });

    expect(eventId).toBeTruthy();

    const example = await db.intentLearning.upsertExample({
      action: "review",
      text: "不是，我不是要博弈，我是要评审",
      explanation: "用户把误触发的博弈纠正为评审。",
      source: "user_correction",
      confidence: 0.9,
      weight: 1.2,
      enabled: true,
    });

    expect(example.id).toBeTruthy();
    expect(example.action).toBe("review");
    expect(example.source).toBe("user_correction");

    const examples = await db.intentLearning.listExamples();
    expect(examples.some((e) => e.id === example.id && e.text.includes("评审"))).toBe(true);

    const events = await db.intentLearning.listFeedbackEvents();
    expect(events.some((e) => e.id === eventId && e.correctedAction === "review")).toBe(true);
  });
});

describe("conversations + 主对话", () => {
  it("create / list", async () => {
    const c = await db.conversations.create({ title: "测试会话", projectId: null });
    expect(c.id).toBeTruthy();
    expect(c.title).toBe("测试会话");
    const all = await db.conversations.list();
    expect(all.some((x) => x.id === c.id)).toBe(true);
  });

  it("getOrCreateMainChat 幂等：第二次返回同一条", async () => {
    const a = await db.conversations.getOrCreateMainChat("m1");
    const b = await db.conversations.getOrCreateMainChat("m2");
    expect(a.id).toBe(b.id);
    expect(a.projectId).toBeNull();
  });

  it("listMainChats 只列无项目会话 + rename/touch 排到最前 + archive 是软删除不动消息", async () => {
    const c1 = await db.conversations.create({ title: "会话1", projectId: null });
    const c2 = await db.conversations.create({ title: "会话2", projectId: null });
    // 带项目的会话不应出现在主对话列表
    const proj = await db.projects.create({ name: "x" });
    await db.conversations.create({ title: "项目会话", projectId: proj.id });

    const mains = await db.conversations.listMainChats();
    expect(mains.every((c) => c.projectId === null)).toBe(true);
    expect(mains.some((c) => c.id === c1.id)).toBe(true);
    expect(mains.some((c) => c.title === "项目会话")).toBe(false);

    // rename 改标题；touch 不报错
    await db.conversations.rename(c1.id, "会话1-改");
    await db.conversations.touch(c1.id);
    const afterRename = await db.conversations.listMainChats();
    expect(afterRename.find((c) => c.id === c1.id)!.title).toBe("会话1-改");

    // archive 是软删除：先放条消息，归档后列表里消失，但消息还在（不是真 DELETE，不会
    // 出现"删了、重装后又出现"这种 UI 和库状态不一致的情况）
    await db.messages.create({ conversationId: c2.id, role: "user", content: "hi" });
    await db.conversations.archive(c2.id);
    expect((await db.conversations.listMainChats()).some((c) => c.id === c2.id)).toBe(false);
    expect((await db.conversations.list()).some((c) => c.id === c2.id)).toBe(false);
    expect(await db.messages.listByConversation(c2.id)).toHaveLength(1);
  });

  it("setDefaultModelId 会持久化会话默认模型", async () => {
    const conv = await db.conversations.create({ title: "默认模型会话", projectId: null, defaultModelId: "m1" });
    expect(conv.defaultModelId).toBe("m1");
    await db.conversations.setDefaultModelId(conv.id, "m2");
    const updated = await db.conversations.getById(conv.id);
    expect(updated?.defaultModelId).toBe("m2");
  });

  it("阶段 E3：chain 角色消息元数据能落库并恢复", async () => {
    const conv = await db.conversations.create({ title: "chain message", projectId: null });
    const msg = await db.messages.create({
      conversationId: conv.id,
      role: "assistant",
      content: "前端已完成按钮调整",
      actorRole: "frontend",
      chainStepIndex: 2,
      chainStepTotal: 3,
      chainDone: true,
    });

    expect(msg.actorRole).toBe("frontend");
    expect(msg.chainStepIndex).toBe(2);
    expect(msg.chainStepTotal).toBe(3);
    expect(msg.chainDone).toBe(true);

    const restored = await db.messages.listByConversation(conv.id);
    expect(restored.find((m) => m.id === msg.id)).toMatchObject({
      actorRole: "frontend",
      chainStepIndex: 2,
      chainStepTotal: 3,
      chainDone: true,
    });
  });

  it("消息的 kind 标记（如 system-notice）能落库并恢复，不会在重新加载后变回普通 chat", async () => {
    const conv = await db.conversations.create({ title: "kind message", projectId: null });
    const msg = await db.messages.create({
      conversationId: conv.id,
      role: "assistant",
      content: "已保存到桌面：/Users/x/Desktop/foo.md",
      kind: "system-notice",
    });
    expect(msg.kind).toBe("system-notice");

    const restored = await db.messages.listByConversation(conv.id);
    expect(restored.find((m) => m.id === msg.id)).toMatchObject({ kind: "system-notice" });
  });

  it("不传 kind 时落库为 null，恢复后不会被误判为 system-notice", async () => {
    const conv = await db.conversations.create({ title: "no kind message", projectId: null });
    const msg = await db.messages.create({ conversationId: conv.id, role: "assistant", content: "正常回答" });
    expect(msg.kind).toBeNull();
  });

  it("阶段 E3：chain 消息可更新完成状态，空更新返回原消息，缺失 id 返回 null", async () => {
    const conv = await db.conversations.create({ title: "chain update", projectId: null });
    const msg = await db.messages.create({
      conversationId: conv.id,
      role: "assistant",
      content: "",
      actorRole: "runner",
      chainStepIndex: 3,
      chainStepTotal: 3,
      chainDone: false,
    });

    const unchanged = await db.messages.updateChainMessage(msg.id, {});
    expect(unchanged?.content).toBe("");
    expect(unchanged?.chainDone).toBe(false);

    const updated = await db.messages.updateChainMessage(msg.id, {
      content: "测试通过",
      chainDone: true,
      inputTokens: 11,
      outputTokens: 22,
      cost: 0.03,
      modelId: "m-runner",
    });
    expect(updated).toMatchObject({
      content: "测试通过",
      chainDone: true,
      inputTokens: 11,
      outputTokens: 22,
      cost: 0.03,
      modelId: "m-runner",
    });

    expect(await db.messages.updateChainMessage("missing-message", { content: "x" })).toBeNull();
  });

  it("orchestration 列存在且读写 JSON 往返", async () => {
    const c = await db.conversations.create({ title: "c-orch", projectId: null });
    // 初始为空
    expect(await db.conversations.getOrchestration(c.id)).toBeNull();
    // 写入再读出
    const json = JSON.stringify({ version: 1, nodes: [{ id: "n1", kind: "planning" }], currentNodeId: "n1" });
    await db.conversations.saveOrchestration(c.id, json);
    expect(await db.conversations.getOrchestration(c.id)).toBe(json);
  });

  it("saveOrchestration 不 bump updated_at（后台编排不顶到侧栏最前）", async () => {
    const c = await db.conversations.create({ title: "orch-ts", projectId: null });
    const before = (await db.conversations.list()).find((x) => x.id === c.id)!.updatedAt;
    await db.conversations.saveOrchestration(c.id, JSON.stringify({ version: 1, nodes: [], currentNodeId: null }));
    const after = (await db.conversations.list()).find((x) => x.id === c.id)!.updatedAt;
    expect(after).toBe(before);
  });
});

describe("messages", () => {
  it("create + listByConversation 按时间升序", async () => {
    const conv = await db.conversations.create({ title: "c-msg" });
    await db.messages.create({ conversationId: conv.id, role: "user", content: "你好" });
    await db.messages.create({
      conversationId: conv.id,
      role: "assistant",
      content: "回答",
      modelId: "gpt",
      inputTokens: 10,
      outputTokens: 20,
    });
    const list = await db.messages.listByConversation(conv.id);
    expect(list).toHaveLength(2);
    expect(list[0]!.role).toBe("user");
    expect(list[1]!.content).toBe("回答");
    expect(list[1]!.outputTokens).toBe(20);
  });
});

describe("usageEvents", () => {
  it("create + list", async () => {
    await db.usageEvents.create({ modelId: "mA", role: "main_chat", inputTokens: 5, outputTokens: 7, cost: 0.01 });
    const list = await db.usageEvents.list();
    expect(list.some((e) => e.modelId === "mA")).toBe(true);
  });

  it("setOutcomeForLatest 给最近一条无 outcome 的事件打标，返回 taskType", async () => {
    await db.usageEvents.create({ modelId: "mB", role: "hard_task" });
    const res = await db.usageEvents.setOutcomeForLatest("mB", "switched_up");
    expect(res).not.toBeNull();
    expect(res!.taskType).toBe("hard_task");
    // 已打标后再调用应找不到（无 outcome IS NULL 的）
    const again = await db.usageEvents.setOutcomeForLatest("mB", "accepted");
    expect(again).toBeNull();
  });

  it("list(sinceTs) 过滤掉更早的事件", async () => {
    const since = new Date(Date.now() + 60_000).toISOString(); // 未来时间，应过滤掉所有现有
    const list = await db.usageEvents.list(since);
    expect(list).toHaveLength(0);
  });

  it("阶段 F1：role_kind 字段写入 → 读取保留", async () => {
    // 创建时带 roleKind
    const id = await db.usageEvents.create({
      modelId: "mC", role: "main_chat", roleKind: "leader",
      inputTokens: 100, outputTokens: 50, cost: 0.02,
    });
    const list = await db.usageEvents.list();
    const e = list.find((x) => x.id === id);
    expect(e?.roleKind).toBe("leader");
  });

  it("阶段 F1：role_kind 不传 → 落 NULL（旧数据兼容）", async () => {
    const id = await db.usageEvents.create({
      modelId: "mD", role: "main_chat",
      // 没传 roleKind
    });
    const list = await db.usageEvents.list();
    const e = list.find((x) => x.id === id);
    expect(e?.roleKind).toBeNull();
  });

  it("阶段 F1：role_kind='stage'（ProjectDetailPage 路径）能落库", async () => {
    const id = await db.usageEvents.create({
      modelId: "mE", role: "hard_task", roleKind: "stage",
    });
    const list = await db.usageEvents.list();
    expect(list.find((x) => x.id === id)?.roleKind).toBe("stage");
  });

  it("阶段 F3：conversationId 能落库，账单可追到具体会话", async () => {
    const conv = await db.conversations.create({ title: "usage-conv", projectId: null });
    const id = await db.usageEvents.create({
      conversationId: conv.id,
      modelId: "mConv",
      role: "main_chat",
      roleKind: "leader",
      inputTokens: 10,
      outputTokens: 20,
      cost: 0.01,
    });
    const list = await db.usageEvents.list();
    expect(list.find((x) => x.id === id)?.conversationId).toBe(conv.id);
  });

  it("用量监控：pricingKnown=false 能落库，避免未知价格被当成免费", async () => {
    const id = await db.usageEvents.create({
      modelId: "unknown-price-model",
      cost: 0,
      pricingKnown: false,
    });
    const list = await db.usageEvents.list();
    expect(list.find((x) => x.id === id)?.pricingKnown).toBe(false);
  });

  it("用量监控：list 返回 provider / credential / cache token，供套餐自动汇总", async () => {
    const id = await db.usageEvents.create({
      providerId: "provider-auto",
      apiCredentialId: "cred-auto",
      modelId: "mAuto",
      inputTokens: 10,
      outputTokens: 20,
      cacheCreationTokens: 3,
      cacheHitTokens: 7,
      cost: 0.02,
    });
    const row = (await db.usageEvents.list()).find((x) => x.id === id)!;
    expect(row.providerId).toBe("provider-auto");
    expect(row.apiCredentialId).toBe("cred-auto");
    expect(row.cacheCreationTokens).toBe(3);
    expect(row.cacheHitTokens).toBe(7);
  });

  it("价格目录：priceVersion / priceSource 会随 usage_event 落库", async () => {
    const id = await db.usageEvents.create({
      modelId: "m-priced",
      cost: 0.02,
      pricingKnown: true,
      priceVersion: "remote:2026-06-28",
      priceSource: "remote",
      priceCatalogId: "price-row-1",
    });
    const row = (await db.usageEvents.list()).find((x) => x.id === id)!;
    expect(row.priceVersion).toBe("remote:2026-06-28");
    expect(row.priceSource).toBe("remote");
    expect(row.priceCatalogId).toBe("price-row-1");
  });
});

describe("modelPriceCatalog + priceSyncStatus", () => {
  beforeEach(() => {
    sqlite.exec("DELETE FROM model_price_catalog");
    sqlite.exec("DELETE FROM price_sync_status");
  });

  it("手动价格可写入并按模型名查到", async () => {
    await db.modelPriceCatalog.create({
      modelName: "custom-model",
      providerType: "openai-compatible",
      inputPer1m: 0.5,
      outputPer1m: 2,
      source: "manual",
      version: "manual:test",
    });

    const row = await db.modelPriceCatalog.lookupActive("custom-model", "openai-compatible");
    expect(row).toMatchObject({
      modelName: "custom-model",
      providerType: "openai-compatible",
      inputPer1m: 0.5,
      outputPer1m: 2,
      source: "manual",
    });
  });

  it("同步状态会保留最近成功时间和失败原因", async () => {
    await db.priceSyncStatus.upsert({
      source: "models.dev",
      sourceUrl: "https://models.dev/api.json",
      lastAttemptAt: "2026-06-28T00:00:00.000Z",
      lastSuccessAt: "2026-06-28T00:00:01.000Z",
      lastError: "network timeout",
      catalogVersion: "models.dev:2026-06-28",
    });

    expect(await db.priceSyncStatus.get()).toMatchObject({
      source: "models.dev",
      lastSuccessAt: "2026-06-28T00:00:01.000Z",
      lastError: "network timeout",
      catalogVersion: "models.dev:2026-06-28",
    });
  });

  it("价格目录可按版本汇总，保留历史版本和当前启用版本", async () => {
    await db.modelPriceCatalog.create({
      modelName: "old-model-a",
      providerType: "openai",
      inputPer1m: 1,
      outputPer1m: 2,
      source: "remote",
      version: "models.dev:old",
      enabled: false,
    });
    await db.modelPriceCatalog.create({
      modelName: "new-model-a",
      providerType: "openai",
      inputPer1m: 1.5,
      outputPer1m: 2.5,
      source: "remote",
      version: "models.dev:new",
      enabled: true,
    });
    await db.modelPriceCatalog.create({
      modelName: "new-model-b",
      providerType: "anthropic",
      inputPer1m: 3,
      outputPer1m: 15,
      source: "remote",
      version: "models.dev:new",
      enabled: true,
    });

    await expect(db.modelPriceCatalog.listVersions()).resolves.toEqual([
      expect.objectContaining({
        source: "remote",
        version: "models.dev:new",
        entryCount: 2,
        enabledCount: 2,
      }),
      expect.objectContaining({
        source: "remote",
        version: "models.dev:old",
        entryCount: 1,
        enabledCount: 0,
      }),
    ]);
  });
});

describe("savingsEvents", () => {
  beforeEach(() => {
    sqlite.exec("DELETE FROM savings_events");
  });

  it("省钱明细会落库并可按类型读取", async () => {
    await db.savingsEvents.create({
      usageEventId: "usage-1",
      conversationId: "conv-1",
      projectId: "proj-1",
      kind: "cache",
      baselineModelId: "claude-sonnet",
      actualModelId: "claude-sonnet",
      baselineCost: 0.05,
      actualCost: 0.02,
      savedCost: 0.03,
      formulaVersion: "cache-v1",
      actualPriceCatalogId: "price-actual",
      baselinePriceCatalogId: "price-baseline",
      explainJson: JSON.stringify({ cacheHitTokens: 1000 }),
    });

    expect(await db.savingsEvents.list()).toMatchObject([
      {
        usageEventId: "usage-1",
        kind: "cache",
        savedCost: 0.03,
        formulaVersion: "cache-v1",
        actualPriceCatalogId: "price-actual",
        baselinePriceCatalogId: "price-baseline",
      },
    ]);
  });

  it("省钱汇总会标出可追溯覆盖率和缺价格引用的记录", async () => {
    await db.savingsEvents.create({
      usageEventId: "usage-1",
      kind: "cache",
      baselineModelId: "claude-sonnet",
      actualModelId: "claude-sonnet",
      baselineCost: 0.05,
      actualCost: 0.02,
      savedCost: 0.03,
      formulaVersion: "cache-v1",
      actualPriceCatalogId: "price-actual",
      baselinePriceCatalogId: "price-baseline",
      explainJson: JSON.stringify({ cacheHitTokens: 1000 }),
    });
    await db.savingsEvents.create({
      usageEventId: "usage-2",
      kind: "routing",
      baselineModelId: "gpt-5",
      actualModelId: "gpt-5-mini",
      baselineCost: 0.10,
      actualCost: 0.04,
      savedCost: 0.06,
      formulaVersion: "routing-v1",
      actualPriceCatalogId: null,
      baselinePriceCatalogId: "price-baseline",
      explainJson: JSON.stringify({ baselineModelId: "gpt-5", actualModelId: "gpt-5-mini" }),
    });

    await expect(db.savingsEvents.summary()).resolves.toEqual({
      eventCount: 2,
      totalSavedCost: 0.09,
      traceableEventCount: 1,
      missingPriceCatalogEventCount: 1,
      byKind: [
        { kind: "routing", eventCount: 1, totalSavedCost: 0.06 },
        { kind: "cache", eventCount: 1, totalSavedCost: 0.03 },
      ],
    });
  });
});

describe("cliSessions", () => {
  beforeEach(() => {
    sqlite.exec("DELETE FROM cli_sessions");
  });

  it("官方 CLI session/thread id 会落库并可更新状态", async () => {
    await db.cliSessions.upsert({
      providerType: "claude-cli",
      conversationId: "conv-1",
      projectId: "proj-1",
      officialSessionId: "sess-1",
      modelName: "claude-sonnet",
      program: "claude",
      status: "active",
    });
    await db.cliSessions.upsert({
      providerType: "claude-cli",
      conversationId: "conv-1",
      projectId: "proj-1",
      officialSessionId: "sess-1",
      modelName: "claude-sonnet",
      program: "claude",
      status: "completed",
    });

    expect(await db.cliSessions.list()).toMatchObject([
      {
        providerType: "claude-cli",
        officialSessionId: "sess-1",
        status: "completed",
      },
    ]);
  });
});

describe("阶段 F1：aggregateUsageByActorRole（端到端集成）", () => {
  // beforeEach 清表：测试用同一个 sqlite in-memory，跨 it 累积会污染断言
  beforeEach(async () => {
    // 直接走 sqlite.prepare 清（adapter 不暴露通用 DELETE）
    sqlite.exec("DELETE FROM usage_events");
  });

  it("★ 必查：3 跳 chain + 1 nudge 重答 → DB role_kind 落对 → 聚合分对", async () => {
    // 模拟 E2a runChain 3 跳 chain：architect → frontend → backend
    // + 第 2 跳 nudge 重答（同一 frontend 角色再来一次）
    await db.usageEvents.create({ modelId: "mA", role: "planning", roleKind: "architect", cost: 0.10 });
    await db.usageEvents.create({ modelId: "mB", role: "frontend", roleKind: "frontend", cost: 0.20 });
    // nudge 重答同一 frontend
    await db.usageEvents.create({ modelId: "mB", role: "frontend", roleKind: "frontend", cost: 0.20 });
    await db.usageEvents.create({ modelId: "mC", role: "backend", roleKind: "backend", cost: 0.15 });

    // 聚合（动态 import 避免循环依赖——测试直接在 db 上下文里 import）
    const { aggregateUsageByActorRole } = await import("../llm/usage-stats");
    const result = await aggregateUsageByActorRole({});

    // 期望：3 个 roleKind（architect/frontend/backend），frontend totalCost=0.40 (nudge 累加)
    expect(result).toHaveLength(3);
    const architect = result.find((r) => r.roleKind === "architect");
    const frontend = result.find((r) => r.roleKind === "frontend");
    const backend = result.find((r) => r.roleKind === "backend");
    expect(architect?.totalCost).toBeCloseTo(0.10);
    expect(frontend?.totalCost).toBeCloseTo(0.40); // ★ nudge 重答累加
    expect(backend?.totalCost).toBeCloseTo(0.15);
    // 同 roleKind + 同 modelId 合并一行（nudge 累加）：rows[0].cost = 0.40 (0.20+0.20)
    expect(frontend?.rows[0]!.cost).toBeCloseTo(0.40);
    expect(frontend?.rows[0]!.calls).toBe(2);
  });

  it("★ 必查：ChatPage 主对话 leader actor_role='leader' 落库 + 聚合独立组", async () => {
    await db.usageEvents.create({ modelId: "mLeader", role: "main_chat", roleKind: "leader", cost: 0.05 });

    const { aggregateUsageByActorRole } = await import("../llm/usage-stats");
    const result = await aggregateUsageByActorRole({});
    const leaderGroup = result.find((r) => r.roleKind === "leader");
    expect(leaderGroup).toBeDefined();
    expect(leaderGroup?.totalCost).toBeCloseTo(0.05);
  });

  it("★ 必查：ProjectDetailPage stage actor_role='stage' 落库 + 聚合独立组（跟 leader 可分）", async () => {
    await db.usageEvents.create({ modelId: "mLeader", role: "main_chat", roleKind: "leader", cost: 0.05 });
    await db.usageEvents.create({ modelId: "mStage", role: "hard_task", roleKind: "stage", cost: 0.10 });

    const { aggregateUsageByActorRole } = await import("../llm/usage-stats");
    const result = await aggregateUsageByActorRole({});
    expect(result.find((r) => r.roleKind === "leader")?.totalCost).toBeCloseTo(0.05);
    expect(result.find((r) => r.roleKind === "stage")?.totalCost).toBeCloseTo(0.10);
  });

  it("★ 必查：NULL roleKind 当独立'未分类'组（不过滤），排最后", async () => {
    await db.usageEvents.create({ modelId: "mA", role: "main_chat", roleKind: "leader", cost: 0.05 });
    await db.usageEvents.create({ modelId: "mB", role: "main_chat", cost: 0.03 }); // roleKind=NULL（旧数据）

    const { aggregateUsageByActorRole } = await import("../llm/usage-stats");
    const result = await aggregateUsageByActorRole({});
    // 2 个组：leader + NULL
    expect(result).toHaveLength(2);
    expect(result[0]!.roleKind).toBe("leader");
    expect(result[1]!.roleKind).toBeNull(); // NULL 排最后
    // modelId 实际是 "mB"（测试创建时设了 modelId）—— (unknown model) 占位只在 modelId 真为 NULL 时触发
    expect(result[1]!.rows[0]!.modelId).toBe("mB");
  });

  it("projectId 过滤聚合", async () => {
    await db.usageEvents.create({ modelId: "m1", projectId: "pA", roleKind: "leader", cost: 0.01 });
    await db.usageEvents.create({ modelId: "m2", projectId: "pB", roleKind: "leader", cost: 0.02 });
    const { aggregateUsageByActorRole } = await import("../llm/usage-stats");
    const result = await aggregateUsageByActorRole({ projectId: "pA" });
    expect(result).toHaveLength(1);
    expect(result[0]!.totalCost).toBeCloseTo(0.01);
  });

  // ====== H4 阶段 F1：aggregateUsageByActorRole 边界（review F1-9）======

  it("★ modelId=NULL → rows[0].modelId='(unknown model)' 占位", async () => {
    await db.usageEvents.create({ roleKind: "leader", cost: 0.05 });
    // 不传 modelId
    const { aggregateUsageByActorRole } = await import("../llm/usage-stats");
    const result = await aggregateUsageByActorRole({});
    expect(result[0]!.rows[0]!.modelId).toBe("(unknown model)");
  });

  it("cost=0 + tokens=0 边界：能聚合不报错", async () => {
    await db.usageEvents.create({ modelId: "mFree", roleKind: "leader", cost: 0, inputTokens: 0, outputTokens: 0 });
    const { aggregateUsageByActorRole } = await import("../llm/usage-stats");
    const result = await aggregateUsageByActorRole({});
    expect(result[0]!.totalCost).toBe(0);
    expect(result[0]!.totalCalls).toBe(1);
  });

  it("未知价格调用数随 roleKind × model 聚合保留", async () => {
    await db.usageEvents.create({ modelId: "mUnknown", roleKind: "leader", cost: 0, pricingKnown: false });
    await db.usageEvents.create({ modelId: "mUnknown", roleKind: "leader", cost: 0.05, pricingKnown: true });
    const { aggregateUsageByActorRole } = await import("../llm/usage-stats");
    const result = await aggregateUsageByActorRole({});
    expect(result[0]!.rows[0]!.unknownPricingCalls).toBe(1);
    expect(result[0]!.rows[0]!.cost).toBeCloseTo(0.05);
  });

  it("★ 同 roleKind + 同 modelId 多行 → SUM 累加正确（5+5+5=15）", async () => {
    await db.usageEvents.create({ modelId: "mA", roleKind: "frontend", cost: 5 });
    await db.usageEvents.create({ modelId: "mA", roleKind: "frontend", cost: 5 });
    await db.usageEvents.create({ modelId: "mA", roleKind: "frontend", cost: 5 });
    const { aggregateUsageByActorRole } = await import("../llm/usage-stats");
    const result = await aggregateUsageByActorRole({});
    const frontend = result.find((r) => r.roleKind === "frontend");
    expect(frontend?.totalCost).toBeCloseTo(15);
    expect(frontend?.totalCalls).toBe(3);
    // 单 modelId 合并到一行
    expect(frontend?.rows).toHaveLength(1);
  });

  it("★ 3 个非 NULL roleKind → 字母序排列（architect < backend < frontend）", async () => {
    await db.usageEvents.create({ modelId: "m", roleKind: "frontend", cost: 0.10 });
    await db.usageEvents.create({ modelId: "m", roleKind: "architect", cost: 0.20 });
    await db.usageEvents.create({ modelId: "m", roleKind: "backend", cost: 0.30 });
    const { aggregateUsageByActorRole } = await import("../llm/usage-stats");
    const result = await aggregateUsageByActorRole({});
    // 字母序：architect < backend < frontend
    expect(result.map((r) => r.roleKind)).toEqual(["architect", "backend", "frontend"]);
  });

  it("★ 同 roleKind 3 个 model → 按 cost DESC 排序（mB>mA>mC）", async () => {
    await db.usageEvents.create({ modelId: "mA", roleKind: "frontend", cost: 0.10 });
    await db.usageEvents.create({ modelId: "mB", roleKind: "frontend", cost: 0.50 });
    await db.usageEvents.create({ modelId: "mC", roleKind: "frontend", cost: 0.01 });
    const { aggregateUsageByActorRole } = await import("../llm/usage-stats");
    const result = await aggregateUsageByActorRole({});
    const frontend = result.find((r) => r.roleKind === "frontend")!;
    expect(frontend.rows.map((r) => r.modelId)).toEqual(["mB", "mA", "mC"]);
  });

  it("★ NULL roleKind × 多 model → 独立'未分类'组 + 多 row 累加", async () => {
    await db.usageEvents.create({ modelId: "mA", cost: 0.05 }); // roleKind 旧数据 NULL
    await db.usageEvents.create({ modelId: "mB", cost: 0.10 }); // roleKind 旧数据 NULL
    await db.usageEvents.create({ modelId: "mA", cost: 0.05 }); // 同 modelId 累加
    const { aggregateUsageByActorRole } = await import("../llm/usage-stats");
    const result = await aggregateUsageByActorRole({});
    const nullGroup = result.find((r) => r.roleKind === null)!;
    expect(nullGroup.totalCost).toBeCloseTo(0.20);
    expect(nullGroup.rows).toHaveLength(2); // mA 合并 + mB
  });

  it("★ stage vs RoleId 共存 → 按 actor_role 字符串精确分组（stage 不被当 RoleId 解析）", async () => {
    await db.usageEvents.create({ modelId: "m", roleKind: "frontend", cost: 0.10 });
    await db.usageEvents.create({ modelId: "m", roleKind: "stage", cost: 0.20 });
    const { aggregateUsageByActorRole } = await import("../llm/usage-stats");
    const result = await aggregateUsageByActorRole({});
    // 2 个独立组：frontend（RoleId）+ stage（命名空间外）
    expect(result).toHaveLength(2);
    expect(result.find((r) => r.roleKind === "frontend")?.totalCost).toBeCloseTo(0.10);
    expect(result.find((r) => r.roleKind === "stage")?.totalCost).toBeCloseTo(0.20);
  });

  it("空表 → 返 []（不崩）", async () => {
    const { aggregateUsageByActorRole } = await import("../llm/usage-stats");
    const result = await aggregateUsageByActorRole({});
    expect(result).toEqual([]);
  });

  it("since 时间过滤：未来时间 → 返 []", async () => {
    await db.usageEvents.create({ modelId: "m", roleKind: "leader", cost: 0.05 });
    const { aggregateUsageByActorRole } = await import("../llm/usage-stats");
    const future = new Date(Date.now() + 60_000).toISOString();
    const result = await aggregateUsageByActorRole({ since: future });
    expect(result).toEqual([]);
  });

  it("projectId + since 同时过滤", async () => {
    const now = new Date();
    const past = new Date(now.getTime() - 60_000).toISOString();
    const future = new Date(now.getTime() + 60_000).toISOString();
    await db.usageEvents.create({ modelId: "m1", projectId: "pA", roleKind: "leader", cost: 0.01 });
    await db.usageEvents.create({ modelId: "m2", projectId: "pB", roleKind: "leader", cost: 0.02 });
    const { aggregateUsageByActorRole } = await import("../llm/usage-stats");
    const result = await aggregateUsageByActorRole({ projectId: "pA", since: past });
    expect(result).toHaveLength(1);
    expect(result[0]!.totalCost).toBeCloseTo(0.01);
    // since=future → 0 条
    const result2 = await aggregateUsageByActorRole({ projectId: "pA", since: future });
    expect(result2).toEqual([]);
  });
});

describe("modelPerformanceStats", () => {
  it("upsert 插入后再 upsert 走 ON CONFLICT 更新", async () => {
    const base = {
      modelId: "mP",
      taskType: "main_chat",
      successRate: 0.9,
      avgInputTokens: 100,
      avgOutputTokens: 200,
      avgCost: 0.02,
      avgLatencyMs: 1200,
      sampleCount: 3,
      windowStart: new Date().toISOString(),
      windowEnd: new Date().toISOString(),
    };
    await db.modelPerformanceStats.upsert(base);
    await db.modelPerformanceStats.upsert({ ...base, successRate: 0.5, sampleCount: 9 });
    const got = await db.modelPerformanceStats.get("mP", "main_chat");
    expect(got).not.toBeNull();
    expect(got!.successRate).toBe(0.5);
    expect(got!.sampleCount).toBe(9);
    const all = await db.modelPerformanceStats.list();
    expect(all.filter((s) => s.modelId === "mP")).toHaveLength(1);
  });

  it("阶段6新增指标未传时从旧 successRate 兼容回填", async () => {
    const base = {
      modelId: "mP2",
      taskType: "main_chat",
      successRate: 0.8,
      avgInputTokens: 100,
      avgOutputTokens: 200,
      avgCost: 0.04,
      avgLatencyMs: 1200,
      sampleCount: 3,
      windowStart: new Date().toISOString(),
      windowEnd: new Date().toISOString(),
    };
    await db.modelPerformanceStats.upsert(base);
    const got = await db.modelPerformanceStats.get("mP2", "main_chat");
    expect(got).toMatchObject({
      transportSuccessRate: 0.8,
      taskSuccessRate: 0.8,
      verifierPassRate: 0.8,
      failureCountByKindJson: "{}",
    });
    expect(got!.costPerSuccess).toBeCloseTo(0.05);
  });
});

describe("modelHarnessProfiles", () => {
  it("只返回已启用 profile / event，并按 harness version 过滤", async () => {
    const profileId = await db.modelHarnessProfiles.create({
      modelId: "m-profile",
      modelName: "profile-model",
      providerId: null,
      providerType: "openai-compatible",
      versionRange: null,
      harnessVersionMin: null,
      harnessVersionMax: null,
      enabled: false,
    });

    expect(await db.modelHarnessProfiles.listEnabled("profile-model")).toEqual([]);
    await db.modelHarnessProfiles.updateEnabled(profileId, true);
    expect(await db.modelHarnessProfiles.listEnabled("profile-model")).toHaveLength(1);

    await db.modelHarnessProfileEvents.create({
      profileId,
      modelId: "m-profile",
      modelName: "profile-model",
      providerType: "openai-compatible",
      failureKind: "no_tool_completion",
      adaptationRule: { kind: "skill_instruction", content: "先调用工具", tags: ["tool"] },
      sourceType: "manual",
      sourceEvalRunId: null,
      sourceEvalResultId: null,
      sourceUsageEventId: null,
      sourceTaskOutcomeId: null,
      sourceToolExecutionId: null,
      failureId: null,
      confidence: 0.9,
      applicableHarnessVersion: ">=2.0",
      enabled: false,
      suggestedAt: new Date().toISOString(),
      approvedAt: null,
    });

    expect(await db.modelHarnessProfileEvents.listEnabledByProfile(profileId, "2.1")).toEqual([]);

    const allEvents = await adapter.select<Array<{ id: string }>>(
      "SELECT id FROM model_harness_profile_events WHERE profile_id = $1",
      [profileId],
    );
    await adapter.execute(
      "UPDATE model_harness_profile_events SET enabled = 1, approved_at = datetime('now') WHERE id = $1",
      [allEvents[0]!.id],
    );

    expect(await db.modelHarnessProfileEvents.listEnabledByProfile(profileId, "1.9")).toEqual([]);
    expect(await db.modelHarnessProfileEvents.listEnabledByProfile(profileId, "2.1")).toHaveLength(1);
  });

  it("按 model/provider/harness version 精确匹配启用 profile", async () => {
    await db.modelHarnessProfiles.create({
      modelId: "m-exact",
      modelName: "exact-profile-model",
      providerId: "provider-a",
      providerType: "openai-compatible",
      versionRange: null,
      harnessVersionMin: "2.0",
      harnessVersionMax: "2.9",
      enabled: true,
    });
    await db.modelHarnessProfiles.create({
      modelId: "m-exact",
      modelName: "exact-profile-model",
      providerId: "provider-b",
      providerType: "openai-compatible",
      versionRange: null,
      harnessVersionMin: "2.0",
      harnessVersionMax: "2.9",
      enabled: true,
    });

    expect(await db.modelHarnessProfiles.listMatching({
      modelId: "m-exact",
      modelName: "exact-profile-model",
      providerId: "provider-b",
      providerType: "openai-compatible",
      harnessVersion: "2.1",
    })).toHaveLength(1);
    expect(await db.modelHarnessProfiles.listMatching({
      modelId: "m-exact",
      modelName: "exact-profile-model",
      providerId: "provider-c",
      providerType: "openai-compatible",
      harnessVersion: "2.1",
    })).toEqual([]);
    expect(await db.modelHarnessProfiles.listMatching({
      modelId: "m-exact",
      modelName: "exact-profile-model",
      providerId: "provider-b",
      providerType: "openai-compatible",
      harnessVersion: "3.0",
    })).toEqual([]);
  });
});

describe("agentJobs", () => {
  it("start / artifact / cancel 都持久化到 job 事件流", async () => {
    const jobId = await db.agentJobs.start({
      workflowRunId: "run-agent",
      role: "critic",
      modelId: "model-a",
      objective: "review proposal",
      inputContextRefsJson: JSON.stringify(["ctx-a"]),
    });

    await db.agentJobs.addArtifact(jobId, {
      kind: "markdown",
      uri: "artifact://review-a",
      summary: "review result",
    });
    await db.agentJobs.cancel(jobId, "parent cancelled");

    const got = await db.agentJobs.getById(jobId);
    expect(got).toMatchObject({
      role: "critic",
      modelId: "model-a",
      status: "cancelled",
      cancellationReason: "parent cancelled",
    });
    expect(await db.agentJobs.listArtifacts(jobId)).toHaveLength(1);
    expect((await db.agentJobs.listEvents(jobId)).map((e) => e.eventType)).toEqual(["started", "cancelled"]);
  });
});

describe("harnessCandidates", () => {
  it("keeps candidate edits and activation decision separate from active harness version", async () => {
    const v1 = await db.harnessVersions.create({ version: "harness-v1", active: true });
    const candidateId = await db.harnessCandidates.create({
      parentVersionId: v1,
      targetFailureKind: "no_tool_completion",
      expectedImprovement: "force evidence before completion",
      riskSummary: "may increase tool calls",
    });
    await db.harnessCandidateEdits.create({
      candidateId,
      surface: "skill_instruction",
      diff: "+ require tool evidence",
    });
    await db.harnessCandidates.updateDecision(candidateId, {
      status: "pending_approval",
      decisionReason: "validated, waiting for user approval",
      heldInResultJson: JSON.stringify({ passed: true }),
      heldOutResultJson: JSON.stringify({ passed: true }),
    });

    expect(await db.harnessVersions.getActive()).toMatchObject({ id: v1, version: "harness-v1" });
    expect(await db.harnessCandidateEdits.listByCandidate(candidateId)).toHaveLength(1);
    expect(await db.harnessCandidates.getById(candidateId)).toMatchObject({
      status: "pending_approval",
      decisionReason: "validated, waiting for user approval",
    });
  });

  it("keeps only one active harness version", async () => {
    await db.harnessVersions.create({ version: "harness-single-active-v1", active: true });
    const v2 = await db.harnessVersions.create({ version: "harness-single-active-v2", active: true });

    const activeRows = await adapter.select<Array<{ id: string }>>(
      "SELECT id FROM harness_versions WHERE active = 1",
    );
    expect(activeRows).toEqual([{ id: v2 }]);
    expect(await db.harnessVersions.getActive()).toMatchObject({
      id: v2,
      version: "harness-single-active-v2",
    });
  });
});

describe("semanticCache", () => {
  it("create / listValid / recordHit / stats", async () => {
    const future = new Date(Date.now() + 3_600_000).toISOString();
    await db.semanticCache.create({
      queryText: "什么是闭包",
      queryEmbedding: [0.1, 0.2, 0.3],
      responseText: "闭包是...",
      modelId: "mC",
      taskType: "main_chat",
      expiresAt: future,
      providerName: "keyword-hash-v2",
    });
    const valid = await db.semanticCache.listValid();
    const row = valid.find((r) => r.queryText === "什么是闭包");
    expect(row).toBeTruthy();
    expect(row!.queryEmbedding).toEqual([0.1, 0.2, 0.3]);
    expect(row!.providerName).toBe("keyword-hash-v2");

    await db.semanticCache.recordHit(row!.id);
    const after = (await db.semanticCache.listValid()).find((r) => r.id === row!.id);
    expect(after!.hitCount).toBe(1);

    const stats = await db.semanticCache.stats();
    expect(stats.entries).toBeGreaterThanOrEqual(1);
    expect(stats.totalHits).toBeGreaterThanOrEqual(1);
  });

  it("deleteExpired 删掉过期条目，保留未过期", async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    await db.semanticCache.create({
      queryText: "过期项",
      queryEmbedding: [0],
      responseText: "x",
      modelId: "mC",
      taskType: "main_chat",
      expiresAt: past,
    });
    await db.semanticCache.deleteExpired();
    const valid = await db.semanticCache.listValid();
    expect(valid.some((r) => r.queryText === "过期项")).toBe(false);
  });
});

describe("debateSessions", () => {
  it("create / getById / list / delete", async () => {
    const id = await db.debateSessions.create({
      topic: "选 React 还是 Vue",
      quickMode: true,
      rounds: [{ role: "solver", modelId: "mS", content: "React", inputTokens: 1, outputTokens: 2 }],
      finalSolution: "React",
    });
    const got = await db.debateSessions.getById(id);
    expect(got).not.toBeNull();
    expect(got!.quickMode).toBe(true);
    expect(got!.rounds).toHaveLength(1);
    expect(got!.rounds[0]!.role).toBe("solver");

    const list = await db.debateSessions.list();
    expect(list.some((d) => d.id === id)).toBe(true);

    await db.debateSessions.delete(id);
    expect(await db.debateSessions.getById(id)).toBeNull();
  });
});

describe("toolExecutions", () => {
  it("create / list / listByConversation", async () => {
    const conv = await db.conversations.create({ title: "c-tool" });
    await db.toolExecutions.create({
      conversationId: conv.id,
      toolName: "read",
      input: "{}",
      output: "file content",
      status: "success",
      userConfirmed: true,
      reversible: false,
      durationMs: 42,
    });
    const byConv = await db.toolExecutions.listByConversation(conv.id);
    expect(byConv).toHaveLength(1);
    expect(byConv[0]!.toolName).toBe("read");
    expect(byConv[0]!.userConfirmed).toBe(true);
    const recent = await db.toolExecutions.list();
    expect(recent.some((t) => t.conversationId === conv.id)).toBe(true);
  });
});

describe("workspaceConfigs", () => {
  it("set/getBlockedCommands + upsert 覆盖", async () => {
    const pid = "proj-ws";
    expect(await db.workspaceConfigs.getBlockedCommands(pid)).toEqual([]);
    await db.workspaceConfigs.setBlockedCommands(pid, ["rm", "curl"]);
    expect(await db.workspaceConfigs.getBlockedCommands(pid)).toEqual(["rm", "curl"]);
    await db.workspaceConfigs.setBlockedCommands(pid, ["wget"]);
    expect(await db.workspaceConfigs.getBlockedCommands(pid)).toEqual(["wget"]);
  });
});

describe("projectMemories", () => {
  it("create / listByProject 按 importance 降序 / getById / update / delete", async () => {
    const proj = await db.projects.create({ name: "mem-proj" });
    await db.projectMemories.create({ projectId: proj.id, kind: "lesson", title: "低", content: "c1", importance: 10 });
    const hi = await db.projectMemories.create({ projectId: proj.id, kind: "decision", title: "高", content: "c2", importance: 90 });
    const list = await db.projectMemories.listByProject(proj.id);
    expect(list).toHaveLength(2);
    expect(list[0]!.title).toBe("高"); // importance DESC

    const got = await db.projectMemories.getById(hi.id);
    expect(got!.kind).toBe("decision");

    const updated = await db.projectMemories.update(hi.id, { title: "高-改", importance: 95 });
    expect(updated.title).toBe("高-改");
    expect(updated.importance).toBe(95);

    await db.projectMemories.delete(hi.id);
    expect(await db.projectMemories.getById(hi.id)).toBeNull();
  });

  it("searchAcrossProjects 关键词命中 + excludeProjectId 排除", async () => {
    const projA = await db.projects.create({ name: "search-a" });
    const projB = await db.projects.create({ name: "search-b" });
    await db.projectMemories.create({ projectId: projA.id, kind: "context", title: "用 Tauri 打包", content: "桌面端", importance: 50 });
    await db.projectMemories.create({ projectId: projB.id, kind: "context", title: "另一个 Tauri 项目", content: "也用 Tauri", importance: 50 });

    const all = await db.projectMemories.searchAcrossProjects("Tauri");
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(all.some((m) => m.projectName === "search-a")).toBe(true);

    const excl = await db.projectMemories.searchAcrossProjects("Tauri", { excludeProjectId: projA.id });
    expect(excl.every((m) => m.projectId !== projA.id)).toBe(true);

    expect(await db.projectMemories.searchAcrossProjects("")).toEqual([]);
  });

  it("searchAcrossProjects 默认每项目最多 1 条，且支持 minImportance", async () => {
    const projA = await db.projects.create({ name: "rank-a" });
    const projB = await db.projects.create({ name: "rank-b" });
    await db.projectMemories.create({ projectId: projA.id, kind: "decision", title: "高优先 Tauri", content: "A1", importance: 95 });
    await db.projectMemories.create({ projectId: projA.id, kind: "lesson", title: "次优先 Tauri", content: "A2", importance: 80 });
    await db.projectMemories.create({ projectId: projB.id, kind: "context", title: "低优先 Tauri", content: "B1", importance: 40 });
    await db.projectMemories.create({ projectId: projB.id, kind: "context", title: "高优先 Tauri", content: "B2", importance: 88 });

    const filtered = await db.projectMemories.searchAcrossProjects("Tauri", {
      minImportance: 60,
      perProjectLimit: 1,
      limit: 5,
    });

    expect(filtered).toHaveLength(2);
    expect(filtered.filter((m) => m.projectId === projA.id)).toHaveLength(1);
    expect(filtered.filter((m) => m.projectId === projB.id)).toHaveLength(1);
    expect(filtered.every((m) => m.importance >= 60)).toBe(true);
    expect(filtered.some((m) => m.title === "次优先 Tauri")).toBe(false);
    expect(filtered.some((m) => m.title === "低优先 Tauri")).toBe(false);
  });

  it("project memory vectors 回填 + hybrid 检索可用", async () => {
    const current = await db.projects.create({ name: "current-proj" });
    const projA = await db.projects.create({ name: "desktop-a" });
    const projB = await db.projects.create({ name: "desktop-b" });
    await db.projectMemories.create({
      projectId: current.id,
      kind: "context",
      title: "当前项目约束",
      content: "只作排除当前项目用",
      importance: 95,
    });
    const a = await db.projectMemories.create({
      projectId: projA.id,
      kind: "lesson",
      title: "桌面端打包经验",
      content: "Tauri 桌面应用构建要避免运行时 Node 服务",
      importance: 90,
      tags: "tauri,desktop,build",
    });
    await db.projectMemories.create({
      projectId: projB.id,
      kind: "lesson",
      title: "低优先无关项",
      content: "完全不相关",
      importance: 30,
    });

    const synced = await retrieval.backfillProjectMemoryVectors({ limit: 20 });
    expect(synced).toBeGreaterThanOrEqual(2);

    const vector = await db.projectMemoryVectors.get(a.id, "keyword-hash-v2");
    expect(vector).not.toBeNull();
    expect(vector!.projectId).toBe(projA.id);
    expect(vector!.embedding.length).toBeGreaterThan(0);

    const hits = await retrieval.searchAcrossProjectsHybrid("Tauri 桌面应用 打包 避开 Node 服务", {
      excludeProjectId: current.id,
      minImportance: 60,
      limit: 3,
      perProjectLimit: 1,
    });
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]!.projectId).toBe(projA.id);
    expect(hits.every((m) => m.projectId !== current.id)).toBe(true);
    expect(hits[0]!.providerName).toBe("keyword-hash-v2");
  });

  it("retrieveCrossProjectMemoriesForPrompt 返回可直接注入的 preamble", async () => {
    const current = await db.projects.create({ name: "chat-current" });
    const other = await db.projects.create({ name: "legacy-chat" });
    await db.projectMemories.create({
      projectId: other.id,
      kind: "decision",
      title: "桌面打包不要依赖 Prisma",
      content: "本地桌面应用尽量别依赖运行时 Node server",
      importance: 92,
    });
    await retrieval.backfillProjectMemoryVectors({ limit: 10 });

    const result = await retrieval.retrieveCrossProjectMemoriesForPrompt(current.id, "桌面应用打包时如何避开 Node 运行时");
    expect(result.hits.length).toBeGreaterThanOrEqual(1);
    expect(result.preamble).toContain("其他项目");
    expect(result.preamble).toContain("legacy-chat");
  });
});

describe("projectTemplateRoles", () => {
  it("create + listByTemplate 按 order 升序", async () => {
    const tpl = await db.projectTemplates.create({ name: "role-tpl" });
    await db.projectTemplateRoles.create({ templateId: tpl.id, workRole: "coder", modelId: "m1", order: 2 });
    await db.projectTemplateRoles.create({ templateId: tpl.id, workRole: "planner", modelId: "m2", order: 1 });
    const roles = await db.projectTemplateRoles.listByTemplate(tpl.id);
    expect(roles).toHaveLength(2);
    expect(roles[0]!.workRole).toBe("planner"); // order ASC
    expect(roles[1]!.workRole).toBe("coder");
  });
});

describe("CRUD update/delete 分支覆盖", () => {
  it("providers update 多字段 + delete", async () => {
    const p = await db.providers.create({ name: "P", type: "openai" });
    const u = await db.providers.update(p.id, { name: "P2", type: "anthropic", website: "http://x", notes: "n" });
    expect(u.name).toBe("P2");
    expect(u.website).toBe("http://x");
    await db.providers.delete(p.id);
    expect(await db.providers.getById(p.id)).toBeNull();
  });

  it("apiCredentials update + delete", async () => {
    const p = await db.providers.create({ name: "Pc", type: "openai" });
    const c = await db.apiCredentials.create({ providerId: p.id, name: "C", baseUrl: "http://b" });
    const u = await db.apiCredentials.update(c.id, {
      name: "C2",
      baseUrl: "http://b2",
      enabled: false,
      defaultModelId: "m",
      supportsStreaming: false,
      supportsFunctionCall: false,
      supportsVision: true,
    });
    expect(u.name).toBe("C2");
    expect(u.enabled).toBe(false);
    await db.apiCredentials.delete(c.id);
    expect(await db.apiCredentials.getById(c.id)).toBeNull();
  });

  it("models update + delete", async () => {
    const p = await db.providers.create({ name: "Pm", type: "openai" });
    const m = await db.models.create({ providerId: p.id, name: "gpt", workRoles: "main_chat" });
    const u = await db.models.update(m.id, {
      name: "gpt2",
      displayName: "GPT2",
      contextWindow: 8000,
      inputPrice: 1,
      outputPrice: 2,
      capabilityTags: "x",
      capabilityScore: "{}",
      workRoles: "hard_task",
      enabled: false,
    });
    expect(u.name).toBe("gpt2");
    expect(u.enabled).toBe(false);
    await db.models.delete(m.id);
    expect(await db.models.getById(m.id)).toBeNull();
  });

  it("tokenPlans update + delete", async () => {
    const p = await db.providers.create({ name: "Pt", type: "openai" });
    const tp = await db.tokenPlans.create({ providerId: p.id, name: "T", planType: "monthly", quotaUnit: "usd" });
    const u = await db.tokenPlans.update(tp.id, {
      name: "T2",
      totalQuota: 100,
      resetRule: "r",
      warningThresholds: "{}",
      autoTrackEnabled: false,
      manualUpdateRequired: true,
      usedQuota: 30,
      status: "active",
    });
    expect(u.name).toBe("T2");
    await db.tokenPlans.delete(tp.id);
    expect(await db.tokenPlans.getById(tp.id)).toBeNull();
  });

  it("projects update + projectStages update", async () => {
    const proj = await db.projects.create({ name: "PR" });
    const u = await db.projects.update(proj.id, {
      name: "PR2",
      description: "d",
      workspacePath: "/w",
      currentStage: "coder",
      status: "active",
    });
    expect(u.name).toBe("PR2");
    expect(u.status).toBe("active");
    const st = await db.projectStages.create({ projectId: proj.id, workRole: "coder", modelId: "m" });
    const su = await db.projectStages.update(st.id, { status: "completed", inputTokens: 10, outputTokens: 20 });
    expect(su.status).toBe("completed");
    expect(su.inputTokens).toBe(10);
    await db.projects.delete(proj.id);
    expect(await db.projects.getById(proj.id)).toBeNull();
  });

  it("projectTemplates update + delete", async () => {
    const tpl = await db.projectTemplates.create({ name: "TPL" });
    const u = await db.projectTemplates.update(tpl.id, { name: "TPL2", description: "d", icon: "i", isDefault: true });
    expect(u.name).toBe("TPL2");
    await db.projectTemplates.delete(tpl.id);
    expect(await db.projectTemplates.getById(tpl.id)).toBeNull();
  });
});

describe("seedBuiltInTemplates", () => {
  it("幂等播种：第二次不重复插入", async () => {
    await db.seedBuiltInTemplates();
    const after1 = (await db.projectTemplates.list()).length;
    expect(after1).toBeGreaterThan(0);
    await db.seedBuiltInTemplates();
    const after2 = (await db.projectTemplates.list()).length;
    expect(after2).toBe(after1);
  });

  it("旧内置模板只从普通列表隐藏，不按 id 删除资产", async () => {
    const retired = await db.projectTemplates.create({
      name: "全栈 Web 项目模板",
      description: "retired",
      isBuiltIn: true,
    });

    expect((await db.projectTemplates.list()).some((tpl) => tpl.id === retired.id)).toBe(false);
    expect(await db.projectTemplates.getById(retired.id)).toMatchObject({
      id: retired.id,
      name: "全栈 Web 项目模板",
      isBuiltIn: true,
    });
  });
});

describe("getRoleBindingsForTemplate（阶段 D tidy：空字符串占位不进 Map）", () => {
  it("seed 完后默认 8 角色模板：modelId 都是空字符串占位 → Map 为空（编排走 fallback 自动选）", async () => {
    await db.seedBuiltInTemplates();
    // 找「默认 8 角色」内置模板
    const tpl = (await db.projectTemplates.list()).find((t) => t.name === "默认 8 角色");
    expect(tpl).toBeDefined();
    const bindings = await db.projectTemplateRoles.getRoleBindingsForTemplate(tpl!.id);
    expect(bindings.size).toBe(0); // 所有行的 modelId 是 '' → 全部跳过
  });

  it("用户给某角色配了真实 modelId → 该角色进 Map；其它空串占位仍跳过", async () => {
    await db.seedBuiltInTemplates();
    const tpl = (await db.projectTemplates.list()).find((t) => t.name === "默认 8 角色");
    expect(tpl).toBeDefined();

    // 给 frontend 角色绑一个真实 modelId（先用已存在的 models 表里的任意一个；这里用占位字符串测试——resolveOrchestration L2 会再校验 availableModels）
    const rows = await db.projectTemplateRoles.listByTemplate(tpl!.id);
    const frontendRow = rows.find((r) => r.workRole === "frontend");
    expect(frontendRow).toBeDefined();
    await db.projectTemplateRoles.update(frontendRow!.id, { modelId: "model-real-frontend" });

    const bindings = await db.projectTemplateRoles.getRoleBindingsForTemplate(tpl!.id);
    expect(bindings.size).toBe(1); // 只有 frontend 进 Map
    expect(bindings.get("frontend")).toBe("model-real-frontend");
  });
});

describe("skillDefinitions.upsert 冲突分支（review：ON CONFLICT SQL 修复）", () => {
  // 回归：ON CONFLICT DO UPDATE 曾写 `excluded.review_by ?? skill_definitions.reviewed_by`——
  // 列名拼错 + `??` 非 SQLite 语法，任何「upsert 已存在 id」都会在冲突分支抛
  // "no such column: excluded.review_by"。builtin 有 getById 守卫绕过，但
  // registration 重新 upsert / 重复 approve 会踩到。这里用真 SQLite 走冲突路径。
  const baseInput = {
    id: "skill_conflict_probe",
    label: "冲突分支探针",
    purpose: "回归冲突分支专用。",
    triggerPhases: ["execute"],
    triggerKeywords: ["probe"],
    requiredCapabilities: ["edit_files"],
    systemGuidance: ["先读仓库。"],
    acceptanceCriteria: ["通过"],
    source: "user" as const,
    reviewStatus: "pending" as const,
  };

  it("对已存在 id 再次 upsert 不再抛错（冲突分支 SQL 合法）", async () => {
    await db.skillDefinitions.upsert({ ...baseInput, reviewedBy: null, reviewedAt: null });
    // 若冲突分支 SQL 非法，这一步会抛 "no such column: excluded.review_by"
    await expect(
      db.skillDefinitions.upsert({ ...baseInput, label: "改过标签", reviewedBy: null, reviewedAt: null }),
    ).resolves.toMatchObject({ id: baseInput.id, label: "改过标签" });
  });

  it("再次 upsert 带 reviewedBy=null → COALESCE 保留原审核人", async () => {
    // 首次带审核人（模拟已 approve 过的行）
    await db.skillDefinitions.upsert({
      ...baseInput,
      reviewStatus: "approved",
      reviewedBy: "alice",
      reviewedAt: "2026-07-14T00:00:00.000Z",
    });
    // 重新 upsert（如 registration 重注册）不带审核人 → 不应把 alice 冲掉
    const row = await db.skillDefinitions.upsert({
      ...baseInput,
      label: "重注册",
      reviewedBy: null,
      reviewedAt: null,
    });
    expect(row.reviewedBy).toBe("alice");
  });

  it("再次 upsert 带新 reviewedBy → 覆盖旧审核人", async () => {
    await db.skillDefinitions.upsert({
      ...baseInput,
      reviewedBy: "alice",
      reviewedAt: "2026-07-14T00:00:00.000Z",
    });
    const row = await db.skillDefinitions.upsert({
      ...baseInput,
      reviewedBy: "bob",
      reviewedAt: "2026-07-14T01:00:00.000Z",
    });
    expect(row.reviewedBy).toBe("bob");
  });
});
