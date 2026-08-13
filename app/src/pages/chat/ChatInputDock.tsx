import type { FormEvent, MutableRefObject, ClipboardEvent } from "react";
import { FolderOpen, Lock, Paperclip, Send, ShieldCheck, Square, X, Zap } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { WorkingStatusBar } from "@/components/chat/WorkingStatusBar";
import { ToolConfirmCard } from "@/pages/chat/ToolConfirmCard";
import { AskUserCard } from "@/pages/chat/AskUserCard";
import { NextActionsCard } from "@/pages/chat/NextActionsCard";
import { cn } from "@/lib/utils";
import type { Attachment } from "@/lib/llm/attachments";
import type { ToolCallView } from "@/lib/work-artifact-views";
import type { ToolConfirmRequest, AskUserRequest } from "@/lib/llm/tools";
import type { NextAction } from "@/lib/workflow/types";
import type { StreamActivityPhase } from "@/pages/chat/streaming-status";

type PermissionMode = "read" | "confirm" | "auto";

interface ChatInputDockProps {
  inputAreaRef: MutableRefObject<HTMLDivElement | null>;
  inputRef: MutableRefObject<HTMLTextAreaElement | null>;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onPaste: (event: ClipboardEvent) => void;
  activeToolCall: ToolCallView | undefined;
  isStreaming: boolean;
  streamActivityPhase: StreamActivityPhase;
  /** 本轮已耗时（毫秒）——透传给 WorkingStatusBar 做「响应较慢」提示 */
  streamElapsedMs: number;
  workspacePath: string | null;
  onClearWorkspace: () => void;
  onChooseWorkspace: () => void;
  permissionMode: PermissionMode;
  onPermissionModeChange: (mode: PermissionMode) => void;
  draftAttachments: Attachment[];
  onRemoveAttachment: (id: string) => void;
  selectedModelName: string | null;
  onStop: () => void;
  /** UI 修复（2026-07-02）：写操作确认从独立悬浮卡片改成贴着输入框的小提示条 */
  pendingConfirm: ToolConfirmRequest | null;
  onResolveConfirm: (ok: boolean) => void;
  /** ask_user_question 工具的结构化追问——跟 pendingConfirm 同一个槽位，优先级更高 */
  pendingQuestion: AskUserRequest | null;
  onResolveQuestion: (answer: string) => void;
  /** Task #9：workflow 上一步做完后等用户选下一步——跟 pendingConfirm/pendingQuestion 同一个
   *  槽位，优先级最低（那两个是"有个工具调用正等着"，这个是"空闲，等你选方向"）。 */
  pendingNextActions: NextAction[] | null;
  onPickNextAction: (actionId: string) => void;
}

