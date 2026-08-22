import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __setLimitMapForTest } from "../model-limits";

vi.mock("../../db", () => ({
  toolExecutions: { create: vi.fn().mockResolvedValue("id") },
  conversations: { getById: vi.fn().mockResolvedValue(null) },
}));

const mocks = vi.hoisted(() => ({
  buildAiSdkTools: vi.fn(),
  createDefaultToolRegistry: vi.fn(),
  buildWorkspacePreamble: vi.fn(),
}));

vi.mock("../tools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tools")>();
  return {
    ...actual,
    // 只替换 createDefaultToolRegistry/buildAiSdkTools（有工作区分支用），ToolRegistry 保留真实实现——
    // 没绑工作区的新分支（2026-07-05）直接 new ToolRegistry() 注册 web_fetch/remember，
    // 假的类会在真实代码路径里被 new 出来，必须是能跑的真类，不能被 vi.fn() 顶掉。
    buildAiSdkTools: mocks.buildAiSdkTools,
    createDefaultToolRegistry: mocks.createDefaultToolRegistry,
  };
});

vi.mock("../prompts/workspace-context", () => ({
  buildWorkspacePreamble: mocks.buildWorkspacePreamble,
}));

const { prepareWorkspaceToolRuntime } = await import("../workspace-tool-runtime");

