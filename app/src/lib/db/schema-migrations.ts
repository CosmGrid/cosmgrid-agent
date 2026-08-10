import { addColumnIfMissing, type SchemaMigration } from "../db-migrations";

export const SCHEMA_MIGRATIONS: SchemaMigration[] = [
  {
    version: "202607010001-conversation-orchestration-workspace",
    description: "Add orchestration and workspace path to conversations",
    up: async (db) => {
      await addColumnIfMissing(db, "conversations", "orchestration", "TEXT");
      await addColumnIfMissing(db, "conversations", "workspace_path", "TEXT");
    },
  },
  {
    version: "202607010002-message-attachments-chain-kind",
    description: "Add message attachments, chain metadata, and message kind",
    up: async (db) => {
      await addColumnIfMissing(db, "messages", "attachments", "TEXT");
      await addColumnIfMissing(db, "messages", "actor_role", "TEXT");
      await addColumnIfMissing(db, "messages", "chain_step_index", "INTEGER");
      await addColumnIfMissing(db, "messages", "chain_step_total", "INTEGER");
      await addColumnIfMissing(db, "messages", "chain_done", "INTEGER");
      await addColumnIfMissing(db, "messages", "kind", "TEXT");
    },
  },
  {
    version: "202607010003-usage-event-routing-pricing",
    description: "Add usage outcome, role kind, conversation, and pricing metadata",
    up: async (db) => {
      await addColumnIfMissing(db, "usage_events", "outcome", "TEXT");
      await addColumnIfMissing(db, "usage_events", "role_kind", "TEXT");
      await addColumnIfMissing(db, "usage_events", "conversation_id", "TEXT");
      await addColumnIfMissing(db, "usage_events", "pricing_known", "INTEGER NOT NULL DEFAULT 1");
      await addColumnIfMissing(db, "usage_events", "price_version", "TEXT");
      await addColumnIfMissing(db, "usage_events", "price_source", "TEXT");
      await addColumnIfMissing(db, "usage_events", "price_catalog_id", "TEXT");
    },
  },
  {
    version: "202607010004-semantic-cache-provider",
    description: "Add semantic cache provider name",
    up: async (db) => {
      await addColumnIfMissing(db, "semantic_cache", "provider_name", "TEXT NOT NULL DEFAULT 'keyword-hash'");
    },
  },
  {
    version: "202607010005-savings-price-catalog-links",
    description: "Add price catalog references to savings events",
    up: async (db) => {
      await addColumnIfMissing(db, "savings_events", "actual_price_catalog_id", "TEXT");
      await addColumnIfMissing(db, "savings_events", "baseline_price_catalog_id", "TEXT");
    },
  },
  {
    version: "202607040001-tool-execution-message-id",
    description: "Add message_id to tool_executions so UI can attribute a tool call to its exact message instead of guessing by timestamp window",
    up: async (db) => {
      await addColumnIfMissing(db, "tool_executions", "message_id", "TEXT");
    },
  },
  {
    version: "202607040002-conversation-archived-at",
    description: "Add archived_at to conversations — delete is now soft (archive), never a real DELETE, so orphaned child rows and 'undo by reinstalling' confusion can't happen",
    up: async (db) => {
      await addColumnIfMissing(db, "conversations", "archived_at", "TEXT");
    },
  },
  {
    version: "202607040003-message-tool-call-count",
    description:
      "Add tool_call_count to messages so the next turn can be told 'your last reply made 0 real tool calls' instead of letting the model guess (and confabulate) what it actually did",
    up: async (db) => {
      await addColumnIfMissing(db, "messages", "tool_call_count", "INTEGER");
    },
  },
  {
    version: "202607090001-mcp-secret-credential",
    description: "Store only an OS-keychain credential reference for MCP headers and environment secrets",
    up: async (db) => {
      await addColumnIfMissing(db, "mcp_servers", "secret_credential_id", "TEXT");
    },
  },
  {
    version: "202607110001-tool-execution-result-v2",
    description:
      "Add result_json to tool_executions so we can persist the structured ToolResultV2 " +
      "(status/summary/artifacts/nextActions/error) alongside the legacy status/output columns. " +
      "Old rows keep working: result_json is NULL, read path falls back to compatFromLegacy.",
    up: async (db) => {
      await addColumnIfMissing(db, "tool_executions", "result_json", "TEXT");
    },
  },
  {
    version: "202607110002-tool-execution-error-code",
    description:
      "Add error_code to tool_executions so UI/queries can filter by stable error taxonomy " +
      "(TOOL_DENIED/TOOL_TIMEOUT/TOOL_DOOM_LOOP/etc) without parsing result_json. " +
      "Indexed for the eval harness dashboard (阶段4 will read this).",
    up: async (db) => {
      await addColumnIfMissing(db, "tool_executions", "error_code", "TEXT");
      await addColumnIfMissing(db, "tool_executions", "warning_count", "INTEGER NOT NULL DEFAULT 0");
    },
  },
  {
    version: "202607110003-tool-execution-msg-error-index",
    description:
      "Add idx_tool_executions_message and idx_tool_executions_error_code indexes. " +
      "阶段1 引入 listByMessage(messageId) 在 stream-finalization 每次 finalize 都查一次， " +
      "没索引就全表扫；阶段2 新增 error_code 列也被阶段4 eval dashboard 用作过滤字段， " +
      "同样需要索引。",
    up: async (db) => {
      await db.execute(
        "CREATE INDEX IF NOT EXISTS idx_tool_executions_message ON tool_executions(message_id) WHERE message_id IS NOT NULL",
      );
      await db.execute(
        "CREATE INDEX IF NOT EXISTS idx_tool_executions_error_code ON tool_executions(error_code) WHERE error_code IS NOT NULL",
      );
    },
  },
  {
    version: "202607120001-evidence-store",
    description:
      "Create workflow_evidence table for storing EvidenceRef entries (阶段3 evidence chain). " +
      "阶段3 UI 只读 WorkflowSnapshot.outputs.verification（已通过 saveSnapshot 序列化），" +
      "workflow_evidence 表是 schema 预留，给未来的证据回放 UI 用；阶段3 不强制写入。",
    up: async (db) => {
      await db.execute(`
        CREATE TABLE IF NOT EXISTS workflow_evidence (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          node_id TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('tool_execution','artifact','user_confirmation','structured_criterion')),
          source TEXT NOT NULL,
          summary TEXT NOT NULL,
          occurred_at TEXT NOT NULL,
          tool_execution_id TEXT,
          truncated INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      await db.execute(
        "CREATE INDEX IF NOT EXISTS idx_workflow_evidence_run ON workflow_evidence(run_id, node_id)",
      );
      await db.execute(
        "CREATE INDEX IF NOT EXISTS idx_workflow_evidence_tool ON workflow_evidence(tool_execution_id)",
      );
    },
  },
  {
    version: "202607130001-eval-cases",
    description:
      "Create harness_eval_cases table for the Eval Harness dashboard (阶段4). " +
      "Stores EvalCase definitions (id / task_set_id / fixture path / permission profile / allowed models / acceptance criteria / budget / tags).",
    up: async (db) => {
      await db.execute(`
        CREATE TABLE IF NOT EXISTS harness_eval_cases (
          id TEXT PRIMARY KEY,
          task_set_id TEXT NOT NULL,
          name TEXT NOT NULL,
          fixture_path TEXT NOT NULL,
          permission_profile TEXT NOT NULL DEFAULT 'default',
          allowed_models TEXT NOT NULL DEFAULT '[]',
          acceptance_criteria TEXT NOT NULL DEFAULT '[]',
          budget_usd REAL NOT NULL DEFAULT 1.0,
          timeout_seconds INTEGER NOT NULL DEFAULT 300,
          tags TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      await db.execute(
        "CREATE INDEX IF NOT EXISTS idx_eval_cases_task_set ON harness_eval_cases(task_set_id)",
      );
    },
  },
  {
    version: "202607130002-eval-runs",
    description:
      "Create harness_eval_runs table — one row per eval run (harness_version / model_id / task_set_id / cost / retry / status / failure_kinds_json).",
    up: async (db) => {
      await db.execute(`
        CREATE TABLE IF NOT EXISTS harness_eval_runs (
          id TEXT PRIMARY KEY,
          harness_version TEXT NOT NULL,
          model_id TEXT NOT NULL,
          task_set_id TEXT NOT NULL,
          started_at TEXT NOT NULL,
          finished_at TEXT,
          total_cost_usd REAL NOT NULL DEFAULT 0,
          retry_count INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'running',
          artifact_json TEXT,
          failure_kinds_json TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      await db.execute(
        "CREATE INDEX IF NOT EXISTS idx_eval_runs_task_set ON harness_eval_runs(task_set_id, started_at DESC)",
      );
      await db.execute(
        "CREATE INDEX IF NOT EXISTS idx_eval_runs_harness_version ON harness_eval_runs(harness_version)",
      );
    },
  },
  {
    version: "202607130003-eval-results",
    description:
      "Create harness_eval_results table — one row per (task × attempt) with passed / cost / latency / failure_code / graded_json.",
    up: async (db) => {
      await db.execute(`
        CREATE TABLE IF NOT EXISTS harness_eval_results (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          task_id TEXT NOT NULL,
          attempt_index INTEGER NOT NULL DEFAULT 0,
          passed INTEGER,
          attempt_cost_usd REAL NOT NULL DEFAULT 0,
          attempt_latency_ms INTEGER NOT NULL DEFAULT 0,
          interventions_count INTEGER NOT NULL DEFAULT 0,
          failure_code TEXT,
          graded_json TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (run_id) REFERENCES harness_eval_runs(id) ON DELETE CASCADE
        )
      `);
      await db.execute(
        "CREATE INDEX IF NOT EXISTS idx_eval_results_run ON harness_eval_results(run_id)",
      );
      await db.execute(
        "CREATE INDEX IF NOT EXISTS idx_eval_results_task ON harness_eval_results(task_id, attempt_index)",
      );
    },
  },
  {
    version: "202607130004-task-outcomes",
    description:
      "Create task_outcomes table — production task final outcome (passed / failed / blocked / needs_user / cancelled) per conversation. " +
      "阶段4 11 个指标的 human_interventions / recovery_rate 直接从这张表聚合。",
    up: async (db) => {
      await db.execute(`
        CREATE TABLE IF NOT EXISTS task_outcomes (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL,
          node_id TEXT,
          outcome TEXT NOT NULL,
          final_summary TEXT,
          intervention_kind TEXT,
          evidence_refs_json TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      await db.execute(
        "CREATE INDEX IF NOT EXISTS idx_task_outcomes_conv ON task_outcomes(conversation_id, created_at DESC)",
      );
      await db.execute(
        "CREATE INDEX IF NOT EXISTS idx_task_outcomes_outcome ON task_outcomes(outcome)",
      );
    },
  },
  {
    version: "202607130005-usage-events-latency",
    description:
      "Add latency_ms column to usage_events so latency_per_success metric is computable. " +
      "Reuses existing addColumnIfMissing pattern.",
    up: async (db) => {
      await addColumnIfMissing(db, "usage_events", "latency_ms", "INTEGER NOT NULL DEFAULT 0");
    },
  },
  {
    version: "202607120002-project-memories-playbook-fields",
    description:
      "阶段5 上下文 Playbook：project_memories 表加 9 字段（source_kind / source_ref / confidence / " +
      "status / helpful_count / harmful_count / last_used_at / supersedes_id / evidence_refs_json），" +
      "3 索引（status / last_used / supersedes），并把现有行回填 status='active' source_kind='legacy'。",
    up: async (db) => {
      await addColumnIfMissing(db, "project_memories", "source_kind", "TEXT NOT NULL DEFAULT 'legacy'");
      await addColumnIfMissing(db, "project_memories", "source_ref", "TEXT");
      await addColumnIfMissing(db, "project_memories", "confidence", "REAL NOT NULL DEFAULT 0.5");
      await addColumnIfMissing(db, "project_memories", "status", "TEXT NOT NULL DEFAULT 'active'");
      await addColumnIfMissing(db, "project_memories", "helpful_count", "INTEGER NOT NULL DEFAULT 0");
      await addColumnIfMissing(db, "project_memories", "harmful_count", "INTEGER NOT NULL DEFAULT 0");
      await addColumnIfMissing(db, "project_memories", "last_used_at", "TEXT");
      await addColumnIfMissing(db, "project_memories", "supersedes_id", "TEXT");
      await addColumnIfMissing(db, "project_memories", "evidence_refs_json", "TEXT");
      await db.execute("CREATE INDEX IF NOT EXISTS idx_project_memories_status ON project_memories(project_id, status)");
      await db.execute("CREATE INDEX IF NOT EXISTS idx_project_memories_last_used ON project_memories(last_used_at) WHERE last_used_at IS NOT NULL");
      await db.execute("CREATE INDEX IF NOT EXISTS idx_project_memories_supersedes ON project_memories(supersedes_id) WHERE supersedes_id IS NOT NULL");
      // 数据回填：现有行 status='active' source_kind='legacy'，避免老条目全消失在 active 过滤下
      await db.execute("UPDATE project_memories SET status = 'active' WHERE status IS NULL OR status = ''");
      await db.execute("UPDATE project_memories SET source_kind = 'legacy' WHERE source_kind IS NULL OR source_kind = ''");
    },
  },
  {
    version: "202607120003-memory-playbook-events",
    description:
      "阶段5 上下文 Playbook：新建 memory_playbook_events 事件流表（event sourcing 模式）。" +
      "记录 checkpoint_failed / summary_dropped / outcome_failed / outcome_needs_user 等轨迹事件，" +
      "Reflector 周期消费转化为 PlaybookItem candidate。",
    up: async (db) => {
      await db.execute(`
        CREATE TABLE IF NOT EXISTS memory_playbook_events (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          conversation_id TEXT,
          message_id TEXT,
          kind TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          occurred_at TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      await db.execute(
        "CREATE INDEX IF NOT EXISTS idx_playbook_events_project ON memory_playbook_events(project_id, occurred_at DESC)",
      );
      await db.execute(
        "CREATE INDEX IF NOT EXISTS idx_playbook_events_conversation ON memory_playbook_events(conversation_id, occurred_at DESC) WHERE conversation_id IS NOT NULL",
      );
    },
  },
  {
    version: "202607160001-model-harness-profiles",
    description:
      "阶段6 模型专属 Harness Profile：新建 model_harness_profiles 表（**不 FK 到 models** —— 模型删除后保留历史 profile）。" +
      "字段：id / model_id(nullable) / model_name / provider_id / provider_type / version_range / " +
      "harness_version_min / harness_version_max / enabled / created_at / updated_at。",
    up: async (db) => {
      await db.execute(`
        CREATE TABLE IF NOT EXISTS model_harness_profiles (
          id TEXT PRIMARY KEY,
          model_id TEXT,
          model_name TEXT NOT NULL,
          provider_id TEXT,
          provider_type TEXT,
          version_range TEXT,
          harness_version_min TEXT,
          harness_version_max TEXT,
          enabled INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      await db.execute(
        "CREATE INDEX IF NOT EXISTS idx_model_profile_model ON model_harness_profiles(model_name, enabled)",
      );
      await db.execute(
        "CREATE INDEX IF NOT EXISTS idx_model_profile_enabled ON model_harness_profiles(enabled) WHERE enabled = 1",
      );
    },
  },
  {
    version: "202607160002-model-harness-profile-events",
    description:
      "阶段6：model_harness_profile_events 表（一个 profile 可关联多条 event，每条 event 对应一个 FailureKind + AdaptationRule）。" +
      "字段：id / profile_id / model_id(nullable) / model_name / provider_type / failure_kind / " +
      "adaptation_rule_json / source_type / source_* 引用 / failure_id / confidence / applicable_harness_version / " +
      "enabled / suggested_at / approved_at / created_at / updated_at。**默认 enabled=false**，用户必须显式批准。",
    up: async (db) => {
      await db.execute(`
        CREATE TABLE IF NOT EXISTS model_harness_profile_events (
          id TEXT PRIMARY KEY,
          profile_id TEXT NOT NULL,
          model_id TEXT,
          model_name TEXT NOT NULL,
          provider_type TEXT,
          failure_kind TEXT NOT NULL,
          adaptation_rule_json TEXT NOT NULL,
          source_type TEXT NOT NULL DEFAULT 'manual',
          source_eval_run_id TEXT,
          source_eval_result_id TEXT,
          source_usage_event_id TEXT,
          source_task_outcome_id TEXT,
          source_tool_execution_id TEXT,
          failure_id TEXT,
          confidence REAL NOT NULL DEFAULT 0.5,
          applicable_harness_version TEXT,
          enabled INTEGER NOT NULL DEFAULT 0,
          suggested_at TEXT NOT NULL DEFAULT (datetime('now')),
          approved_at TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      await db.execute(
        "CREATE INDEX IF NOT EXISTS idx_profile_events_profile ON model_harness_profile_events(profile_id, failure_kind)",
      );
      await db.execute(
        "CREATE INDEX IF NOT EXISTS idx_profile_events_failure_kind ON model_harness_profile_events(failure_kind, enabled)",
      );
      await db.execute(
        "CREATE INDEX IF NOT EXISTS idx_profile_events_enabled ON model_harness_profile_events(enabled) WHERE enabled = 1",
      );
    },
  },
  {
    version: "202607160003-model-perf-stats-4-indicators",
    description:
      "阶段6：把 model_performance_stats 的混合 success_rate 拆为 4 类独立指标（transport_success_rate / " +
      "task_success_rate / verifier_pass_rate / cost_per_success）+ failure_count_by_kind_json 失败直方图。" +
      "老 success_rate 保留但 deprecated（不写），DAO 读时 fallback 到 transport_success_rate。",
    up: async (db) => {
      await addColumnIfMissing(db, "model_performance_stats", "transport_success_rate", "REAL NOT NULL DEFAULT 0");
      await addColumnIfMissing(db, "model_performance_stats", "task_success_rate", "REAL NOT NULL DEFAULT 0");
      await addColumnIfMissing(db, "model_performance_stats", "verifier_pass_rate", "REAL NOT NULL DEFAULT 0");
      await addColumnIfMissing(db, "model_performance_stats", "cost_per_success", "REAL NOT NULL DEFAULT 0");
      await addColumnIfMissing(db, "model_performance_stats", "failure_count_by_kind_json", "TEXT NOT NULL DEFAULT '{}'");
      // 数据回填：老 success_rate 复用为 3 类独立指标默认起步值
      await db.execute(
        "UPDATE model_performance_stats SET transport_success_rate = success_rate WHERE transport_success_rate = 0 AND success_rate > 0",
      );
      await db.execute(
        "UPDATE model_performance_stats SET task_success_rate = success_rate WHERE task_success_rate = 0 AND success_rate > 0",
      );
      await db.execute(
        "UPDATE model_performance_stats SET verifier_pass_rate = success_rate WHERE verifier_pass_rate = 0 AND success_rate > 0",
      );
    },
  },
  {
    version: "202607170001-agent-jobs",
    description:
      "阶段7 Agent Job：agent_jobs / agent_job_events / agent_job_artifacts。用于可观察、可取消、可恢复的后台子任务。",
    up: async (db) => {
      await db.execute(`
        CREATE TABLE IF NOT EXISTS agent_jobs (
          id TEXT PRIMARY KEY,
          parent_job_id TEXT,
          workflow_run_id TEXT,
          role TEXT NOT NULL,
          model_id TEXT,
          status TEXT NOT NULL DEFAULT 'queued',
          objective TEXT NOT NULL,
          input_context_refs_json TEXT NOT NULL DEFAULT '[]',
          output_artifact_refs_json TEXT NOT NULL DEFAULT '[]',
          started_at TEXT,
          completed_at TEXT,
          failure_code TEXT,
          retry_count INTEGER NOT NULL DEFAULT 0,
          cancellation_reason TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      await db.execute("CREATE INDEX IF NOT EXISTS idx_agent_jobs_workflow ON agent_jobs(workflow_run_id, created_at)");
      await db.execute("CREATE INDEX IF NOT EXISTS idx_agent_jobs_parent ON agent_jobs(parent_job_id)");
      await db.execute("CREATE INDEX IF NOT EXISTS idx_agent_jobs_status ON agent_jobs(status)");
      await db.execute(`
        CREATE TABLE IF NOT EXISTS agent_job_events (
          id TEXT PRIMARY KEY,
          job_id TEXT NOT NULL,
          event_type TEXT NOT NULL,
          payload_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      await db.execute("CREATE INDEX IF NOT EXISTS idx_agent_job_events_job ON agent_job_events(job_id, created_at)");
      await db.execute(`
        CREATE TABLE IF NOT EXISTS agent_job_artifacts (
          id TEXT PRIMARY KEY,
          job_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          uri TEXT NOT NULL,
          summary TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      await db.execute("CREATE INDEX IF NOT EXISTS idx_agent_job_artifacts_job ON agent_job_artifacts(job_id, created_at)");
    },
  },
  {
    version: "202607180001-harness-candidates",
    description:
      "阶段8 受控 Harness 候选优化：harness_versions / harness_candidates / harness_candidate_edits / harness_candidate_eval_results。",
    up: async (db) => {
      await db.execute(`
        CREATE TABLE IF NOT EXISTS harness_versions (
          id TEXT PRIMARY KEY,
          version TEXT NOT NULL,
          parent_version_id TEXT,
          active INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      await db.execute("CREATE INDEX IF NOT EXISTS idx_harness_versions_active ON harness_versions(active) WHERE active = 1");
      await db.execute(`
        CREATE TABLE IF NOT EXISTS harness_candidates (
          id TEXT PRIMARY KEY,
          parent_version_id TEXT NOT NULL,
          target_failure_kind TEXT NOT NULL,
          expected_improvement TEXT NOT NULL,
          risk_summary TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'proposed',
          held_in_result_json TEXT,
          held_out_result_json TEXT,
          cost_delta_json TEXT,
          decision_reason TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      await db.execute("CREATE INDEX IF NOT EXISTS idx_harness_candidates_parent ON harness_candidates(parent_version_id, status)");
      await db.execute(`
        CREATE TABLE IF NOT EXISTS harness_candidate_edits (
          id TEXT PRIMARY KEY,
          candidate_id TEXT NOT NULL,
          surface TEXT NOT NULL,
          diff TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      await db.execute("CREATE INDEX IF NOT EXISTS idx_harness_candidate_edits_candidate ON harness_candidate_edits(candidate_id)");
      await db.execute(`
        CREATE TABLE IF NOT EXISTS harness_candidate_eval_results (
          id TEXT PRIMARY KEY,
          candidate_id TEXT NOT NULL,
          eval_run_id TEXT,
          split TEXT NOT NULL,
          passed INTEGER NOT NULL DEFAULT 0,
          metrics_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      await db.execute("CREATE INDEX IF NOT EXISTS idx_harness_candidate_eval_candidate ON harness_candidate_eval_results(candidate_id, split)");
    },
  },
  {
    version: "202607180002-harness-version-single-active",
    description:
      "Ensure only one harness_versions row can be active at a time. " +
      "Candidate validation may create new versions, but activation must be unambiguous and rollback-safe.",
    up: async (db) => {
      await db.execute(`
        UPDATE harness_versions
        SET active = 0
        WHERE active = 1
          AND id NOT IN (
            SELECT id FROM harness_versions
            WHERE active = 1
            ORDER BY created_at DESC
            LIMIT 1
          )
      `);
      await db.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_harness_versions_one_active ON harness_versions(active) WHERE active = 1",
      );
    },
  },
  // ============ 引擎化改造方案阶段 0（2026-07-12）：策略引擎抽象层 ============
  // 提供通用 "builtin seed + 数据覆盖 + 缺数据时降级" 的引擎化范式，先抽 CRUD+scope，
  // 不做统一 value 容器（value schema 由每条 PolicyDefinition.parse 负责）。
  // 老用户 DB 靠 CREATE TABLE IF NOT EXISTS 自动补建，无需手写回填 SQL。
  {
    version: "202607120010-policy-overrides",
    description:
      "Engine-ification phase 0: policy_overrides table for runtime policy overrides. " +
      "Three scope levels (project / global / distribution) — see lib/policy/types.ts PolicyScope. " +
      "scope_id uses sentinel string '__global__' to avoid PK NULL edge cases (DAO uses '=' comparison). " +
      "Storing raw value_json; per-policy schema validation lives in each PolicyDefinition.parse().",
    up: async (db) => {
      await db.execute(`
        CREATE TABLE IF NOT EXISTS policy_overrides (
          policy_key TEXT NOT NULL,
          scope_level TEXT NOT NULL CHECK (scope_level IN ('project','global','distribution')),
          scope_id TEXT NOT NULL,
          value_json TEXT NOT NULL,
          builtin_version TEXT NOT NULL,
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_by TEXT,
          PRIMARY KEY (policy_key, scope_level, scope_id)
        )
      `);
      await db.execute(
        "CREATE INDEX IF NOT EXISTS idx_policy_overrides_key ON policy_overrides(policy_key)",
      );
    },
  },
  {
    version: "202607120011-policy-override-history",
    description:
      "Engine-ification phase 0: audit log for policy_overrides mutations. " +
      "Records who/when/what for set / clear / bulk_clear. Read path: policyStore.history(policyKey). " +
      "scope_id uses same sentinel as policy_overrides for join consistency.",
    up: async (db) => {
      await db.execute(`
        CREATE TABLE IF NOT EXISTS policy_override_history (
          id TEXT PRIMARY KEY,
          policy_key TEXT NOT NULL,
          scope_level TEXT NOT NULL,
          scope_id TEXT NOT NULL,
          action TEXT NOT NULL CHECK (action IN ('set','clear','bulk_clear')),
          old_value_json TEXT,
          new_value_json TEXT,
          actor TEXT,
          at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      await db.execute(
        "CREATE INDEX IF NOT EXISTS idx_policy_override_history_key_at ON policy_override_history(policy_key, at DESC)",
      );
    },
  },
  // ============ 引擎化改造方案阶段 1b（2026-07-12）：Skill 引擎化 ============
  // 开放 Skill 注册 + 审核流程。Skill 的作用是往 system prompt 注入 systemGuidance；
  // 没有审核机制就 = 开放 prompt 注入口子（D2）。本表的 review_status + source 是
  // §4.3 默认组合（审核层 + 来源标注）的落地。
  {
    version: "202607120020-skill-definitions",
    description:
      "Engine-ification phase 1b: skill_definitions table for runtime registered skills. " +
      "Closed-union SkillId 类型放松为 string 后，DB 替代'修改源码+重编译'成为装新 skill 的路径。" +
      "source ∈ {builtin,user,ops}：builtin rows 由 SKILL_BUILTIN_SEED 自动 seed，user/ops 受审核。" +
      "review_status：pending→approved/rejected，selector 默认只装 approved。",
    up: async (db) => {
      await db.execute(`
        CREATE TABLE IF NOT EXISTS skill_definitions (
          id TEXT PRIMARY KEY,
          builtin_version TEXT,
          label TEXT NOT NULL,
          purpose TEXT NOT NULL,
          trigger_phases TEXT NOT NULL DEFAULT '[]',
          trigger_keywords TEXT NOT NULL DEFAULT '[]',
          required_capabilities TEXT NOT NULL DEFAULT '[]',
          system_guidance TEXT NOT NULL DEFAULT '[]',
          acceptance_criteria TEXT NOT NULL DEFAULT '[]',
          source TEXT NOT NULL CHECK (source IN ('builtin','user','ops')),
          review_status TEXT NOT NULL CHECK (review_status IN ('approved','pending','rejected')),
          reviewed_by TEXT,
          reviewed_at TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      await db.execute("CREATE INDEX IF NOT EXISTS idx_skill_definitions_source ON skill_definitions(source, review_status)");
      await db.execute("CREATE INDEX IF NOT EXISTS idx_skill_definitions_status ON skill_definitions(review_status)");
    },
  },
  {
    version: "202607120021-skill-audit-log",
    description:
      "Engine-ification phase 1b: skill_audit_log table. Every register/approve/reject/update/retire " +
      "writes one row for forensic reconstruction ('who registered this content-bearing skill').",
    up: async (db) => {
      await db.execute(`
        CREATE TABLE IF NOT EXISTS skill_audit_log (
          id TEXT PRIMARY KEY,
          skill_id TEXT NOT NULL,
          action TEXT NOT NULL CHECK (action IN ('register','approve','reject','update','retire')),
          actor TEXT,
          notes TEXT,
          diff_json TEXT,
          at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      await db.execute(
        "CREATE INDEX IF NOT EXISTS idx_skill_audit_log_skill_at ON skill_audit_log(skill_id, at DESC)",
      );
    },
  },
  {
    version: "202607160004-workflow-run-snapshot-version",
    description:
      "2026-07-16 review 修复：workflow_runs 之前用不带版本号的 UPDATE ... WHERE id=$runId，" +
      "谁调用得晚谁的写入生效——enqueueSnapshotWrite 只保证按调用顺序执行，不保证数据新鲜度。" +
      "典型场景：finalizeStreamedChatTurn 的后台工作流验收（stream-finalization.ts 的 " +
      "runWorkflowVerificationInBackground）是 fire-and-forget，可能跑很久；这段时间内用户" +
      "发了下一条消息、prepareTurnWorkflow 更快推进了同一个 run，慢的那次验收算完后用它" +
      "开始时读到的旧快照写回去，会把用户已经推进的新状态静默覆盖回旧状态。" +
      "snapshot_version 是乐观锁计数器：每次成功 UPDATE 都 +1；" +
      "runWorkflowVerificationInBackground 在开始跑之前先记下这个 run 当时的 " +
      "snapshot_version，真正写回时带上这个值做 CAS（WHERE snapshot_version = 期望值），" +
      "如果这段时间内已经有更新的写入把版本号推高了，这次陈旧的写入就不会生效——不是重试，" +
      "是直接放弃这次陈旧写入（调用方数据本来就是基于旧状态算出来的，重试意义不大）。" +
      "不传 expectedVersion 的调用方（其余几处正常前台推进）行为不变，仍是无条件写入，" +
      "只是顺带把版本号往前推，给未来可能补充 CAS 检查的调用方留好底子。",
    up: async (db) => {
      await addColumnIfMissing(db, "workflow_runs", "snapshot_version", "INTEGER NOT NULL DEFAULT 0");
    },
  },
];
