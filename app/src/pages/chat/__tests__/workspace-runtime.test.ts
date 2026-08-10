import { beforeEach, describe, expect, it, vi } from "vitest";
import { prepareChatWorkspaceRuntime } from "@/pages/chat/workspace-runtime";

const mocks = vi.hoisted(() => ({
  buildWorkspacePreamble: vi.fn(),
  prepareWorkspaceToolRuntime: vi.fn(),
}));

vi.mock("@/lib/llm/prompts/workspace-context", () => ({
  buildWorkspacePreamble: mocks.buildWorkspacePreamble,
}));

vi.mock("@/lib/llm/workspace-tool-runtime", () => ({
  prepareWorkspaceToolRuntime: mocks.prepareWorkspaceToolRuntime,
}));

vi.mock("@/lib/mcp/session-scope", () => ({
  formatLocalMcpLaunch: vi.fn(() => "launch details"),
}));

describe("prepareChatWorkspaceRuntime", () => {
  beforeEach(() => {
    mocks.buildWorkspacePreamble.mockReset().mockResolvedValue("workspace preamble");
    mocks.prepareWorkspaceToolRuntime.mockReset().mockResolvedValue({
      tools: { read: {} },
      workspacePreamble: "runtime preamble",
    });
  });

  it("CLI 有工作区时只构建工作区前言，不挂前端工具", async () => {
    const result = await prepareChatWorkspaceRuntime({
      workspacePath: "/tmp/project",
      primaryIsCli: true,
      includeWriteTools: true,
      conversationId: "conv-1",
      assistantId: "assistant-1",
      permissionMode: "confirm",
      requestConfirm: vi.fn(),
      requestAskUser: vi.fn(),
      getDesktopPath: async () => "/Users/me/Desktop",
      stopIfAborted: () => false,
    });

    expect(result).toMatchObject({
      aborted: false,
      desktopPath: "/Users/me/Desktop",
      workspacePreamble: "workspace preamble",
    });
    expect(result.tools).toBeUndefined();
    expect(mocks.buildWorkspacePreamble).toHaveBeenCalledWith("/tmp/project", {
      includeWrite: true,
      desktopPath: "/Users/me/Desktop",
    });
    expect(mocks.prepareWorkspaceToolRuntime).not.toHaveBeenCalled();
  });

  it("API 模型有工作区时准备工作区工具并绑定 assistant 消息", async () => {
    const requestConfirm = vi.fn();

    const result = await prepareChatWorkspaceRuntime({
      workspacePath: "/tmp/project",
      primaryIsCli: false,
      includeWriteTools: false,
      conversationId: "conv-1",
      assistantId: "assistant-1",
      permissionMode: "read",
      requestConfirm,
      requestAskUser: vi.fn(),
      getDesktopPath: async () => "/Users/me/Desktop",
      stopIfAborted: () => false,
    });

    expect(result.workspacePreamble).toBe("runtime preamble");
    expect(result.tools).toEqual({ read: {} });
    expect(mocks.prepareWorkspaceToolRuntime).toHaveBeenCalledWith(expect.objectContaining({
      workspacePath: "/tmp/project",
      includeWrite: false,
      conversationId: "conv-1",
      messageId: "assistant-1",
      includePreamble: true,
      desktopPath: null,
    }));
  });

  it("API 模型没工作区时仍准备无工作区工具兜底", async () => {
    const result = await prepareChatWorkspaceRuntime({
      workspacePath: null,
      primaryIsCli: false,
      includeWriteTools: false,
      conversationId: null,
      assistantId: "assistant-1",
      permissionMode: "read",
      requestConfirm: vi.fn(),
      requestAskUser: vi.fn(),
      getDesktopPath: async () => null,
      stopIfAborted: () => false,
    });

    expect(result.tools).toEqual({ read: {} });
    expect(mocks.prepareWorkspaceToolRuntime).toHaveBeenCalledWith(expect.objectContaining({
      includeWrite: false,
      conversationId: undefined,
      messageId: "assistant-1",
    }));
  });

  it("准备完成后如果已中止，返回 aborted", async () => {
    const result = await prepareChatWorkspaceRuntime({
      workspacePath: "/tmp/project",
      primaryIsCli: true,
      includeWriteTools: false,
      conversationId: null,
      assistantId: "assistant-1",
      permissionMode: "read",
      requestConfirm: vi.fn(),
      requestAskUser: vi.fn(),
      getDesktopPath: async () => null,
      stopIfAborted: () => true,
    });

    expect(result.aborted).toBe(true);
  });

  // 写权限双层重构（2026-07-18）：confirm 是新默认档——有写工具，但写盘前必须走真实确认。
  // 运行时允许在真人确认外再包一层本轮取消守卫，但不能自动放行。
  it("confirm 档位（新默认）：有写工具，且写盘确认回调是真实 requestConfirm，不自动放行", async () => {
    const requestConfirm = vi.fn(async () => true);

    await prepareChatWorkspaceRuntime({
      workspacePath: "/tmp/project",
      primaryIsCli: false,
      includeWriteTools: true,
      conversationId: "conv-1",
      assistantId: "assistant-1",
      permissionMode: "confirm",
      requestConfirm,
      requestAskUser: vi.fn(),
      getDesktopPath: async () => null,
      stopIfAborted: () => false,
    });

    const passedArgs = mocks.prepareWorkspaceToolRuntime.mock.calls[0][0];
    expect(passedArgs.includeWrite).toBe(true);
    await passedArgs.confirm({ toolName: "write", summary: "写入 foo.ts" });
    expect(requestConfirm).toHaveBeenCalledTimes(1);
  });

  it("auto 档位：有写工具，写盘确认自动放行，不调用 requestConfirm", async () => {
    const requestConfirm = vi.fn(async () => true);

    await prepareChatWorkspaceRuntime({
      workspacePath: "/tmp/project",
      primaryIsCli: false,
      includeWriteTools: true,
      conversationId: "conv-1",
      assistantId: "assistant-1",
      permissionMode: "auto",
      requestConfirm,
      requestAskUser: vi.fn(),
      getDesktopPath: async () => null,
      stopIfAborted: () => false,
    });

    const passedArgs = mocks.prepareWorkspaceToolRuntime.mock.calls[0][0];
    expect(passedArgs.confirm).not.toBe(requestConfirm);
    const approved = await passedArgs.confirm({ toolName: "write", summary: "写入 foo.ts" });
    expect(approved).toBe(true);
    expect(requestConfirm).not.toHaveBeenCalled();
  });

  it("Stop 后旧轮才请求 confirm 时直接拒绝，auto 档也不得继续旧写入", async () => {
    let stopped = false;
    const requestConfirm = vi.fn(async () => true);

    await prepareChatWorkspaceRuntime({
      workspacePath: "/tmp/project",
      primaryIsCli: false,
      includeWriteTools: true,
      conversationId: "conv-1",
      assistantId: "assistant-1",
      permissionMode: "auto",
      requestConfirm,
      requestAskUser: vi.fn(),
      getDesktopPath: async () => null,
      stopIfAborted: () => stopped,
    });

    stopped = true;
    const passedArgs = mocks.prepareWorkspaceToolRuntime.mock.calls[0][0];
    await expect(
      passedArgs.confirm({ toolName: "write", summary: "旧轮写入 foo.ts" }),
    ).resolves.toBe(false);
    expect(requestConfirm).not.toHaveBeenCalled();
  });

  it("Stop 后旧轮才请求 ask 或 MCP 启动时不再进入新轮弹窗队列", async () => {
    let stopped = false;
    const requestConfirm = vi.fn(async () => true);
    const requestAskUser = vi.fn(async () => "继续");

    await prepareChatWorkspaceRuntime({
      workspacePath: "/tmp/project",
      primaryIsCli: false,
      includeWriteTools: true,
      conversationId: "conv-1",
      assistantId: "assistant-1",
      permissionMode: "confirm",
      requestConfirm,
      requestAskUser,
      getDesktopPath: async () => null,
      stopIfAborted: () => stopped,
    });

    stopped = true;
    const passedArgs = mocks.prepareWorkspaceToolRuntime.mock.calls[0][0];
    await expect(
      passedArgs.askUser({ question: "旧轮还要继续吗？" }),
    ).resolves.toBeNull();
    await expect(
      passedArgs.approveMcpLaunch({ name: "local-test" }, "/tmp/project"),
    ).resolves.toBe(false);
    expect(requestAskUser).not.toHaveBeenCalled();
    expect(requestConfirm).not.toHaveBeenCalled();
  });
});
