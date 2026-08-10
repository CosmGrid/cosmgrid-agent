import { runMigrations, type DatabaseLike } from "../db-migrations";
import { clearIdleLeaderOnlyOrchestration, repairCliPresetModels } from "./repairs";
import { SCHEMA_MIGRATIONS } from "./schema-migrations";

export async function initSchemaForDb(db: DatabaseLike): Promise<void> {

  await db.execute(`
    CREATE TABLE IF NOT EXISTS providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      website TEXT,
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS api_credentials (
      id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      name TEXT NOT NULL,
      base_url TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      supports_streaming INTEGER NOT NULL DEFAULT 1,
      supports_function_call INTEGER NOT NULL DEFAULT 1,
      supports_vision INTEGER NOT NULL DEFAULT 0,
      default_model_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS token_plans (
      id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      linked_api_credential_id TEXT,
      name TEXT NOT NULL,
      plan_type TEXT NOT NULL,
      quota_unit TEXT NOT NULL,
      total_quota REAL,
      used_quota REAL NOT NULL DEFAULT 0,
      reset_rule TEXT,
      next_reset_at TEXT,
      warning_thresholds TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      auto_track_enabled INTEGER NOT NULL DEFAULT 0,
      manual_update_required INTEGER NOT NULL DEFAULT 0,
      fallback_model_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS models (
      id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      name TEXT NOT NULL,
      display_name TEXT,
      context_window INTEGER,
      input_price REAL,
      output_price REAL,
      capability_tags TEXT,
      capability_score TEXT,
      work_roles TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (provider_id) REFERENCES providers(id) ON DELETE CASCADE
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS project_templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      icon TEXT,
      is_built_in INTEGER NOT NULL DEFAULT 0,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  // 内置模板名称唯一，防止 seedBuiltInTemplates() 并发调用（如 React StrictMode 双触发 effect）插出重复行
  await db.execute(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_project_templates_builtin_name
    ON project_templates(name) WHERE is_built_in = 1
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS project_template_roles (
      id TEXT PRIMARY KEY,
      template_id TEXT NOT NULL,
      work_role TEXT NOT NULL,
      model_id TEXT NOT NULL,
      fallback_model_id TEXT,
      "order" INTEGER NOT NULL DEFAULT 0,
      system_prompt TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (template_id) REFERENCES project_templates(id) ON DELETE CASCADE,
      UNIQUE (template_id, work_role)
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      template_id TEXT,
      current_stage TEXT NOT NULL DEFAULT 'main_chat',
      status TEXT NOT NULL DEFAULT 'pending',
      workspace_path TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS project_stages (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      work_role TEXT NOT NULL,
      model_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cost REAL NOT NULL DEFAULT 0,
      output_summary TEXT,
      error_message TEXT,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      title TEXT NOT NULL,
      default_model_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      model_id TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cost REAL NOT NULL DEFAULT 0,
      attachments TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS checkpoints (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      goal TEXT,
      completed_summary TEXT,
      current_context TEXT,
      decisions TEXT,
      failed_attempts TEXT,
      blockers TEXT,
      next_steps TEXT,
      do_not_repeat TEXT,
      acceptance_criteria TEXT,
      created_by_model_id TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS handoff_packets (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      checkpoint_id TEXT NOT NULL,
      target_role TEXT NOT NULL,
      target_model_id TEXT,
      format TEXT NOT NULL DEFAULT 'markdown',
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (checkpoint_id) REFERENCES checkpoints(id) ON DELETE CASCADE
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS usage_events (
      id TEXT PRIMARY KEY,
      provider_id TEXT,
      api_credential_id TEXT,
      token_plan_id TEXT,
      model_id TEXT,
      project_id TEXT,
      role TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      cache_hit_tokens INTEGER NOT NULL DEFAULT 0,
      cost REAL NOT NULL DEFAULT 0,
      pricing_known INTEGER NOT NULL DEFAULT 1,
      price_version TEXT,
      price_source TEXT,
      price_catalog_id TEXT,
      success INTEGER NOT NULL DEFAULT 1,
      interrupted INTEGER NOT NULL DEFAULT 0,
      outcome TEXT,
      created_at TEXT NOT NULL
    )
  `);

  await runMigrations(db, SCHEMA_MIGRATIONS.slice(0, 3));

  // 索引：① setOutcomeForLatest 按 model_id + outcome IS NULL 取最近一条（隐式反馈热路径）；
  //        ② usageEvents.list 按 created_at 过滤/排序（统计 + SmartRouter 数据源）；
  //        ③ F1 阶段：按 role_kind × model_id 聚合（覆盖 GROUP BY 前缀 + 时间排序）
  await db.execute(
    "CREATE INDEX IF NOT EXISTS idx_usage_events_model_outcome ON usage_events(model_id, created_at DESC) WHERE outcome IS NULL"
  );
  await db.execute(
    "CREATE INDEX IF NOT EXISTS idx_usage_events_created ON usage_events(created_at)"
  );
  await db.execute(
    "CREATE INDEX IF NOT EXISTS idx_usage_events_role_kind_model ON usage_events(role_kind, model_id, created_at DESC)"
  );
  await db.execute(
    "CREATE INDEX IF NOT EXISTS idx_usage_events_price_catalog ON usage_events(price_catalog_id, created_at DESC)"
  );
  // 2026-07-15 review 修复：quota guard 每次发消息都要按 (provider_id, api_credential_id)
  // 聚合额度用量，原来是拉全表到 JS 里 reduce，历史越多越卡（体现为"点发送后卡一下才出字"）。
  // 改成 SQL 侧 GROUP BY 聚合（见 usage-events.ts 的 aggregateByProviderCredential），
  // 这条索引让分组走索引有序扫描而不是临时哈希表。
  await db.execute(
    "CREATE INDEX IF NOT EXISTS idx_usage_events_provider_credential ON usage_events(provider_id, api_credential_id)"
  );

  // v0.6 项目级长期记忆（4.11 记忆分层 + 5.6 RAG）
  // 每条记忆 = 一段结构化笔记（决策 / 经验 / 上下文 / 失败教训），
  // 减少重复解释背景；做 RAG 时按 title/content 检索（不引 Embedding 依赖）
  await db.execute(`
    CREATE TABLE IF NOT EXISTS project_memories (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      importance INTEGER NOT NULL DEFAULT 50,
      tags TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    )
  `);
  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_project_memories_project
    ON project_memories(project_id, importance DESC)
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS project_memory_vectors (
      memory_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      provider_name TEXT NOT NULL,
      dim INTEGER NOT NULL,
      embedding_json TEXT NOT NULL,
      source_hash TEXT NOT NULL,
      source_updated_at TEXT NOT NULL,
      indexed_at TEXT NOT NULL,
      PRIMARY KEY (memory_id, provider_name),
      FOREIGN KEY (memory_id) REFERENCES project_memories(id) ON DELETE CASCADE,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    )
  `);
  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_project_memory_vectors_lookup
    ON project_memory_vectors(provider_name, project_id, indexed_at DESC)
  `);

  // v0.9 阶段7：模型表现滚动统计（SmartRouter 评分数据源）
  // 一行 = 某模型在某难度桶（simple/standard/hard）上的累积表现；每写 UsageEvent 增量更新
  await db.execute(`
    CREATE TABLE IF NOT EXISTS model_performance_stats (
      id TEXT PRIMARY KEY,
      model_id TEXT NOT NULL,
      task_type TEXT NOT NULL,
      success_rate REAL NOT NULL DEFAULT 1,
      avg_input_tokens REAL NOT NULL DEFAULT 0,
      avg_output_tokens REAL NOT NULL DEFAULT 0,
      avg_cost REAL NOT NULL DEFAULT 0,
      avg_latency_ms REAL NOT NULL DEFAULT 0,
      sample_count INTEGER NOT NULL DEFAULT 0,
      window_start TEXT NOT NULL,
      window_end TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (model_id, task_type)
    )
  `);

  // L2 调度冷却状态（持久化）：模型遇到 session limit / 429 / timeout / spawn failed 后进入冷却。
  // 这类事实不能只放内存，否则 App 重启后会立刻重试同一个不可用模型。
  await db.execute(`
    CREATE TABLE IF NOT EXISTS model_cooldowns (
      model_id TEXT PRIMARY KEY,
      failures INTEGER NOT NULL DEFAULT 0,
      cooldown_until TEXT,
      updated_at TEXT NOT NULL
    )
  `);
  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_model_cooldowns_until
    ON model_cooldowns(cooldown_until)
  `);

  // v0.9 阶段7：语义缓存（重复/相似 query 命中已有答案，省 token）
  // query_embedding 存 JSON float[]；检索时纯 JS 余弦扫描（自用阶段量小够用）
  await db.execute(`
    CREATE TABLE IF NOT EXISTS semantic_cache (
      id TEXT PRIMARY KEY,
      query_text TEXT NOT NULL,
      query_embedding TEXT NOT NULL,
      response_text TEXT NOT NULL,
      model_id TEXT NOT NULL,
      task_type TEXT NOT NULL,
      provider_name TEXT NOT NULL DEFAULT 'keyword-hash',
      hit_count INTEGER NOT NULL DEFAULT 0,
      last_hit_at TEXT,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_semantic_cache_expires
    ON semantic_cache(expires_at)
  `);
  // D9（2026-07-15）：复合索引，让 listValid 按 provider/task/model 过滤 + 分页时
  // 走索引而非全表扫描。expires_at 放最后，配合前导等值列（provider_name/task_type/
  // model_id）做范围裁剪；单独的 expires 索引仍保留给"无过滤只按过期时间扫"的场景。
  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_semantic_cache_lookup
    ON semantic_cache(provider_name, task_type, model_id, expires_at)
  `);

  // 价格目录：内置默认价 + 远程同步价 + 用户手动覆盖价。
  // 允许保留多版本，usage_events.price_version 会把历史调用绑定到当时价格版本。
  await db.execute(`
    CREATE TABLE IF NOT EXISTS model_price_catalog (
      id TEXT PRIMARY KEY,
      model_name TEXT NOT NULL,
      provider_type TEXT,
      input_per_1m REAL NOT NULL,
      output_per_1m REAL NOT NULL,
      cache_read_per_1m REAL,
      cache_write_per_1m REAL,
      context_window INTEGER,
      source TEXT NOT NULL,
      source_url TEXT,
      version TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    )
  `);
  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_model_price_catalog_lookup
    ON model_price_catalog(model_name, provider_type, enabled, source, updated_at DESC)
  `);

  // 价格同步状态：只存一条全局状态，用于 UI 展示“上次更新时间 / 失败原因”。
  await db.execute(`
    CREATE TABLE IF NOT EXISTS price_sync_status (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      source_url TEXT,
      last_attempt_at TEXT,
      last_success_at TEXT,
      last_error TEXT,
      catalog_version TEXT
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS savings_events (
      id TEXT PRIMARY KEY,
      usage_event_id TEXT,
      conversation_id TEXT,
      project_id TEXT,
      kind TEXT NOT NULL,
      baseline_model_id TEXT,
      actual_model_id TEXT,
      baseline_cost REAL NOT NULL,
      actual_cost REAL NOT NULL,
      saved_cost REAL NOT NULL,
      currency TEXT NOT NULL DEFAULT 'USD',
      formula_version TEXT NOT NULL,
      explain_json TEXT NOT NULL,
      actual_price_catalog_id TEXT,
      baseline_price_catalog_id TEXT,
      created_at TEXT NOT NULL
    )
  `);
  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_savings_events_created
    ON savings_events(created_at DESC)
  `);
  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_savings_events_usage_kind
    ON savings_events(usage_event_id, kind)
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS cli_sessions (
      id TEXT PRIMARY KEY,
      provider_type TEXT NOT NULL,
      conversation_id TEXT,
      project_id TEXT,
      official_session_id TEXT NOT NULL,
      model_name TEXT,
      program TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      last_event_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  await db.execute(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_cli_sessions_official
    ON cli_sessions(provider_type, official_session_id)
  `);

  // v0.8 阶段5：多角色对弈会话（Solver/Critic/Judge 协作的一次实例）
  // rounds 存 JSON（每轮 role/modelId/content/token），避免另建 DebateRound 表
  await db.execute(`
    CREATE TABLE IF NOT EXISTS debate_sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      topic TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'completed',
      quick_mode INTEGER NOT NULL DEFAULT 0,
      rounds TEXT NOT NULL DEFAULT '[]',
      final_solution TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT
    )
  `);
  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_debate_sessions_created
    ON debate_sessions(created_at DESC)
  `);

  // v0.7 阶段4：工具执行审计（每次工具调用一条，可追溯）
  await db.execute(`
    CREATE TABLE IF NOT EXISTS tool_executions (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      conversation_id TEXT,
      message_id TEXT,
      tool_name TEXT NOT NULL,
      input TEXT NOT NULL,
      output TEXT NOT NULL,
      status TEXT NOT NULL,
      user_confirmed INTEGER NOT NULL DEFAULT 0,
      reversible INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )
  `);
  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_tool_executions_created
    ON tool_executions(created_at DESC)
  `);

  // v0.7 阶段4b：项目级工具安全配置（自定义命令黑名单，叠加在内置白名单之上）
  await db.execute(`
    CREATE TABLE IF NOT EXISTS workspace_configs (
      project_id TEXT PRIMARY KEY,
      blocked_commands TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL
    )
  `);

  // v0.11：MCP 客户端配置（远程 HTTP / 本地 stdio）。工具执行仍走统一 ToolRegistry 和确认审计。
  await db.execute(`
    CREATE TABLE IF NOT EXISTS mcp_servers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      transport TEXT NOT NULL,
      url TEXT,
      command TEXT,
      args_json TEXT NOT NULL DEFAULT '[]',
      env_json TEXT NOT NULL DEFAULT '{}',
      headers_json TEXT NOT NULL DEFAULT '{}',
      secret_credential_id TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_mcp_servers_enabled
    ON mcp_servers(enabled, updated_at DESC)
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS mcp_server_approvals (
      server_id TEXT NOT NULL,
      workspace_path TEXT NOT NULL,
      config_fingerprint TEXT NOT NULL,
      approved_at TEXT NOT NULL,
      PRIMARY KEY (server_id, workspace_path, config_fingerprint)
    )
  `);
  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_mcp_server_approvals_server
    ON mcp_server_approvals(server_id)
  `);

  // v0.10：任务工作流状态。区别于 conversations.orchestration（角色链 UI），这里保存“任务做到哪一步”。
  await db.execute(`
    CREATE TABLE IF NOT EXISTS workflow_runs (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      project_id TEXT,
      status TEXT NOT NULL,
      current_phase TEXT,
      snapshot_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    )
  `);
  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_workflow_runs_conversation_status
    ON workflow_runs(conversation_id, status, updated_at)
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS workflow_events (
      id TEXT PRIMARY KEY,
      workflow_run_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (workflow_run_id) REFERENCES workflow_runs(id) ON DELETE CASCADE,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    )
  `);
  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_workflow_events_run_created
    ON workflow_events(workflow_run_id, created_at)
  `);

  // v0.10：意图识别自我成长。样例用于语义路由，反馈事件用于后续沉淀/降权。
  await db.execute(`
    CREATE TABLE IF NOT EXISTS intent_examples (
      id TEXT PRIMARY KEY,
      action TEXT NOT NULL,
      text TEXT NOT NULL,
      explanation TEXT NOT NULL,
      source TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0.8,
      weight REAL NOT NULL DEFAULT 1,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_intent_examples_action_enabled
    ON intent_examples(action, enabled, updated_at)
  `);
  await db.execute(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_intent_examples_action_text
    ON intent_examples(action, text)
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS intent_feedback_events (
      id TEXT PRIMARY KEY,
      user_text TEXT NOT NULL,
      predicted_action TEXT NOT NULL,
      corrected_action TEXT NOT NULL,
      workflow_state TEXT,
      source TEXT NOT NULL,
      reason TEXT,
      created_at TEXT NOT NULL
    )
  `);
  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_intent_feedback_created
    ON intent_feedback_events(created_at DESC)
  `);

  // v0.9.1：上下文压缩的摘要落库（避免每轮重复摘要同一批早期消息）
  // 会话级（不挂 checkpoints——checkpoints 是项目级，project_id NOT NULL，
  // 会污染项目维度的状态机读数）。conversation_id → conversations(id) ON DELETE CASCADE
  // 写法照抄 messages 表和 workflow_runs 表的同一约定。
  await db.execute(`
    CREATE TABLE IF NOT EXISTS conversation_summaries (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      summary TEXT NOT NULL,
      key_decisions_json TEXT,
      facts_json TEXT,
      open_threads_json TEXT,
      model_id TEXT,
      token_count INTEGER,
      created_at TEXT NOT NULL,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    )
  `);
  await db.execute(`
    CREATE INDEX IF NOT EXISTS idx_conversation_summaries_conversation_created
    ON conversation_summaries(conversation_id, created_at DESC)
  `);

  await runMigrations(db, SCHEMA_MIGRATIONS);
  await repairCliPresetModels(db);
  await clearIdleLeaderOnlyOrchestration(db);

}
