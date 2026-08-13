import { describe, expect, it, vi } from "vitest";
import type { TurnIntentDecision } from "@/lib/workflow/types";
import { resolveWriteGuardRuntime } from "@/pages/chat/write-guard-runtime";
import type { ChatMessage } from "@/pages/chat/types";

const writeDecision: TurnIntentDecision = {
  action: "answer_only",
  targetRunId: null,
  confidence: 1,
  reason: "test",
  evidenceTurnIds: [],
  patch: { executionMode: "execute_directly" },
};

// 2026-07-18 写权限双层重构：resolveWriteGuardRuntime 不再"逼用户升级权限档"——
// 原 escalatePermission 弹窗 + promptedConversationIds 去重逻辑已删除，权限档完全由用户
// 在输入框旁边的三档开关自己切。函数现在只做提示（没有工作文件夹 / 只读档写意图），
// 不再返回 effectivePermissionMode（恒等于入参，调用方直接用入参即可）。
describe("resolveWriteGuardRuntime", () => {
  it("普通聊天不改权限，也不插提示", async () => {
    const setMessages = vi.fn();

    await resolveWriteGuardRuntime({
      text: "解释一下这个概念",
      decision: null,
      workspacePath: "/tmp/project",
      permissionMode: "read",
      assistantId: "assistant-1",
      labels: labels(),
      setMessages,
    });

    expect(setMessages).not.toHaveBeenCalled();
  });

  it("有写意图但没有工作区时插入 noWorkspace 提示", async () => {
    const setMessages = vi.fn();

    await resolveWriteGuardRuntime({
      text: "帮我写入文件",
      decision: writeDecision,
      workspacePath: null,
      permissionMode: "read",
      assistantId: "assistant-1",
      labels: labels(),
      setMessages,
    });

    const update = setMessages.mock.calls[0]?.[0] as (messages: ChatMessage[]) => ChatMessage[];
    expect(update([{ id: "assistant-1", role: "assistant", content: "" }])).toMatchObject([
      { content: "no workspace", kind: "system-notice" },
      { id: "assistant-1" },
    ]);
  });

  it("只读档位 + 有工作区 + 有写意图：插入 readOnly 友好提示，不再弹权限升级", async () => {
    const setMessages = vi.fn();

    await resolveWriteGuardRuntime({
      text: "保存到文件",
      decision: writeDecision,
      workspacePath: "/tmp/project",
      permissionMode: "read",
      assistantId: "assistant-1",
      labels: labels(),
      setMessages,
    });

    const update = setMessages.mock.calls[0]?.[0] as (messages: ChatMessage[]) => ChatMessage[];
    expect(update([{ id: "assistant-1", role: "assistant", content: "" }])[0]).toMatchObject({
      content: "read only",
      kind: "system-notice",
    });
  });

  it("confirm 档位 + 有工作区 + 有写意图：不插提示（能写，写盘走下游确认）", async () => {
    const setMessages = vi.fn();

    await resolveWriteGuardRuntime({
      text: "保存到文件",
      decision: writeDecision,
      workspacePath: "/tmp/project",
      permissionMode: "confirm",
      assistantId: "assistant-1",
      labels: labels(),
      setMessages,
    });

    expect(setMessages).not.toHaveBeenCalled();
  });

  it("auto 档位 + 有工作区 + 有写意图：不插提示", async () => {
    const setMessages = vi.fn();

    await resolveWriteGuardRuntime({
      text: "保存到文件",
      decision: writeDecision,
      workspacePath: "/tmp/project",
      permissionMode: "auto",
      assistantId: "assistant-1",
      labels: labels(),
      setMessages,
    });

    expect(setMessages).not.toHaveBeenCalled();
  });
});

function labels() {
  return {
    noWorkspace: "no workspace",
    readOnly: "read only",
    dynamicModelPool: "dynamic",
  };
}
