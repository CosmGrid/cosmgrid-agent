// Cosmgrid-Agent 主入口
// 布局：根容器用 h-full/w-full，依赖 index.css 建立的 html→body→#root height:100% 链。
// 不用 dvh/dvw——WKWebView(Tauri 内核)下动态视口单位 resize 后不重算，会导致窗口变大露白。
import { Suspense, lazy, useState, useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { AlertTriangle, KeyRound, MessageSquare, LayoutTemplate, Coins, X, Settings, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { usePanelResize, ResizeHandle } from "@/components/ui/resize-handle";
import {
  initSchema,
  seedBuiltInTemplates,
  tokenPlans as dbTokenPlans,
  apiCredentials as dbCredentials,
  usageEvents,
  type TokenPlan,
} from "@/lib/db";
import { seedBuiltinSkills } from "@/lib/skills/seed";
import { planUsageLevel, type UsageLevel } from "@/lib/llm/plan-thresholds";
import { computeTokenPlanUsageMap } from "@/lib/llm/token-plan-usage";
import { migrateLegacyApiKeys } from "@/lib/keystore";
import { cn } from "@/lib/utils";
import { useTheme } from "@/lib/theme";
import cosmgridLogo from "@/assets/cosmgrid-logo.svg";
import { OnboardingModal } from "@/pages/OnboardingModal";
import { disposeBackgroundSessionsForClose } from "@/lib/app-close";
import { migrateLegacyMcpServerSecrets } from "@/lib/mcp/secret-store";
import { initializeApp } from "@/lib/app-initialization";

const ChatPage = lazy(() => import("@/pages/ChatPage").then((m) => ({ default: m.ChatPage })));
const ProvidersPage = lazy(() => import("@/pages/ProvidersPage").then((m) => ({ default: m.ProvidersPage })));
const TemplatesPage = lazy(() => import("@/pages/TemplatesPage").then((m) => ({ default: m.TemplatesPage })));
const ProjectsPage = lazy(() => import("@/pages/ProjectsPage").then((m) => ({ default: m.ProjectsPage })));
const ProjectDetailPage = lazy(() => import("@/pages/ProjectDetailPage").then((m) => ({ default: m.ProjectDetailPage })));
const SettingsPage = lazy(() => import("@/pages/SettingsPage").then((m) => ({ default: m.SettingsPage })));
const UsageMonitorPage = lazy(() => import("@/pages/UsageMonitorPage").then((m) => ({ default: m.UsageMonitorPage })));

type PageKey = "chat" | "providers" | "templates" | "tokenPlans" | "projects" | "settings";

interface NavItem {
  key: PageKey;
  icon: React.ReactNode;
}

function selectElementContents(el: Element): void {
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(el);
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function selectActiveTextTarget(): boolean {
  const el = document.activeElement;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    el.select();
    return true;
  }
  if (el instanceof HTMLElement && el.isContentEditable) {
    selectElementContents(el);
    return true;
  }
  const transcript = document.querySelector("[data-chat-transcript-region='true']");
  if (transcript) {
    selectElementContents(transcript);
    return true;
  }
  return false;
}

function PageLoading() {
  const { t } = useTranslation();
  return (
    <div className="h-full w-full flex items-center justify-center bg-background/30">
      <div className="flex flex-col items-center gap-3 text-muted-foreground">
        <div className="logo-wrap w-12 h-12 animate-pulse">
          <img src={cosmgridLogo} className="logo-base" alt="CosmGrid" />
        </div>
        <span className="text-xs font-bold uppercase tracking-widest">{t("common.loading")}</span>
      </div>
    </div>
  );
}

function LazyPage({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-full w-full rounded-3xl overflow-hidden">
      <Suspense fallback={<PageLoading />}>{children}</Suspense>
    </div>
  );
}

async function loadPlansWithRecordedUsage(): Promise<TokenPlan[]> {
  const [plans, rows] = await Promise.all([dbTokenPlans.list(), usageEvents.list()]);
  const usageMap = computeTokenPlanUsageMap(plans, rows);
  return plans.map((plan) => {
    const usage = usageMap.get(plan.id);
    return usage?.autoTrackable ? { ...plan, usedQuota: usage.usedQuota } : plan;
  });
}

function App() {
  const { t } = useTranslation();
  const NAV_ITEMS: NavItem[] = [
    { key: "chat", icon: <MessageSquare className="w-4 h-4" /> },
    { key: "providers", icon: <KeyRound className="w-4 h-4" /> },
    { key: "templates", icon: <LayoutTemplate className="w-4 h-4" /> },
    { key: "tokenPlans", icon: <Coins className="w-4 h-4" /> },
  ];
  const [page, setPage] = useState<PageKey>("chat");
  const [openProjectId, setOpenProjectId] = useState<string | null>(null);
  const [dbReady, setDbReady] = useState(false);
  const [dbError, setDbError] = useState<string | null>(null);
  const [plans, setPlans] = useState<TokenPlan[]>([]);
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());
  const [providerCount, setProviderCount] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const sidebar = usePanelResize({ initial: 288, min: 200, max: 460, edge: "right" });

  useTheme();

  useEffect(() => {
    let closing = false;
    const appWindow = getCurrentWindow();
    const unlisten = appWindow.onCloseRequested(async (event) => {
      if (closing) return;
      // 不再先查"有没有后台会话"——清理本身在没有真实会话时是空 Map，几乎瞬间完成，
      // 没必要为了"判断要不要清理"专门维护一个额外的信号源（真实事故：这个信号源自己
      // 出过错，导致误判"永远有会话"，每次关闭都白白变慢）。无条件清理 + 有超时兜底
      // （这里 1.5 秒 + Rust 侧看门狗 5 秒），比自己判断更简单也更不容易出错。
      event.preventDefault();
      closing = true;
      await disposeBackgroundSessionsForClose();
      await appWindow.destroy().catch(() => appWindow.close().catch(() => undefined));
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  // 全选：焦点在输入框/可编辑区域内就选中该元素内容；否则优先选聊天记录区域。
  useEffect(() => {
    const unlisten = listen("menu-select-all", () => {
      selectActiveTextTarget();
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "a" || !event.ctrlKey || event.altKey || event.shiftKey) return;
      if (selectActiveTextTarget()) event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      void unlisten.then((fn) => fn());
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, []);

  useEffect(() => {
    void initializeApp({
      initSchema,
      seedBuiltInTemplates,
      seedBuiltinSkills,
      warn: (err: unknown) => {
        console.warn(
          "[seedBuiltinSkills] 失败；selector 会用 CORE_SKILLS 常量兜底，" +
            "功能可用但 skill 列在 DB 侧未登记。重启重试。err =",
          err,
        );
      },
    }).then((result) => {
      if (result.ok) {
        setDbReady(true);
      } else {
        setDbError(result.error instanceof Error ? result.error.message : String(result.error));
      }
    });
  }, []);

  useEffect(() => {
    if (!dbReady) return;
    void migrateLegacyMcpServerSecrets().catch(() => {});
    void dbCredentials.list().then((c) => {
      setProviderCount(c.length);
      void migrateLegacyApiKeys(c.map((cred) => cred.id)).catch(() => {});
    });
  }, [dbReady]);

  useEffect(() => {
    if (page === "providers") {
      void dbCredentials.list().then((c) => setProviderCount(c.length));
    }
  }, [page]);

  useEffect(() => {
    if (!dbReady) return;
    void loadPlansWithRecordedUsage().then(setPlans);
    void import("@/lib/llm/price-catalog").then((m) => m.syncModelPrices());
    void import("@/lib/memory/retrieval").then((m) => m.backfillProjectMemoryVectors({ limit: 120 })).catch(() => {});
    // 2026-07-04 补：意图样例"长期不用衰减"——启动时跑一次，跟其他后台维护任务同级别
    void import("@/lib/workflow/intent-decay").then((m) => m.decayStaleIntentExamples()).catch(() => {});
    const id = setInterval(() => {
      void loadPlansWithRecordedUsage().then(setPlans);
    }, 60_000);
    return () => clearInterval(id);
  }, [dbReady]);

  useEffect(() => {
    if (page === "tokenPlans") {
      void loadPlansWithRecordedUsage().then((p) => {
        setPlans(p);
        setDismissedIds(new Set());
      });
    }
  }, [page]);

  const alerts = plans
    .map((p) => ({ plan: p, level: planUsageLevel(p) }))
    .filter((x) => x.level !== "ok")
    .filter((x) => !dismissedIds.has(x.plan.id));

  if (dbError) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-background p-6">
        <div className="glass border border-red-500/30 rounded-3xl p-8 max-w-lg w-full space-y-4 text-center shadow-xl">
          <AlertTriangle className="w-10 h-10 text-red-500 mx-auto" />
          <h1 className="text-lg font-bold">{t("common.dbErrorTitle")}</h1>
          <p className="text-sm text-muted-foreground">{t("common.dbErrorDesc")}</p>
          <pre className="text-xs text-left bg-black/20 rounded-xl p-3 overflow-auto max-h-40 whitespace-pre-wrap break-words text-red-400">{dbError}</pre>
          <Button onClick={() => window.location.reload()} className="rounded-xl">
            {t("common.dbErrorRetry")}
          </Button>
        </div>
      </div>
    );
  }

  if (!dbReady) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-4">
          <div className="logo-wrap w-20 h-20 animate-pulse">
            <img src={cosmgridLogo} className="logo-base" alt="CosmGrid" />
          </div>
          <p className="text-sm font-bold tracking-widest text-primary uppercase">{t("common.loading")}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full bg-background text-foreground overflow-hidden p-3">
      <OnboardingModal
        providerCount={providerCount}
        onNavigate={(p) => setPage(p)}
      />

      {/* Sidebar - 可拖拽宽度；收起后保留窄栏，主工作区释放空间 */}
      {sidebarOpen ? (
        <>
          <aside style={{ width: sidebar.width }} className="glass rounded-3xl overflow-hidden hidden xl:flex flex-col p-6 gap-2 shrink-0 relative">
            <button
              type="button"
              onClick={() => setSidebarOpen(false)}
              title={t("app.sidebar.collapse")}
              aria-label={t("app.sidebar.collapse")}
              className="absolute right-4 top-4 h-9 w-9 rounded-xl text-muted-foreground hover:bg-white/10 hover:text-foreground transition-colors flex items-center justify-center"
            >
              <PanelLeftClose className="w-4 h-4" />
            </button>

            <div className="flex flex-col items-center py-10 mb-6 gap-4">
              <div className="logo-wrap w-24 h-24" aria-label="CosmGrid" role="img">
                <img src={cosmgridLogo} className="logo-base" alt="CosmGrid" />
              </div>
              <div className="text-center">
                <h1 className="text-xl font-bold bg-gradient-to-br from-primary to-accent bg-clip-text text-transparent">
                  CosmGrid Agent
                </h1>
                <p className="text-[10px] uppercase tracking-[0.3em] text-muted-foreground font-bold mt-1">{t("app.brandSubtitle")}</p>
              </div>
            </div>

            <nav className="flex-1 min-h-0 flex flex-col gap-1 overflow-y-auto scrollbar-none">
              {NAV_ITEMS.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => {
                    setPage(item.key);
                    if (item.key !== "projects") setOpenProjectId(null);
                  }}
                  className={cn(
                    "flex items-center gap-3 px-4 py-3 rounded-2xl text-sm font-bold transition-all",
                    page === item.key
                      ? "nav-item-active"
                      : "hover:bg-white/10 dark:hover:bg-white/5 text-muted-foreground hover:text-foreground",
                  )}
                >
                  {item.icon}
                  {t(`app.sidebar.${item.key}`)}
                </button>
              ))}
            </nav>

            <div className="mt-auto pt-4 border-t border-white/5">
              <button
                type="button"
                onClick={() => setPage("settings")}
                className={cn(
                  "w-full flex items-center gap-3 px-4 py-3 rounded-2xl text-sm font-bold transition-all",
                  page === "settings"
                    ? "nav-item-active"
                    : "hover:bg-white/10 dark:hover:bg-white/5 text-muted-foreground hover:text-foreground",
                )}
              >
                <Settings className="w-4 h-4" />
                <span>{t("app.sidebar.settings")}</span>
              </button>
            </div>
          </aside>

          <ResizeHandle onMouseDown={sidebar.onMouseDown} className="hidden xl:block" />
        </>
      ) : (
        <aside className="glass rounded-3xl overflow-hidden hidden xl:flex w-16 shrink-0 flex-col items-center p-2 gap-2">
          <button
            type="button"
            onClick={() => setSidebarOpen(true)}
            title={t("app.sidebar.expand")}
            aria-label={t("app.sidebar.expand")}
            className="mt-2 flex h-10 w-10 items-center justify-center rounded-xl text-muted-foreground hover:bg-white/10 hover:text-foreground transition-colors"
          >
            <PanelLeftOpen className="w-4 h-4" />
          </button>
          <div className="logo-wrap my-4 h-9 w-9" aria-label="CosmGrid" role="img">
            <img src={cosmgridLogo} className="logo-base" alt="CosmGrid" />
          </div>
          <nav className="flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto scrollbar-none">
            {NAV_ITEMS.map((item) => (
              <button
                key={item.key}
                type="button"
                title={t(`app.sidebar.${item.key}`)}
                aria-label={t(`app.sidebar.${item.key}`)}
                onClick={() => {
                  setPage(item.key);
                  if (item.key !== "projects") setOpenProjectId(null);
                }}
                className={cn(
                  "flex h-11 w-11 items-center justify-center rounded-2xl transition-all",
                  page === item.key
                    ? "nav-item-active"
                    : "hover:bg-white/10 dark:hover:bg-white/5 text-muted-foreground hover:text-foreground",
                )}
              >
                {item.icon}
              </button>
            ))}
          </nav>
          <div className="mt-auto border-t border-white/5 pt-2">
            <button
              type="button"
              title={t("app.sidebar.settings")}
              aria-label={t("app.sidebar.settings")}
              onClick={() => setPage("settings")}
              className={cn(
                "flex h-11 w-11 items-center justify-center rounded-2xl transition-all",
                page === "settings"
                  ? "nav-item-active"
                  : "hover:bg-white/10 dark:hover:bg-white/5 text-muted-foreground hover:text-foreground",
              )}
            >
              <Settings className="w-4 h-4" />
            </button>
          </div>
        </aside>
      )}

      {/* Main Content Area - Fluid, handle overflow */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden relative">
        {/* Alerts - Floating */}
        {alerts.length > 0 && (
          <div className="absolute top-4 left-4 right-4 z-50">
            <div className="glass bg-accent/10 border-accent/20 rounded-2xl p-1 shadow-2xl">
              {alerts.map(({ plan, level }) => (
                <PlanAlertBar
                  key={plan.id}
                  level={level}
                  planName={plan.name}
                  providerName={plan.provider?.name}
                  ratio={plan.totalQuota ? plan.usedQuota / plan.totalQuota : 0}
                  onJump={() => setPage("tokenPlans")}
                  onDismiss={() => setDismissedIds((prev) => new Set(prev).add(plan.id))}
                />
              ))}
            </div>
          </div>
        )}

        <main className="flex-1 overflow-hidden">
          <div className="h-full w-full" style={{ display: page === "chat" ? "block" : "none" }}>
            <Suspense fallback={<PageLoading />}>
              <ChatPage active={page === "chat"} />
            </Suspense>
          </div>
          {page === "providers" && (
            <LazyPage>
              <ProvidersPage />
            </LazyPage>
          )}
          {page === "templates" && (
            <LazyPage>
              <TemplatesPage />
            </LazyPage>
          )}
          {page === "tokenPlans" && (
            <LazyPage>
              <UsageMonitorPage />
            </LazyPage>
          )}
          {page === "settings" && (
            <LazyPage>
              <SettingsPage onOpenProjectAssets={() => { setOpenProjectId(null); setPage("projects"); }} />
            </LazyPage>
          )}
          {page === "projects" && (
            <LazyPage>
              {openProjectId ? (
                <ProjectDetailPage projectId={openProjectId} onBack={() => setOpenProjectId(null)} />
              ) : (
                <ProjectsPage onOpenProject={(id) => setOpenProjectId(id)} />
              )}
            </LazyPage>
          )}
        </main>
      </div>
    </div>
  );
}

function PlanAlertBar({
  level,
  planName,
  ratio,
  onJump,
  onDismiss,
}: {
  level: UsageLevel;
  planName: string;
  providerName: string | undefined;
  ratio: number;
  onJump: () => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  const isCritical = level === "exhausted" || level === "critical";
  const percentage = (ratio * 100).toFixed(0);

  return (
    <div className={cn("flex items-center justify-between gap-4 px-4 py-2 rounded-xl text-xs", isCritical ? "text-red-500" : "text-amber-500")}>
      <div className="flex items-center gap-2 truncate">
        <AlertTriangle className="w-4 h-4 shrink-0" />
        <span className="truncate font-bold uppercase">{planName} ({percentage}%)</span>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <Button size="sm" variant="ghost" onClick={onJump} className="h-7 px-3 text-[10px] font-bold uppercase">{t("app.alerts.goToHandle")}</Button>
        <Button size="sm" variant="ghost" onClick={onDismiss} className="h-7 w-7 p-0"><X className="w-4 h-4" /></Button>
      </div>
    </div>
  );
}

export default App;
