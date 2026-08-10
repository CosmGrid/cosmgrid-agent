import { memo, useEffect, useRef, useState } from "react";
import { MessageSquare, Send, ShieldAlert, Square, User, Zap } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { projects as dbProjects, messages as dbMessages, projectStages as dbStages, projectMemories as dbMemories, workspaceConfigs as dbWorkspaceConfigs, type ApiCredential, type DbMessage, type Model, type ProjectStage } from "@/lib/db";
import { streamWithFallback, toModelEndpoint } from "@/lib/llm/chat-fallback";
import { classifyLlmError } from "@/lib/llm/error-classifier";
import { buildImageGuardPreamble, buildNoToolsPreamble, buildProjectMemoryPreamble, buildTimePreamble } from "@/lib/llm/prompts/context-preamble";
import type { ToolConfirmRequest } from "@/lib/llm/tools";
import { prepareWorkspaceToolRuntime, type WorkspaceToolRuntime } from "@/lib/llm/workspace-tool-runtime";
import { retrieveCrossProjectMemoriesForPrompt } from "@/lib/memory/retrieval";
import { formatLocalMcpLaunch } from "@/lib/mcp/session-scope";
import cosmgridLogo from "@/assets/cosmgrid-logo.svg";
import { cn } from "@/lib/utils";

const ChatBubble = memo(function ChatBubble({
  role,
  text,
  isStreaming,
}: {
  role: "user" | "assistant";
  text: string;
  isStreaming: boolean;
}) {
  const { t } = useTranslation();
  const isAssistant = role === "assistant";
  return (
    <div className={cn(
      "flex gap-3 px-4 py-3 rounded-2xl group transition-all",
      isAssistant ? "bg-primary/5" : "bg-white/5",
    )}>
      <div className={cn(
        "w-8 h-8 rounded-xl flex items-center justify-center shrink-0 shadow-lg",
        isAssistant ? "bg-white dark:bg-zinc-800 border border-primary/20" : "bg-primary text-primary-foreground rotate-[-5deg]",
      )}>
        {isAssistant ? (
          <img src={cosmgridLogo} className={cn("w-5 h-5", isStreaming && "animate-pulse")} alt={t("projectDetail.altBot")} />
        ) : (
          <User className="w-4 h-4" />
        )}
      </div>
      <div className="flex-1 space-y-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-[9px] font-black uppercase tracking-widest text-muted-foreground/40">
            {isAssistant ? t("projectDetail.chat.assistantLabel") : t("projectDetail.chat.userLabel")}
          </span>
        </div>
        <div className={cn("text-xs leading-relaxed whitespace-pre-wrap break-words", isAssistant ? "text-foreground/90" : "text-foreground font-medium")}>
          {text}
          {isStreaming && isAssistant && (
            <span className="inline-block w-1.5 h-3.5 ml-1 bg-primary/30 animate-pulse rounded-sm align-middle" />
          )}
        </div>
      </div>
    </div>
  );
});

export interface StageChatProps {
  stage: ProjectStage;
  model: Model;
  credential: ApiCredential;
  apiKey: string;
  conversationId: string;
  fallback: { model: Model; credential: ApiCredential; apiKey: string } | null;
}

