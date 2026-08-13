import { type MouseEvent } from "react";
// 2026-07-18 用户要求隐藏「IDE 视图」板块，lazy / Suspense 暂时用不上（原用于 WorkPanelIde 的
// 懒加载与占位）；以后恢复该板块时，把它们加回上面这行的 react import 即可。
import { Activity, Cpu, X, Zap } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { ResizeHandle } from "@/components/ui/resize-handle";
import { ChainNodeGraph } from "@/components/work-panel/ChainNodeGraph";
import type { ChainNodeView } from "@/components/work-panel/derive-chain-node-graph";
import { WorkflowDiagnostics } from "@/components/work-panel/WorkflowDiagnostics";
import { EvidencePanel } from "@/components/work-panel/EvidencePanel";
import { AgentJobPanel } from "@/components/work-panel/AgentJobPanel";
import { PlaybookPanel } from "@/components/work-panel/PlaybookPanel";
import { EvalPanel } from "@/components/work-panel/EvalPanel";
import { IntentDiagnostics } from "@/components/work-panel/IntentDiagnostics";
import { WorkArtifacts } from "@/components/work-panel/WorkArtifacts";
import { DebateHistory } from "@/components/work-panel/DebateHistory";
import type { ModelListItem } from "@/lib/api";
import { useDeveloperDiagnosticsSetting } from "@/lib/app-settings";
import type { ToolCallView } from "@/lib/work-artifact-views";
import type { WorkArtifact } from "@/lib/work-artifacts";
import type { WorkflowEvent } from "@/lib/db";
import type { WorkflowSnapshot } from "@/lib/workflow/types";
// formatElapsed 原用于 IDE 视图的 activeLabel，隐藏该板块后暂时用不上；恢复时加回下面的 import。
import { type StreamActivityPhase } from "./streaming-status";
import type { ChatMessage } from "./types";

// 2026-07-18 用户要求隐藏「IDE 视图」板块（文件树 + 文件查看器），代码保留未删。
// 恢复时取消下面这行注释，并放开下方渲染处的 JSX 注释。
// const WorkPanelIde = lazy(() => import("@/components/work-panel/WorkPanelIde").then((m) => ({ default: m.WorkPanelIde })));

// 真实事故（2026-07-05）：这里之前不管切换的真实原因是什么，一律显示写死的
// "限额自动切换"（workPanel.switchedNote）——用户所有 provider 都有额度，却每次
// 切换都被告知"限额"，完全是误导。真实原因（SwitchReason）其实一直有数据，只是
// onSwitched 回调把它丢了。现在按真实 kind/category 映射到具体文案。
function switchReasonKey(reason: ChatMessage["switchReason"]): string {
  if (!reason) return "unknown";
  if (reason.kind === "cooldown") return "cooldown";
  if (reason.kind === "recovery") return "recovery";
  if (reason.kind === "quota") return "quota";
  return reason.category;
}

interface ChatWorkPanelProps {
  width: number;
  onResizeMouseDown: (event: MouseEvent) => void;
  onClose: () => void;
  nodes: ChainNodeView[];
  workflowEvents: WorkflowEvent[];
  workflowSnapshot: WorkflowSnapshot | null;
  availableModels: ModelListItem[];
  disabled: boolean;
  onMainModelChange: (modelId: string) => void;
  onNodeModelChange: (nodeId: string, modelId: string) => void;
  conversationId: string | null;
  workspacePath: string | null;
  artifacts: WorkArtifact[];
  toolCalls: ToolCallView[];
  evalRuns?: import("@/lib/db").EvalRunRow[];
  evalResults?: import("@/lib/db").EvalResultRow[];
  running: boolean;
  streamActivityPhase: StreamActivityPhase;
  streamElapsedMs: number;
  activeModelLabel: string;
  messages: ChatMessage[];
  /** 阶段5 Playbook：本轮注入 prompt 的记忆条目（赞踩反馈列表） */
  playbookMemories?: import("@/lib/db/memory").ProjectMemory[];
  /** 阶段5 Playbook：当前项目 id（候选转正/冲突裁决区数据源） */
  playbookProjectId?: string | null;
  /** 阶段5 Playbook：pipeline 后台跑完的计数信号（变化时 PlaybookPanel refetch 候选/裁决列表） */
  playbookRefreshTick?: number;
}

