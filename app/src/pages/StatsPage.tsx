// StatsPage - v0.9 阶段7：用量明细（成本趋势 / 按模型 / 缓存 / 模型表现）
// 阶段 F2：在 byModel 卡片内加 drill-down 展开"按角色 × 模型"拆分（采纳 frontend-ui-expert review）
//  - byModel 是主页（不动），点 modelId 行 → 展开该 model 的角色拆分
//  - 角色卡片用 ROLE_COLOR_MAP 配色（orchestrator.ts 单一来源；本文件 0 处复用——ChainNodeGraph 后续迭代时考虑统一）
//  - 角色排序：totalCost DESC（贵的在前；review M2）
//  - 零额外 SQL：复用 useEffect 已拿到的 rows，调 aggregateUsageByActorRoleFromRows（review H1）
//  - 测试覆盖：阶段 I 补 aggregateUsageByActorRoleFromRows 单测 8 个（铁律 1 修）；StatsPage 组件测试项目无 jsdom 跳过
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  BarChart3, Coins, Sparkles, Activity, Cpu, Wrench, FileEdit, Terminal, Eye,
  ChevronRight, ChevronDown, Timer, CheckCircle2, DollarSign, Layers3,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import {
  usageEvents, semanticCache, modelPerformanceStats, savingsEvents, toolExecutions,
  models as dbModels,
  type Model, type ModelPerformanceStatRow, type SavingsEventRow, type SavingsEventSummary,
  type ToolExecutionRow, type UsageEventRow,
} from "@/lib/db";
import {
  aggregateUsage,
  aggregateUsageByActorRoleFromRows,
  type UsageSummary,
  type ActorRoleUsage,
  type ActorRoleModelUsage,
} from "@/lib/llm/usage-stats";
import { cleanupExpiredCache, clearAllCache } from "@/lib/llm/semantic-cache";
import { cn, formatCost as fmtCost } from "@/lib/utils";
import {
  ROLE_IDS, ROLE_COLOR, STAGE_COLOR, UNKNOWN_COLOR,
  type RoleId,
} from "@/lib/llm/orchestrator";

