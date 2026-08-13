import type { Dispatch, SetStateAction } from "react";
import { impliesWriteIntent } from "@/lib/llm/tool-permission-policy";
import type { TurnIntentDecision } from "@/lib/workflow/types";
import type { ChatMessage } from "@/pages/chat/types";

export type ChatPermissionMode = "read" | "confirm" | "auto";

export interface WriteGuardLabels {
  noWorkspace: string;
  readOnly: string;
  dynamicModelPool: string;
}

export interface ResolveWriteGuardRuntimeArgs {
  text: string;
  decision: TurnIntentDecision | null;
  workspacePath: string | null;
  permissionMode: ChatPermissionMode;
  assistantId: string;
  labels: WriteGuardLabels;
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
}

/**
 * 写权限双层重构（2026-07-18）：写权限不再由这里"逼用户升级权限档"（原来的
 * escalatePermission 弹窗 + promptedConversationIds 去重已删除——权限档现在完全由用户在
 * 输入框旁边的三档开关自己选，read/confirm/auto 语义见 app-settings.ts）。
 *
 * 这个函数现在只做一件事：检测到本轮想写但当前是「只读」档位时，插一条友好提示，引导
 * 用户自己去点权限档开关切到「确认后修改」；不再有任何副作用改权限档位本身。
 * 没有工作文件夹时的提示（noWorkspace）不受权限档位影响，两种场景都保留。
 */
export async function resolveWriteGuardRuntime(args: ResolveWriteGuardRuntimeArgs): Promise<void> {
  const decision = args.decision ?? {
    action: "answer_only",
    targetRunId: null,
    confidence: 1,
    reason: "write-guard-default",
    evidenceTurnIds: [],
  };

  if (
    !impliesWriteIntent({ text: args.text, decision }) ||
    (args.workspacePath && args.permissionMode !== "read")
  ) {
    return;
  }

  const noticeMsg: ChatMessage = {
    id: crypto.randomUUID(),
    role: "assistant",
    content: !args.workspacePath ? args.labels.noWorkspace : args.labels.readOnly,
    createdAt: new Date().toISOString(),
    modelLabel: args.labels.dynamicModelPool,
    kind: "system-notice",
  };
  args.setMessages((prev) => {
    const idx = prev.findIndex((message) => message.id === args.assistantId);
    if (idx === -1) return [...prev, noticeMsg];
    return [...prev.slice(0, idx), noticeMsg, ...prev.slice(idx)];
  });
}