export function ChatWorkPanel({
  width,
  onResizeMouseDown,
  onClose,
  nodes,
  workflowEvents,
  workflowSnapshot,
  availableModels,
  disabled,
  onMainModelChange,
  onNodeModelChange,
  // conversationId / workspacePath 原专供已隐藏的「IDE 视图」，恢复该板块时放开这两行解构
  // conversationId,
  // workspacePath,
  artifacts,
  toolCalls,
  evalRuns = [],
  evalResults = [],
  // running / streamActivityPhase / streamElapsedMs / activeModelLabel 原专供已隐藏的「IDE 视图」activeLabel，恢复时放开这四行解构
  // running,
  // streamActivityPhase,
  // streamElapsedMs,
  // activeModelLabel,
  messages,
  playbookMemories = [],
  playbookProjectId = null,
  playbookRefreshTick = 0,
}: ChatWorkPanelProps) {
  const { t } = useTranslation();
  const [developerDiagnosticsEnabled] = useDeveloperDiagnosticsSetting();

  const turns = messages.filter((m) => m.role === "assistant" && (m.modelLabel || m.usage));

  function renderTurnCard({ m, n }: { m: ChatMessage; n: number }) {
    return (
      <div key={m.id} className="glass rounded-xl px-3 py-2 border border-white/5 space-y-1">
        <div className="flex items-center justify-between">
          <span className="text-[9px] font-black uppercase tracking-widest text-muted-foreground/40">
            {t("chat.workPanel.turnLabel", { n })}
          </span>
          {m.switched ? (
            <span className="px-2 py-0.5 rounded-full text-[8px] font-black uppercase bg-accent/15 text-accent border border-accent/20 flex items-center gap-1">
              <Zap className="w-2.5 h-2.5" /> {t("chat.workPanel.fallback")}
            </span>
          ) : (
            <span className="px-2 py-0.5 rounded-full text-[8px] font-black uppercase bg-primary/10 text-primary border border-primary/20">
              {t("chat.workPanel.primary")}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 text-xs font-bold">
          <Cpu className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
          <span className="truncate">{m.modelLabel ?? "-"}</span>
        </div>
        {m.switched && (
          <div className="text-[10px] text-accent/80">
            {t(`chat.workPanel.switchReason.${switchReasonKey(m.switchReason)}`)}
          </div>
        )}
        {m.usage && (
          <div className="flex gap-3 font-mono text-[10px] text-muted-foreground/60">
            <span>{t("chat.workPanel.inTokens")} {m.usage.inputTokens}</span>
            <span>{t("chat.workPanel.outTokens")} {m.usage.outputTokens}</span>
          </div>
        )}
      </div>
    );
  }

  function renderTokenUsage() {
    if (turns.length === 0) {
      return (
        <div className="text-[11px] text-muted-foreground/40 text-center py-12 uppercase tracking-widest">
          {t("chat.workPanel.empty")}
        </div>
      );
    }
    const totalIn = turns.reduce((s, m) => s + (m.usage?.inputTokens ?? 0), 0);
    const totalOut = turns.reduce((s, m) => s + (m.usage?.outputTokens ?? 0), 0);
    const ordered = turns.map((m, i) => ({ m, n: i + 1 })).reverse();
    const recent = ordered.slice(0, 3);
    const older = ordered.slice(3);
    return (
      <div className="space-y-1.5">
        <div className="px-1 text-[9px] font-black uppercase tracking-[0.2em] text-muted-foreground/50">
          {t("chat.workPanel.tokenUsage")}
        </div>
        <div className="glass rounded-xl px-3 py-2.5 border border-white/5">
          <div className="text-[9px] font-black uppercase tracking-[0.2em] text-muted-foreground/50 mb-1.5">
            {t("chat.workPanel.sessionTotal")}
          </div>
          <div className="flex gap-4 font-mono text-xs">
            <span className="text-blue-400">{t("chat.workPanel.inTokens")} {totalIn.toLocaleString()}</span>
            <span className="text-orange-400">{t("chat.workPanel.outTokens")} {totalOut.toLocaleString()}</span>
          </div>
        </div>
        {recent.map(renderTurnCard)}
        {older.length > 0 && (
          <details className="group">
            <summary className="cursor-pointer list-none px-1 py-1.5 text-[10px] font-bold text-muted-foreground/50 hover:text-foreground">
              {t("chat.workPanel.showMoreTurns", { count: older.length })}
            </summary>
            <div className="space-y-1.5 mt-1.5">
              {older.map(renderTurnCard)}
            </div>
          </details>
        )}
      </div>
    );
  }

  return (
    <>
      <ResizeHandle onMouseDown={onResizeMouseDown} className="hidden xl:block" />
      <aside style={{ width }} className="shrink-0 glass h-full hidden xl:flex flex-col rounded-3xl overflow-hidden">
        <div className="px-5 py-4 flex items-center justify-between border-b border-white/10 shrink-0">
          <div className="flex items-center gap-2">
            <Activity className="w-4 h-4 text-primary" />
            <span className="text-xs font-black uppercase tracking-[0.2em]">{t("chat.workPanel.title")}</span>
          </div>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            onClick={onClose}
            title={t("chat.workPanel.close")}
            className="h-7 w-7 rounded-lg hover:bg-white/10"
          >
            <X className="w-4 h-4" />
          </Button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-4 space-y-2">
          <ChainNodeGraph
            nodes={nodes}
            availableModels={availableModels}
            disabled={disabled}
            onMainModelChange={onMainModelChange}
            onNodeModelChange={onNodeModelChange}
          />
          {/* 证据链面板：对所有用户开放。
              普通用户（developerDiagnosticsEnabled=false）看到折叠精简版——
              只显示 humanSummary 一行结论（通过/失败/证据不足）；
              开发者看到展开的全量声明↔证据↔冲突↔验收决定。
              组件内部已用 devMode prop 做分级，这里只负责不要把它锁进 dev 块。 */}
          <EvidencePanel workflowSnapshot={workflowSnapshot} devMode={developerDiagnosticsEnabled} />
          {/* 后台任务面板：显示当前 workflow 的 Agent Job 状态（运行/完成/失败/取消），
              支持取消和重试。没有 job 时组件自身不渲染，保持面板轻量。 */}
          <AgentJobPanel workflowRunId={workflowSnapshot?.runId ?? null} />
          {/* 阶段5 Playbook：候选转正/冲突裁决 + 本轮注入赞踩（全空不渲染） */}
          <PlaybookPanel
            memories={playbookMemories}
            projectId={playbookProjectId}
            refreshTick={playbookRefreshTick}
          />
          {developerDiagnosticsEnabled && (
            <>
              <WorkflowDiagnostics workflowEvents={workflowEvents} workflowSnapshot={workflowSnapshot} toolCalls={toolCalls} messages={messages} />
              <EvalPanel runs={evalRuns} results={evalResults} devMode={true} />
              <IntentDiagnostics />
            </>
          )}
          {/* 2026-07-18 用户要求隐藏「IDE 视图」板块（文件树 + 文件查看器），代码保留未删。
              恢复方法：去掉本段最外层的 JSX 注释符，让下面的 JSX 重新生效；并在文件顶部
              重新引入 lazy、Suspense、formatElapsed，取消 WorkPanelIde 的 lazy import 注释。
          <Suspense
            fallback={
              <div className="glass rounded-2xl border border-white/5 p-4 text-[11px] font-bold uppercase tracking-widest text-muted-foreground/50">
                {t("common.loading")}
              </div>
            }
          >
            <WorkPanelIde
              resetKey={conversationId ?? "new"}
              workspacePath={workspacePath}
              artifacts={artifacts}
              running={running}
              activeLabel={
                running
                  ? `${streamActivityPhase === "checking" ? t("chat.checking") : t("chat.replying")} · ${formatElapsed(streamElapsedMs)} · ${activeModelLabel}`
                  : t("chat.workPanel.idle")
              }
            />
          </Suspense>
          */}
          {artifacts.length > 0 && (
            <details className="group">
              <summary className="cursor-pointer list-none px-4 py-3 text-[9px] font-black uppercase tracking-[0.2em] text-muted-foreground/50 hover:text-foreground">
                {t("chat.workPanel.artifacts")}
              </summary>
              <div>
                <WorkArtifacts artifacts={artifacts} />
              </div>
            </details>
          )}
          <details className="group">
            <summary className="cursor-pointer list-none px-4 py-3 text-[9px] font-black uppercase tracking-[0.2em] text-muted-foreground/50 hover:text-foreground">
              {t("chat.workPanel.debateHistory")}
            </summary>
            <div>
              <DebateHistory availableModels={availableModels} />
            </div>
          </details>
          {renderTokenUsage()}
        </div>
      </aside>
    </>
  );
}
