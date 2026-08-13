import { Check, ChevronRight, Circle, Pin, SkipForward, X, Zap } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { ModelListItem } from "@/lib/api";
import type { ChainNodeView } from "./derive-chain-node-graph";

interface ChainNodeGraphProps {
  nodes: ChainNodeView[];
  availableModels: ModelListItem[];
  disabled?: boolean;
  onMainModelChange: (modelId: string) => void;
  onNodeModelChange: (nodeId: string, modelId: string) => void;
}

const STATUS_ICON = {
  planned: Circle,
  active: Zap,
  running: Zap,
  done: Check,
  skipped: SkipForward,
  aborted: X,
} as const;

function statusClass(status: ChainNodeView["status"]): string {
  switch (status) {
    case "running":
      return "chain-node-active border-primary/50 bg-primary/12 text-foreground shadow-primary/20";
    case "active":
      return "border-primary/35 bg-primary/8 text-foreground";
    case "done":
      return "border-emerald-400/25 bg-emerald-500/8 text-foreground/85";
    case "skipped":
      return "border-amber-400/25 bg-amber-500/8 text-muted-foreground";
    case "aborted":
      return "border-rose-400/35 bg-rose-500/10 text-foreground";
    default:
      return "border-border bg-foreground/[0.025] text-muted-foreground";
  }
}

function iconClass(status: ChainNodeView["status"]): string {
  switch (status) {
    case "running":
    case "active":
      return "text-primary";
    case "done":
      return "text-emerald-400";
    case "skipped":
      return "text-amber-400";
    case "aborted":
      return "text-rose-400";
    default:
      return "text-muted-foreground/45";
  }
}

export function ChainNodeGraph({ nodes, availableModels, disabled, onMainModelChange, onNodeModelChange }: ChainNodeGraphProps) {
  const { t } = useTranslation();

  if (nodes.length === 0) return null;

  return (
    <section className="glass shrink-0 overflow-hidden rounded-2xl border border-white/5" aria-label={t("chat.workPanel.chainGraph")}>
      <div className="px-4 pt-3 pb-2">
        <div className="text-[9px] font-black uppercase tracking-[0.2em] text-muted-foreground/50">
          {t("chat.workPanel.chainGraph")}
        </div>
      </div>
      <div className="px-4 pb-3 overflow-x-auto custom-scrollbar bg-foreground/[0.025]">
        <div className="flex items-stretch gap-2 min-w-max">
          {nodes.map((node, index) => {
            const Icon = STATUS_ICON[node.status];
            const canChangeModel = availableModels.length > 0 && !node.locked;
            const stepLabel = t(`chat.workPanel.chainSteps.${node.role}`, { defaultValue: node.stepName });
            const handleChange = (modelId: string) => {
              if (node.id === "main-chat") onMainModelChange(modelId);
              else onNodeModelChange(node.id, modelId);
            };
            return (
              <div key={node.id} className="flex items-center gap-2">
                <div
                  className={cn(
                    "relative min-w-[132px] max-w-[172px] rounded-xl border px-3 py-2 shadow-lg transition-all duration-300",
                    statusClass(node.status),
                    // 工作流"实际动作可视化"阶段1（2026-07-18）：非权威展示态——本轮 AI
                    // 真的在这个阶段动过手（工具调用观测命中），加一圈轻量高亮，不改动
                    // status 本身的配色逻辑。
                    node.touched && "ring-2 ring-sky-400/70 ring-offset-1 ring-offset-background",
                  )}
                  data-status={node.status}
                  data-touched={node.touched ? "true" : undefined}
                  aria-current={node.status === "running" || node.status === "active" ? "step" : undefined}
                >
                  <div className="flex items-center gap-1.5 min-w-0">
                    <Icon className={cn("w-3 h-3 shrink-0", iconClass(node.status))} />
                    <div className="truncate text-[11px] font-black tracking-wide">
                      {stepLabel}
                    </div>
                    {node.pinned && <Pin className="ml-auto w-3 h-3 shrink-0 text-amber-300/80" />}
                  </div>
                  {canChangeModel ? (
                    <Select value={node.modelId ?? ""} onValueChange={handleChange} disabled={disabled}>
                      <SelectTrigger
                        aria-label={t("chat.workPanel.changeNodeModel", { step: stepLabel })}
                        className="mt-1 h-6 max-w-full border-0 bg-foreground/[0.06] px-2 text-[10px] font-mono text-muted-foreground shadow-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-primary/40 [&>svg]:w-2.5 [&>svg]:h-2.5"
                      >
                        <SelectValue placeholder={t("chat.orchestrator.receiptNoModel")}>
                          {node.modelId ? node.modelName : t("chat.orchestrator.receiptNoModel")}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent position="popper" side="bottom" align="start" className="max-h-72">
                        {availableModels.map((model) => (
                          <SelectItem key={model.id} value={model.id} className="text-xs">
                            {model.displayName || model.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <div className="mt-1 h-6 flex items-center rounded-md bg-foreground/[0.06] px-2 text-[10px] font-mono text-muted-foreground truncate">
                      {node.locked
                        ? node.modelName !== "dynamic"
                          ? node.modelName
                          : t("chat.workPanel.dynamicModelPool")
                        : node.modelId
                          ? node.modelName
                          : t("chat.orchestrator.receiptNoModel")}
                    </div>
                  )}
                </div>
                {index < nodes.length - 1 && (
                  <ChevronRight className="w-4 h-4 shrink-0 text-muted-foreground/35" aria-hidden="true" />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