export function ChatInputDock({
  inputAreaRef,
  inputRef,
  onSubmit,
  onPaste,
  activeToolCall,
  isStreaming,
  streamActivityPhase,
  streamElapsedMs,
  workspacePath,
  onClearWorkspace,
  onChooseWorkspace,
  permissionMode,
  onPermissionModeChange,
  draftAttachments,
  onRemoveAttachment,
  selectedModelName,
  onStop,
  pendingConfirm,
  onResolveConfirm,
  pendingQuestion,
  onResolveQuestion,
  pendingNextActions,
  onPickNextAction,
}: ChatInputDockProps) {
  const { t } = useTranslation();

  return (
    <div ref={inputAreaRef} className="absolute bottom-3 left-8 right-8 z-20 pointer-events-none">
      <form
        onSubmit={onSubmit}
        onPaste={onPaste}
        className="max-w-4xl mx-auto glass rounded-[2.5rem] border border-white/20 shadow-2xl p-2.5 flex gap-3 pointer-events-auto group transition-all duration-500 hover:border-primary/30"
      >
        <div className="flex-1 relative flex flex-col">
          <div className="px-6 pt-2">
            {/* UI 修复（2026-07-02，用户反馈）：确认提示直接长在这一行（跟"空闲，等你发话"
                同一行），不再另起一行撑高输入框，也不再单独悬浮成一张卡片。 */}
            {pendingQuestion ? (
              <AskUserCard request={pendingQuestion} onResolve={onResolveQuestion} />
            ) : pendingConfirm ? (
              <ToolConfirmCard request={pendingConfirm} onResolve={onResolveConfirm} />
            ) : pendingNextActions && pendingNextActions.length > 0 ? (
              <NextActionsCard actions={pendingNextActions} onPick={onPickNextAction} />
            ) : (
              <WorkingStatusBar activeCall={activeToolCall} running={isStreaming} phase={streamActivityPhase} elapsedMs={streamElapsedMs} />
            )}
          </div>
          {workspacePath ? (
            <div className="flex items-center gap-2 flex-wrap px-6 pt-2">
              <span
                className="inline-flex items-center gap-1 text-xs rounded-lg pl-2 pr-1 py-1 border bg-primary/10 border-primary/30 text-primary max-w-[220px]"
                title={workspacePath}
              >
                <FolderOpen className="w-3 h-3 shrink-0" />
                <span className="font-medium truncate">{workspacePath.split("/").filter(Boolean).pop()}</span>
                <button
                  type="button"
                  onClick={onClearWorkspace}
                  disabled={isStreaming}
                  title={t("chat.workspace.clear")}
                  className="shrink-0 p-0.5 rounded hover:bg-primary/20 disabled:opacity-40"
                >
                  <X className="w-3 h-3" />
                </button>
              </span>
              <div className="flex items-center rounded-lg bg-muted/40 p-0.5">
                {([["read", Lock], ["confirm", ShieldCheck], ["auto", Zap]] as const).map(([mode, Icon]) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => onPermissionModeChange(mode)}
                    title={t(`chat.permission.${mode}Hint`)}
                    className={cn(
                      "px-2 py-1 rounded-md text-[10px] font-bold flex items-center gap-1 transition-colors",
                      permissionMode === mode ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <Icon className="w-3 h-3" />
                    {t(`chat.permission.${mode}`)}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="px-6 pt-2">
              <button
                type="button"
                onClick={onChooseWorkspace}
                disabled={isStreaming}
                className="inline-flex items-center gap-1 text-xs rounded-lg px-2 py-1 border border-dashed border-white/15 text-muted-foreground hover:text-primary hover:border-primary/30 transition-colors disabled:opacity-40"
              >
                <FolderOpen className="w-3 h-3" />
                {t("chat.workspace.choose")}
              </button>
            </div>
          )}
          {draftAttachments.length > 0 && (
            <div className="flex flex-wrap gap-2 px-6 pt-2">
              {draftAttachments.map((a) => (
                <div key={a.id} className="relative group/att">
                  {a.kind === "image" ? (
                    <img src={a.dataUrl} alt={a.name} className="w-14 h-14 object-cover rounded-lg border border-white/10" />
                  ) : a.kind === "folder" ? (
                    <span className="inline-flex items-center gap-1 text-xs rounded-lg px-2 py-1 border bg-primary/10 border-primary/30 text-primary">
                      <FolderOpen className="w-3 h-3" /> {a.name}
                    </span>
                  ) : (
                    <span className={cn("inline-flex items-center gap-1 text-xs rounded-lg px-2 py-1 border", a.tooLarge ? "bg-muted/20 border-dashed text-muted-foreground" : "bg-white/10 border-white/10")}>
                      <Paperclip className="w-3 h-3" /> {a.name}
                    </span>
                  )}
                  <button type="button" onClick={() => onRemoveAttachment(a.id)} className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center shadow-lg opacity-0 group-hover/att:opacity-100 transition-opacity">
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
          <textarea
            ref={inputRef}
            name="input"
            rows={1}
            placeholder={
              isStreaming
                ? t("chat.inputDraftHint")
                : selectedModelName
                  ? t("chat.inputPlaceholder", { name: selectedModelName })
                  : t("chat.inputPlaceholderFallback")
            }
            autoComplete="off"
            onChange={(e) => {
              e.target.style.height = "auto";
              e.target.style.height = Math.min(e.target.scrollHeight, 192) + "px";
            }}
            onKeyDown={(e) => {
              const native = e.nativeEvent as KeyboardEvent & { isComposing?: boolean; keyCode?: number };
              if (native.isComposing || native.keyCode === 229) return;
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                (e.currentTarget.form as HTMLFormElement | null)?.requestSubmit();
              }
            }}
            className="w-full bg-transparent border-none outline-none focus:outline-none focus:ring-0 text-sm px-6 py-4 placeholder:text-muted-foreground/40 font-medium resize-none max-h-[12rem] overflow-y-auto"
          />
        </div>
        <div className="flex items-center pr-1.5">
          {isStreaming ? (
            <Button
              type="button"
              variant="destructive"
              onClick={onStop}
              className="w-12 h-12 rounded-[1.5rem] animate-pulse shadow-lg shadow-red-500/20"
            >
              <Square className="w-5 h-5 fill-current" />
            </Button>
          ) : (
            <Button
              type="submit"
              className="w-12 h-12 rounded-[1.5rem] bg-primary shadow-lg shadow-primary/30 hover:scale-110 active:scale-95 transition-all duration-300 group-hover:rotate-[-5deg]"
            >
              <Send className="w-5 h-5" />
            </Button>
          )}
        </div>
      </form>
    </div>
  );
}