export function StatsPage() {
  const { t } = useTranslation();
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [cache, setCache] = useState<{ entries: number; totalHits: number }>({ entries: 0, totalHits: 0 });
  const [perf, setPerf] = useState<ModelPerformanceStatRow[]>([]);
  const [modelList, setModelList] = useState<Model[]>([]);
  const [savings, setSavings] = useState<SavingsEventRow[]>([]);
  const [savingsTrace, setSavingsTrace] = useState<SavingsEventSummary | null>(null);
  const [toolExecs, setToolExecs] = useState<ToolExecutionRow[]>([]);
  const [loading, setLoading] = useState(true);
  // 阶段 F2：byModel 行点击展开角色拆分（drill-down）
  const [expandedModelId, setExpandedModelId] = useState<string | null>(null);
  // 阶段 F2：rows 状态保留（用于派生 byActorRole，不另起 SQL）
  const [rows, setRows] = useState<UsageEventRow[]>([]);

  async function loadStats() {
    try {
      void cleanupExpiredCache();
      const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
      const [rowsRes, cacheStats, perfRows, execs, modelRows, savingsRows, savingsSummaryRows] = await Promise.all([
        usageEvents.list(since),
        semanticCache.stats(),
        modelPerformanceStats.list(),
        toolExecutions.list(30),
        dbModels.list(),
        savingsEvents.list(since),
        savingsEvents.summary(since),
      ]);
      setSummary(aggregateUsage(rowsRes));
      setRows(rowsRes);  // ★ 保留 rows 给 F2 byActorRole 派生（零额外 SQL）
      setCache(cacheStats);
      setPerf(perfRows);
      setModelList(modelRows);
      setToolExecs(execs);
      setSavings(savingsRows);
      setSavingsTrace(savingsSummaryRows);
    } catch (err) {
      // 阶段 I 修（铁律 4：静默吞错）：原 `} catch {` 没打日志，失败用户完全无感
      // 加 console.error 让 dev/QA 能看到；用户也至少在 devtools 看到 [StatsPage] 前缀
      console.error("[StatsPage] load failed:", err);
      setSummary(aggregateUsage([]));
      setRows([]);
      setModelList([]);
      setSavings([]);
      setSavingsTrace(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadStats();
  }, []);

  // 清空全部语义缓存：旧脏缓存一键清掉，清完刷新统计
  async function handleClearCache() {
    try {
      await clearAllCache();
    } catch (err) {
      console.error("[StatsPage] clear cache failed:", err);
    }
    await loadStats();
  }

  // 阶段 F2：从同一份 rows 派生 byActorRole（review H1：零额外 SQL）
  // 排序由聚合函数内负责（NULL 最后 + 字母序 + 同 roleKind 内 cost DESC，review F1-9）
  const byActorRole: ActorRoleUsage[] = useMemo(
    () => aggregateUsageByActorRoleFromRows(rows),
    [rows],
  );

  const modelById = useMemo(
    () => new Map(modelList.map((m) => [m.id, m])),
    [modelList],
  );
  const savingsSummary = useMemo(() => {
    const total = savings.reduce((sum, row) => sum + row.savedCost, 0);
    const byKind = {
      cache: savings.filter((row) => row.kind === "cache").reduce((sum, row) => sum + row.savedCost, 0),
      routing: savings.filter((row) => row.kind === "routing").reduce((sum, row) => sum + row.savedCost, 0),
      compression: savings.filter((row) => row.kind === "compression").reduce((sum, row) => sum + row.savedCost, 0),
    };
    return { total, byKind };
  }, [savings]);

  const maxDayCost = Math.max(...(summary?.byDay.map((d) => d.cost) ?? [0]), 0.0001);

  return (
    <div className="app-page">
      <div className="app-section">
        <header className="app-page-header">
          <div className="app-eyebrow">
            <BarChart3 className="w-4 h-4" />
            <span>{t("stats.sectionLabel")}</span>
          </div>
          <h1 className="app-page-title">{t("stats.title")}</h1>
          <p className="app-page-desc">
            {t("stats.desc")}
          </p>
        </header>

        {loading ? (
          <div className="text-sm text-muted-foreground">{t("stats.loading")}</div>
        ) : (
          <div className="space-y-5">
            {/* 概览卡片 */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <StatCard icon={<Coins className="w-4 h-4" />} label={t("stats.today")} value={fmtCost(summary!.todayCost)} />
              <StatCard icon={<Activity className="w-4 h-4" />} label={t("stats.last7d")} value={fmtCost(summary!.last7dCost)} />
              <StatCard icon={<Activity className="w-4 h-4" />} label={t("stats.last30d")} value={fmtCost(summary!.last30dCost)} />
              <StatCard icon={<Sparkles className="w-4 h-4 text-emerald-500" />} label={t("stats.cacheHits")} value={String(cache.totalHits)} />
            </div>

            {/* 缓存条目数 + 一键清空（旧脏缓存 / 不想再命中时手动重置） */}
            <div className="flex items-center justify-between gap-3 px-1 -mt-2">
              <span className="text-xs text-muted-foreground">
                {t("stats.cacheEntries", { count: cache.entries })}
              </span>
              <button
                type="button"
                onClick={handleClearCache}
                disabled={cache.entries === 0}
                className="text-xs font-medium px-3 py-1.5 rounded-full border border-white/15 hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {t("stats.clearCache")}
              </button>
            </div>

            <Card className="panel-card">
              <div className="panel-title-row">
                <Coins className="w-4 h-4 text-emerald-500" />
                <h2 className="panel-title">{t("stats.savingsTitle")}</h2>
              </div>
              <div className="pt-4 space-y-3">
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                  <StatCard icon={<Coins className="w-4 h-4" />} label={t("stats.savingsTotal")} value={fmtCost(savingsSummary.total)} />
                  <StatCard icon={<Sparkles className="w-4 h-4" />} label={t("stats.savingsKinds.cache")} value={fmtCost(savingsSummary.byKind.cache)} />
                  <StatCard icon={<Cpu className="w-4 h-4" />} label={t("stats.savingsKinds.routing")} value={fmtCost(savingsSummary.byKind.routing)} />
                  <StatCard icon={<Layers3 className="w-4 h-4" />} label={t("stats.savingsKinds.compression")} value={fmtCost(savingsSummary.byKind.compression)} />
                </div>
                {savingsTrace && savingsTrace.eventCount > 0 && (
                  <div className="rounded-xl bg-emerald-500/10 border border-emerald-500/20 px-3 py-2 text-[11px] text-emerald-700 dark:text-emerald-300">
                    {t("stats.savingsTraceSummary", {
                      traceable: savingsTrace.traceableEventCount,
                      total: savingsTrace.eventCount,
                      missing: savingsTrace.missingPriceCatalogEventCount,
                    })}
                  </div>
                )}
                {savings.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t("stats.savingsEmpty")}</p>
                ) : (
                  <div className="space-y-2">
                    {savings.slice(0, 12).map((row) => (
                      <SavingsRow key={row.id} row={row} t={t} />
                    ))}
                  </div>
                )}
              </div>
            </Card>

            {/* 7 天成本趋势（零依赖 CSS 柱状图） */}
            <Card className="panel-card">
              <div className="panel-title-row">
                <BarChart3 className="w-4 h-4 text-primary" />
                <h2 className="panel-title">{t("stats.trendTitle")}</h2>
              </div>
              <div className="flex items-end justify-between gap-2 h-36 pt-4">
                {summary!.byDay.map((d) => (
                  <div key={d.date} className="flex-1 flex flex-col items-center gap-2 group">
                    <div className="text-[9px] font-bold text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity">
                      {fmtCost(d.cost)}
                    </div>
                    <div className="w-full flex items-end justify-center" style={{ height: "88px" }}>
                      <div
                        className="w-full max-w-[28px] rounded-t-lg bg-gradient-to-t from-primary/40 to-primary transition-all duration-500"
                        style={{ height: `${Math.max(3, (d.cost / maxDayCost) * 100)}%` }}
                      />
                    </div>
                    <div className="text-[9px] font-bold text-muted-foreground">{d.date.slice(5)}</div>
                  </div>
                ))}
              </div>
            </Card>

            {/* 阶段 F2：按模型成本（drill-down 展开角色拆分）*/}
            <Card className="panel-card">
              <div className="panel-title-row">
                <Cpu className="w-4 h-4 text-primary" />
                <h2 className="panel-title">{t("stats.byModelTitle")}</h2>
                <span className="text-[9px] text-muted-foreground/60">
                  {t("stats.byModelDrilldownHint")}
                </span>
              </div>
              {summary!.byModel.length === 0 ? (
                <p className="text-sm text-muted-foreground pt-6">{t("stats.noData")}</p>
              ) : (
                <div className="pt-4 space-y-2">
                  {summary!.byModel.slice(0, 10).map((m) => {
                    const isExpanded = expandedModelId === m.modelId;
                    return (
                      <div key={m.modelId} className="rounded-xl overflow-hidden">
                        <button
                          type="button"
                          data-testid={`byModel-row-${m.modelId}`}
                          onClick={() => setExpandedModelId(isExpanded ? null : m.modelId)}
                          className="w-full flex items-center justify-between gap-4 p-3 bg-white/5 hover:bg-white/10 transition-colors text-sm text-left"
                        >
                          <span className="font-mono text-xs truncate flex-1">{m.modelId}</span>
                          <span className="text-muted-foreground text-xs">{t("stats.calls", { n: m.calls })}</span>
                          {m.unknownPricingCalls > 0 && (
                            <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-bold text-amber-500">
                              {t("stats.pricingMissingCalls", { n: m.unknownPricingCalls })}
                            </span>
                          )}
                          <span className="font-bold tabular-nums">{fmtCost(m.cost)}</span>
                          {isExpanded
                            ? <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />
                            : <ChevronRight className="w-4 h-4 text-muted-foreground/50 shrink-0" />
                          }
                        </button>
                        {isExpanded && (
                          <ModelRoleBreakdown
                            modelId={m.modelId}
                            allGroups={byActorRole}
                            t={t}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </Card>

            {/* 模型表现（SmartRouter 评分数据） */}
            <Card className="panel-card">
              <div className="panel-title-row">
                <Activity className="w-4 h-4 text-amber-500" />
                <h2 className="panel-title">{t("stats.perfTitle")}</h2>
              </div>
              {perf.length === 0 ? (
                <p className="text-sm text-muted-foreground pt-6">{t("stats.perfEmpty")}</p>
              ) : (
                <div className="pt-4 grid grid-cols-1 xl:grid-cols-2 gap-3">
                  {perf.map((p) => (
                    <PerformanceCard
                      key={`${p.modelId}-${p.taskType}`}
                      stat={p}
                      model={modelById.get(p.modelId)}
                      t={t}
                    />
                  ))}
                </div>
              )}
            </Card>

            {/* AI 工具操作记录（透明化：用户看清 AI 读/改/跑了什么） */}
            <Card className="panel-card">
              <div className="panel-title-row">
                <Wrench className="w-4 h-4 text-primary" />
                <h2 className="panel-title">{t("stats.toolsTitle")}</h2>
              </div>
              {toolExecs.length === 0 ? (
                <p className="text-sm text-muted-foreground pt-6">{t("stats.toolsEmpty")}</p>
              ) : (
                <div className="pt-4 space-y-2">
                  {toolExecs.map((e) => {
                    const Icon = e.toolName === "bash" ? Terminal
                      : e.toolName === "edit" || e.toolName === "write" ? FileEdit : Eye;
                    const statusColor = e.status === "success" ? "text-emerald-500"
                      : e.status === "denied" ? "text-amber-500" : "text-red-500";
                    return (
                      <div key={e.id} className="flex items-center gap-3 p-3 bg-white/5 rounded-xl text-xs">
                        <Icon className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                        <span className="font-mono font-bold">{e.toolName}</span>
                        <span className="text-muted-foreground truncate flex-1">{e.input}</span>
                        <span className={`font-bold ${statusColor}`}>{t(`stats.toolStatus.${e.status}`)}</span>
                        <span className="text-muted-foreground/50 tabular-nums">{e.durationMs}ms</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}

function PerformanceCard({
  stat,
  model,
  t,
}: {
  stat: ModelPerformanceStatRow;
  model: Model | undefined;
  t: (k: string, opts?: Record<string, unknown>) => string;
}) {
  const modelName = model?.displayName || model?.name || t("stats.perfUnknownModel");
  const providerName = model?.provider?.name;
  const successPercent = `${Math.round(stat.successRate * 100)}%`;
  const latency = formatLatency(stat.avgLatencyMs, t);

  return (
    <div className="rounded-2xl bg-white/5 border border-white/10 px-3.5 py-3 space-y-3">
      <div className="min-w-0">
        <div className="font-bold text-[13px] dark:text-white truncate">{modelName}</div>
        <div className="text-[10px] text-muted-foreground mt-1 truncate">
          {providerName
            ? t("stats.perfProviderLine", { provider: providerName, model: model?.name ?? modelName })
            : t("stats.perfMissingModelLine")}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 text-[11px]">
        <MetricPill
          icon={<Layers3 className="w-3.5 h-3.5" />}
          label={t("stats.perfTaskType")}
          value={taskTypeLabel(stat.taskType, t)}
        />
        <MetricPill
          icon={<CheckCircle2 className="w-3.5 h-3.5" />}
          label={t("stats.perfSuccessRate")}
          value={successPercent}
          valueClassName="text-emerald-500"
        />
        <MetricPill
          icon={<DollarSign className="w-3.5 h-3.5" />}
          label={t("stats.perfAvgCost")}
          value={t("stats.perfPerCall", { value: fmtCost(stat.avgCost) })}
        />
        <MetricPill
          icon={<Timer className="w-3.5 h-3.5" />}
          label={t("stats.perfAvgLatency")}
          value={latency}
        />
      </div>

      <div className="text-[10px] text-muted-foreground/70">
        {t("stats.perfSampleHint", { n: stat.sampleCount })}
      </div>
    </div>
  );
}

function SavingsRow({
  row,
  t,
}: {
  row: {
    id: string;
    kind: "cache" | "routing" | "compression";
    savedCost: number;
    baselineCost: number;
    actualCost: number;
    formulaVersion: string;
    explainJson: string;
    actualPriceCatalogId: string | null;
    baselinePriceCatalogId: string | null;
    createdAt: string;
  };
  t: (k: string, opts?: Record<string, unknown>) => string;
}) {
  let explain: Record<string, unknown> = {};
  try {
    explain = JSON.parse(row.explainJson) as Record<string, unknown>;
  } catch {
    explain = {};
  }

  return (
    <div className="rounded-2xl bg-white/5 border border-white/10 px-3.5 py-3 space-y-1.5 text-[13px]">
      <div className="flex items-center justify-between gap-3">
        <div className="font-bold dark:text-white">{t(`stats.savingsKinds.${row.kind}`)}</div>
        <div className="font-bold text-emerald-500 tabular-nums">{fmtCost(row.savedCost)}</div>
      </div>
      <div className="text-[11px] text-muted-foreground">
        {t("stats.savingsExplain", { baseline: fmtCost(row.baselineCost), actual: fmtCost(row.actualCost) })}
      </div>
      <div className="text-[11px] text-muted-foreground/80">
        {formatSavingsExplain(row.kind, explain, t)}
      </div>
      <div className="flex flex-wrap gap-1.5 text-[10px] text-muted-foreground/70">
        <span className="rounded-full bg-black/5 dark:bg-white/5 px-2 py-0.5">
          {t("stats.savingsFormula", { version: row.formulaVersion })}
        </span>
        <span className="rounded-full bg-black/5 dark:bg-white/5 px-2 py-0.5">
          {t("stats.savingsPriceTrace", {
            actual: row.actualPriceCatalogId ?? "—",
            baseline: row.baselinePriceCatalogId ?? "—",
          })}
        </span>
      </div>
      <div className="text-[10px] text-muted-foreground/60">
        {new Date(row.createdAt).toLocaleString()}
      </div>
    </div>
  );
}

function formatSavingsExplain(
  kind: "cache" | "routing" | "compression",
  explain: Record<string, unknown>,
  t: (k: string, opts?: Record<string, unknown>) => string,
): string {
  if (kind === "cache") {
    return t("stats.savingsCacheDetail", {
      tokens: Number(explain.cacheHitTokens ?? 0).toLocaleString(),
      input: explain.inputPricePer1m ?? "—",
      cache: explain.cacheReadPricePer1m ?? "—",
    });
  }
  if (kind === "routing") {
    return t("stats.savingsRoutingDetail", {
      baseline: String(explain.baselineModelId ?? "—"),
      actual: String(explain.actualModelId ?? "—"),
    });
  }
  return t("stats.savingsCompressionDetail", {
    before: Number(explain.beforeTokens ?? 0).toLocaleString(),
    after: Number(explain.afterTokens ?? 0).toLocaleString(),
  });
}

function MetricPill({
  icon,
  label,
  value,
  valueClassName,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  valueClassName?: string;
}) {
  return (
    <div className="rounded-xl bg-black/10 border border-white/5 px-3 py-2 space-y-1">
      <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className={cn("font-bold tabular-nums", valueClassName)}>{value}</div>
    </div>
  );
}

function taskTypeLabel(taskType: string, t: (k: string, opts?: Record<string, unknown>) => string): string {
  if (["simple", "standard", "hard", "main_chat"].includes(taskType)) {
    return t(`stats.perfTaskTypes.${taskType}`);
  }
  return taskType;
}

function formatLatency(ms: number, t: (k: string, opts?: Record<string, unknown>) => string): string {
  if (ms < 1000) return t("stats.perfMilliseconds", { value: Math.round(ms) });
  return t("stats.perfSeconds", { value: (ms / 1000).toFixed(1) });
}

/**
 * 阶段 F2：byModel 行展开的"按角色拆分"组件。
 *  - 从 byActorRole 过滤出该 modelId 关联的 roleKind 组（每组内 models 已 F1 聚合函数排序过）
 *  - 角色卡片用 ROLE_COLOR_MAP 配色（orchestrator.ts 单一来源）
 *  - 默认折叠（M2 落实：避免 8 角色平铺长页面；review H2 drill-down 模式本身就在滚动层折叠）
 */
function ModelRoleBreakdown({
  modelId,
  allGroups,
  t,
}: {
  modelId: string;
  allGroups: ActorRoleUsage[];
  t: (k: string, opts?: Record<string, unknown>) => string;
}) {
  // 过滤该 modelId 关联的角色组（rows[].modelId === modelId）
  const groups = allGroups
    .map((g) => ({
      ...g,
      rows: g.rows.filter((r) => r.modelId === modelId),
    }))
    .filter((g) => g.rows.length > 0);

  // 按 totalCost DESC 排（M2：贵的在前）—— 聚合函数已按 roleKind 内 cost DESC，这里按 group totalCost 再排一次
  groups.sort((a, b) => b.totalCost - a.totalCost);

  if (groups.length === 0) {
    return (
      <div className="px-4 py-3 text-[10px] text-muted-foreground/50 border-t border-white/5">
        {t("stats.actorRoleEmptyHint")}
      </div>
    );
  }

  return (
    <div className="px-3 py-3 space-y-2 border-t border-white/5 bg-black/10" data-testid={`byModel-breakdown-${modelId}`}>
      <div className="text-[9px] text-muted-foreground/60 px-1">
        {t("stats.byModelDrilldownTitle")}
      </div>
      {groups.map((g) => {
        const row = g.rows[0]!; // 该 group 只有这个 modelId 的 1 行（group 按 roleKind 聚合）
        return <RoleCard key={g.roleKind ?? "null"} group={g} row={row} t={t} />;
      })}
    </div>
  );
}

/**
 * 阶段 F2：单张角色卡片（展开在 ModelRoleBreakdown 内部）。
 *  - getRoleLabel 用 RoleId union 强制穷举（review H3：i18n 拼错不静默）
 *  - 配色用 ROLE_COLOR_MAP（review M1：跨模块视觉锚点）
 */
function RoleCard({
  group,
  row,
  t,
}: {
  group: ActorRoleUsage;
  row: ActorRoleModelUsage;
  t: (k: string, opts?: Record<string, unknown>) => string;
}) {
  const label = getRoleLabel(group.roleKind, t);
  const colorClass = getRoleColor(group.roleKind);

  return (
    <div
      data-testid={`role-card-${group.roleKind ?? "null"}`}
      className={`rounded-lg border ${colorClass} p-3 flex items-center justify-between gap-3 text-xs`}
    >
      <div className="flex items-center gap-2 min-w-0">
        <span className="font-bold truncate">{label}</span>
        <span className="text-[10px] text-muted-foreground/70 shrink-0">
          · {t("stats.calls", { n: group.totalCalls })}
        </span>
        {row.unknownPricingCalls > 0 && (
          <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-bold text-amber-500 shrink-0">
            {t("stats.pricingMissingCalls", { n: row.unknownPricingCalls })}
          </span>
        )}
      </div>
      <div className="flex items-center gap-3 shrink-0">
        <span className="text-muted-foreground tabular-nums">
          {t("stats.actorRoleInputTokensCol")}: {row.inputTokens.toLocaleString()}
        </span>
        <span className="text-muted-foreground tabular-nums">
          {t("stats.actorRoleOutputTokensCol")}: {row.outputTokens.toLocaleString()}
        </span>
        <span className="font-bold tabular-nums">{fmtCost(group.totalCost)}</span>
      </div>
    </div>
  );
}

/** 阶段 F2：解析 roleKind → i18n label（review H3 类型安全） */
function getRoleLabel(
  roleKind: string | null,
  t: (k: string, opts?: Record<string, unknown>) => string,
): string {
  if (roleKind === null) return t("stats.actorRoleUnknown");
  if (roleKind === "stage") return t("stats.stage");
  // 8 RoleId 强制穷举
  const knownRoles: readonly string[] = ROLE_IDS;
  if (knownRoles.includes(roleKind)) {
    return t(`chat.orchestrator.roles.${roleKind}`);
  }
  // 未知 roleKind：dev warning + 兜底显示原字符串
  if (import.meta.env.DEV) {
    console.warn(`[StatsPage] Unknown roleKind: "${roleKind}" — falling back to raw string`);
  }
  return roleKind;
}

/** 阶段 F2：解析 roleKind → 配色 class（review M1 单一来源） */
function getRoleColor(roleKind: string | null): string {
  if (roleKind === null) return UNKNOWN_COLOR;
  if (roleKind === "stage") return STAGE_COLOR;
  if ((ROLE_IDS as readonly string[]).includes(roleKind)) {
    return ROLE_COLOR[roleKind as RoleId];
  }
  return UNKNOWN_COLOR;
}

function StatCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <Card className="metric-card">
      <div className="metric-label">
        {icon}
        {label}
      </div>
      <div className="metric-value">{value}</div>
    </Card>
  );
}