export function StageChat({ stage, model, credential, apiKey, conversationId, fallback }: StageChatProps) {
  const { t } = useTranslation();
  const [history, setHistory] = useState<DbMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [streamErr, setStreamErr] = useState<string | null>(null);
  const [switchNotice, setSwitchNotice] = useState<string | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<ToolConfirmRequest | null>(null);
  const confirmResolverRef = useRef<((ok: boolean) => void) | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  function requestConfirm(req: ToolConfirmRequest): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      setPendingConfirm(req);
      confirmResolverRef.current = resolve;
    });
  }

  function resolveConfirm(ok: boolean) {
    confirmResolverRef.current?.(ok);
    confirmResolverRef.current = null;
    setPendingConfirm(null);
  }

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [history]);

  async function loadHistory() {
    const list = await dbMessages.listByConversation(conversationId);
    setHistory(list);
  }

  useEffect(() => {
    void loadHistory();
  }, [conversationId]);

  async function handleSend() {
    const text = draft.trim();
    if (!text || streaming) return;
    setDraft("");
    setStreamErr(null);
    setSwitchNotice(null);
    setStreaming(true);

    const userMsg = await dbMessages.create({ conversationId, role: "user", content: text });
    const assistantId = crypto.randomUUID();
    setHistory((prev) => [
      ...prev,
      userMsg,
      { id: assistantId, conversationId, role: "assistant", content: "", modelId: stage.modelId, inputTokens: 0, outputTokens: 0, cost: 0, createdAt: new Date().toISOString() },
    ]);

    const controller = new AbortController();
    abortRef.current = controller;

    let primary;
    try {
      primary = toModelEndpoint(model, credential, apiKey);
    } catch (err) {
      setStreamErr(err instanceof Error ? err.message : t("projectDetail.chat.endpointFailed"));
      setStreaming(false);
      return;
    }

    const chain = fallback ? [primary, toModelEndpoint(fallback.model, fallback.credential, fallback.apiKey)] : [primary];
    let tools: WorkspaceToolRuntime["tools"];
    let workspacePreamble: string | null = null;
    let projectMemoryPreamble: string | null = null;
    let crossProjectPreamble: string | null = null;
    try {
      const proj = await dbProjects.getById(stage.projectId);
      const memories = await dbMemories.listByProject(stage.projectId);
      projectMemoryPreamble = buildProjectMemoryPreamble(proj?.name, memories);
      crossProjectPreamble = (await retrieveCrossProjectMemoriesForPrompt(stage.projectId, text)).preamble;
      if (proj?.workspacePath) {
        const blockedCommands = await dbWorkspaceConfigs.getBlockedCommands(stage.projectId);
        const runtime = await prepareWorkspaceToolRuntime({
          workspacePath: proj.workspacePath,
          includeWrite: true,
          projectId: stage.projectId,
          conversationId,
          confirm: requestConfirm,
          approveMcpLaunch: (server, workspacePath) => requestConfirm({
            toolName: `mcp-server:${server.name}`,
            summary: `允许启动本地 MCP server？\n${formatLocalMcpLaunch(server, workspacePath)}`,
          }),
          blockedCommands,
          includePreamble: true,
          modelName: model.name,
        });
        tools = runtime.tools;
        workspacePreamble = runtime.workspacePreamble;
      }
    } catch {
      // 取工作区失败不影响对话，只是没有工具。
    }

    let full = "";
    try {
      await streamWithFallback(
        chain,
        [
          { role: "system" as const, content: buildTimePreamble() },
          ...(projectMemoryPreamble ? [{ role: "system" as const, content: projectMemoryPreamble }] : []),
          ...(crossProjectPreamble ? [{ role: "system" as const, content: crossProjectPreamble }] : []),
          ...(workspacePreamble ? [{ role: "system" as const, content: workspacePreamble }] : []),
          ...(tools ? [{ role: "system" as const, content: buildImageGuardPreamble() }] : []),
          ...(!tools ? [{ role: "system" as const, content: buildNoToolsPreamble() }] : []),
          ...[...history, userMsg].map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
        ],
        {
          onDelta: (delta) => {
            full += delta;
            setHistory((prev) => prev.map((m) => (m.id === assistantId ? { ...m, content: full } : m)));
          },
          onSwitched: (_from, to) => {
            setSwitchNotice(t("projectDetail.chat.failsafeSwitched", { name: to.displayLabel || to.modelName }));
          },
          onRecovered: (mode) => {
            setSwitchNotice(t(`projectDetail.chat.recovery.${mode}`));
          },
          onUsage: async (usage, usedEndpoint) => {
            const finalAssistant = await dbMessages.create({
              conversationId, role: "assistant", content: full, modelId: usedEndpoint.modelId, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cost: 0,
            });
            await dbStages.update(stage.id, {
              inputTokens: stage.inputTokens + usage.inputTokens,
              outputTokens: stage.outputTokens + usage.outputTokens,
            });
            setHistory((prev) => prev.map((m) => (m.id === assistantId ? finalAssistant : m)));
          },
        },
        { signal: controller.signal, projectId: stage.projectId, actorRole: "stage", ...(tools ? { tools } : {}) },
      );
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setStreamErr(classifyLlmError(err, t).userMessage);
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }

  return (
    <div className="relative flex flex-col h-[500px] glass border-x-0 border-b-0">
      {pendingConfirm && (
        <div className="absolute top-4 right-4 z-50 w-[28rem] max-w-[calc(100%-2rem)]">
          <div className="glass border border-white/15 rounded-[1.75rem] overflow-hidden shadow-2xl shadow-black/35">
            <div className="flex items-center gap-2 px-4 py-3 border-b border-white/10 bg-black/20">
              <ShieldAlert className="w-4 h-4 text-amber-500" />
              <span className="font-bold text-sm">{t("projectDetail.tools.confirmTitle")}</span>
              <span className="ml-auto text-[10px] font-mono px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-500 uppercase">{pendingConfirm.toolName}</span>
            </div>
            <div className="px-4 py-3 space-y-3">
              <div className="text-xs font-bold text-muted-foreground leading-relaxed">{pendingConfirm.summary}</div>
              {pendingConfirm.diff && (
                <pre className="max-h-48 overflow-auto rounded-xl bg-black/30 p-3 text-[11px] leading-relaxed font-mono custom-scrollbar">
                  {pendingConfirm.diff.split("\n").map((line, i) => (
                    <div
                      key={i}
                      className={
                        line.startsWith("+") ? "text-emerald-400"
                          : line.startsWith("-") ? "text-red-400"
                          : "text-muted-foreground/70"
                      }
                    >
                      {line || " "}
                    </div>
                  ))}
                </pre>
              )}
            </div>
            <div className="flex justify-end gap-2 px-4 py-3 border-t border-white/10 bg-black/10">
              <Button variant="outline" size="sm" className="rounded-xl" onClick={() => resolveConfirm(false)}>
                {t("projectDetail.tools.reject")}
              </Button>
              <Button size="sm" className="rounded-xl bg-emerald-600 hover:bg-emerald-700" onClick={() => resolveConfirm(true)}>
                {t("projectDetail.tools.approve")}
              </Button>
            </div>
          </div>
        </div>
      )}
      {switchNotice && (
        <div className="px-4 py-2 bg-amber-500/10 text-[10px] font-bold text-amber-500 flex items-center gap-2 border-b border-amber-500/10">
          <Zap className="w-3 h-3" /> {switchNotice}
        </div>
      )}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3 custom-scrollbar">
        {history.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full opacity-20 gap-4">
            <MessageSquare className="w-12 h-12" />
            <p className="text-[10px] font-black uppercase tracking-[0.4em]">{t("projectDetail.chat.awaiting")}</p>
          </div>
        ) : (
          history.map((m) => (
            <ChatBubble
              key={m.id}
              role={m.role as "user" | "assistant"}
              text={m.content}
              isStreaming={m.role === "assistant" && m === history[history.length - 1] && streaming}
            />
          ))
        )}
        {streamErr && (
          <div className="px-4 py-2 bg-red-500/10 border border-red-500/20 rounded-xl text-[10px] font-bold text-red-500">
            {t("projectDetail.chat.errorPrefix")}: {streamErr}
          </div>
        )}
      </div>
      <div className="p-4 bg-muted/20">
        <div className="flex gap-2 items-center bg-background/50 border border-white/10 rounded-2xl p-1.5 focus-within:border-primary/50 transition-all">
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={t("projectDetail.chat.placeholder")}
            disabled={streaming}
            className="border-none bg-transparent focus-visible:ring-0 text-sm h-10 px-4"
            onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && (e.preventDefault(), void handleSend())}
          />
          {streaming ? (
            <Button size="icon" variant="destructive" onClick={() => abortRef.current?.abort()} className="h-10 w-10 rounded-xl">
              <Square className="w-4 h-4 fill-current" />
            </Button>
          ) : (
            <Button size="icon" onClick={() => void handleSend()} disabled={!draft.trim()} className="h-10 w-10 rounded-xl bg-primary shadow-lg shadow-primary/20">
              <Send className="w-4 h-4" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