describe("prepareWorkspaceToolRuntime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createDefaultToolRegistry.mockReturnValue({ registry: true });
    mocks.buildAiSdkTools.mockReturnValue({ read: { description: "read" } });
    mocks.buildWorkspacePreamble.mockResolvedValue("workspace preamble");
  });

  it("没有 workspacePath 时不走 createDefaultToolRegistry/项目说明，但仍构造 web_fetch 等不依赖工作区的工具", async () => {
    const runtime = await prepareWorkspaceToolRuntime({ workspacePath: null, includeWrite: true });

    expect(runtime.workspacePreamble).toBeNull();
    expect(mocks.createDefaultToolRegistry).not.toHaveBeenCalled();
    expect(mocks.buildWorkspacePreamble).not.toHaveBeenCalled();
    // buildAiSdkTools 仍会被调用一次——用真实 ToolRegistry 只装 web_fetch/ask_user_question（无 conversationId 时不装 remember）
    expect(mocks.buildAiSdkTools).toHaveBeenCalledTimes(1);
    const [registryArg, ctxArg] = mocks.buildAiSdkTools.mock.calls[0]!;
    expect(registryArg.has("web_fetch")).toBe(true);
    expect(registryArg.has("ask_user_question")).toBe(true);
    expect(registryArg.has("remember")).toBe(false);
    expect(ctxArg).toMatchObject({ workspacePath: "" });
  });

  it("没有 workspacePath 时也透传 askUser 回调到 ctx", async () => {
    const askUser = vi.fn();
    await prepareWorkspaceToolRuntime({ workspacePath: null, includeWrite: true, askUser });

    const [, ctxArg] = mocks.buildAiSdkTools.mock.calls[0]!;
    expect(ctxArg.askUser).toBe(askUser);
  });

  it("没有 workspacePath 但有 conversationId 时，web_fetch + remember 都装", async () => {
    await prepareWorkspaceToolRuntime({
      workspacePath: null,
      includeWrite: true,
      conversationId: "conv-1",
      messageId: "msg-1",
    });

    const [registryArg, ctxArg] = mocks.buildAiSdkTools.mock.calls[0]!;
    expect(registryArg.has("web_fetch")).toBe(true);
    expect(registryArg.has("remember")).toBe(true);
    expect(ctxArg).toMatchObject({ workspacePath: "", conversationId: "conv-1", messageId: "msg-1" });
  });

  it("构造工具时透传工作区、确认回调和关联实体", async () => {
    const confirm = vi.fn();
    const runtime = await prepareWorkspaceToolRuntime({
      workspacePath: "/ws",
      includeWrite: true,
      projectId: "proj-1",
      conversationId: "conv-1",
      confirm,
      blockedCommands: ["rm"],
    });

    expect(runtime.tools).toEqual({ read: { description: "read" } });
    expect(mocks.createDefaultToolRegistry).toHaveBeenCalledWith({ includeWrite: true });
    expect(mocks.buildAiSdkTools).toHaveBeenCalledWith({ registry: true }, {
      workspacePath: "/ws",
      projectId: "proj-1",
      conversationId: "conv-1",
      confirm,
      blockedCommands: ["rm"],
    });
    expect(mocks.buildWorkspacePreamble).not.toHaveBeenCalled();
  });

  it("构造工具时独立透传 commandAuthorization", async () => {
    const requestHumanConfirm = vi.fn();
    const commandAuthorization = { permissionMode: "auto" as const, requestHumanConfirm };
    await prepareWorkspaceToolRuntime({
      workspacePath: "/ws",
      includeWrite: true,
      confirm: vi.fn(),
      commandAuthorization,
    });

    const [, ctxArg] = mocks.buildAiSdkTools.mock.calls[0]!;
    expect(ctxArg.commandAuthorization).toMatchObject({
      permissionMode: "auto",
      requestHumanConfirm,
      authorizedReadRoots: ["/ws"],
    });
    expect(ctxArg.commandAuthorization).not.toBe(commandAuthorization);
    expect(ctxArg.confirm).not.toBe(requestHumanConfirm);
  });

  it("即使上游运行时恶意 cast 注入 roots，也只覆盖为当前 workspace；无 workspace 为空", async () => {
    const malicious = {
      permissionMode: "read" as const,
      requestHumanConfirm: vi.fn(),
      authorizedReadRoots: ["/Users/me/Desktop", "/Users/me"],
    } as never;
    await prepareWorkspaceToolRuntime({
      workspacePath: "/ws",
      includeWrite: true,
      commandAuthorization: malicious,
    });
    let [, ctxArg] = mocks.buildAiSdkTools.mock.calls[0]!;
    expect(ctxArg.commandAuthorization.authorizedReadRoots).toEqual(["/ws"]);

    vi.clearAllMocks();
    mocks.createDefaultToolRegistry.mockReturnValue({ registry: true });
    mocks.buildAiSdkTools.mockReturnValue({ read: { description: "read" } });
    await prepareWorkspaceToolRuntime({ workspacePath: null, includeWrite: true, commandAuthorization: malicious });
    [, ctxArg] = mocks.buildAiSdkTools.mock.calls[0]!;
    expect(ctxArg.commandAuthorization.authorizedReadRoots).toEqual([]);
  });

  it("绑了工作区时也透传 askUser 回调到 ctx", async () => {
    const askUser = vi.fn();
    await prepareWorkspaceToolRuntime({ workspacePath: "/ws", includeWrite: true, askUser });

    const [, ctxArg] = mocks.buildAiSdkTools.mock.calls[0]!;
    expect(ctxArg.askUser).toBe(askUser);
  });

  it("项目说明读取失败不影响工具", async () => {
    mocks.buildWorkspacePreamble.mockRejectedValue(new Error("read failed"));

    const runtime = await prepareWorkspaceToolRuntime({
      workspacePath: "/ws",
      includeWrite: false,
      includePreamble: true,
    });

    expect(runtime.tools).toEqual({ read: { description: "read" } });
    expect(runtime.workspacePreamble).toBeNull();
    expect(mocks.buildWorkspacePreamble).toHaveBeenCalledWith("/ws", { includeWrite: false });
  });

  it("工具构造失败不影响项目说明", async () => {
    mocks.buildAiSdkTools.mockImplementation(() => {
      throw new Error("tool failed");
    });

    const runtime = await prepareWorkspaceToolRuntime({
      workspacePath: "/ws",
      includeWrite: false,
      includePreamble: true,
    });

    expect(runtime.tools).toBeUndefined();
    expect(runtime.workspacePreamble).toBe("workspace preamble");
    expect(mocks.buildWorkspacePreamble).toHaveBeenCalledWith("/ws", { includeWrite: false });
  });

  it("项目说明读取时透传 includeWrite", async () => {
    await prepareWorkspaceToolRuntime({
      workspacePath: "/ws",
      includeWrite: true,
      includePreamble: true,
    });

    expect(mocks.buildWorkspacePreamble).toHaveBeenCalledWith("/ws", { includeWrite: true });
  });

  it("透传 desktopPath 给 buildWorkspacePreamble（让模型知道桌面在哪，能自己用 write 工具存桌面）", async () => {
    await prepareWorkspaceToolRuntime({
      workspacePath: "/ws",
      includeWrite: true,
      includePreamble: true,
      desktopPath: "/Users/me/Desktop",
    });

    expect(mocks.buildWorkspacePreamble).toHaveBeenCalledWith("/ws", {
      includeWrite: true,
      desktopPath: "/Users/me/Desktop",
    });
  });

  describe("OMO-7 capability guardrail：modelName 明确不支持工具调用", () => {
    afterEach(() => __setLimitMapForTest(null));

    it("绑了工作区 + modelName 明确不支持工具调用 → 不构建注册表，tools 为 undefined", async () => {
      __setLimitMapForTest(null, null, new Map([["no-tool-model", false]]));
      const runtime = await prepareWorkspaceToolRuntime({
        workspacePath: "/ws",
        includeWrite: true,
        modelName: "no-tool-model",
      });
      expect(runtime.tools).toBeUndefined();
      expect(mocks.createDefaultToolRegistry).not.toHaveBeenCalled();
      expect(mocks.buildAiSdkTools).not.toHaveBeenCalled();
    });

    it("没绑工作区 + modelName 明确不支持工具调用 → tools 为 undefined", async () => {
      __setLimitMapForTest(null, null, new Map([["no-tool-model", false]]));
      const runtime = await prepareWorkspaceToolRuntime({
        workspacePath: null,
        includeWrite: true,
        modelName: "no-tool-model",
      });
      expect(runtime.tools).toBeUndefined();
    });

    it("modelName 未收录（不确定）→ 不拦截，照常构建工具", async () => {
      __setLimitMapForTest(null, null, new Map());
      const runtime = await prepareWorkspaceToolRuntime({
        workspacePath: "/ws",
        includeWrite: true,
        modelName: "unknown-model",
      });
      expect(runtime.tools).toEqual({ read: { description: "read" } });
      expect(mocks.createDefaultToolRegistry).toHaveBeenCalledWith({ includeWrite: true, modelName: "unknown-model" });
    });
  });
});
