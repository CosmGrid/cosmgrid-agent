import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  executeDebateTurn: vi.fn(),
  createWorkflow: vi.fn(),
  saveWorkflow: vi.fn(),
}));

vi.mock("@/lib/llm/debate-turn", () => ({
  executeDebateTurn: mocks.executeDebateTurn,
}));

vi.mock("@/lib/db", () => ({
  workflowRuns: {
    create: mocks.createWorkflow,
    saveSnapshot: mocks.saveWorkflow,
  },
}));

import {
  runDebateRuntime,
  shouldRunDebateTurn,
} from "@/pages/chat/debate-runtime";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

function makeRuntimeOptions(overrides: Record<string, unknown> = {}) {
  return {
    prep: {
      conversationId: null,
      workspacePath: null,
      workflowSnapshot: null,
      workflowRunId: null,
      intentDecision: null,
      persistAssistant: vi.fn(),
    },
    pureMode: false,
    text: "开始多模型对弈，互相反驳后裁判",
    model: { id: "model-1", name: "Model One" },
    availableModels: [{ id: "model-1", name: "Model One" }],
    credentials: [],
    conversationList: [],
    messages: [],
    userMessage: { id: "user-1", role: "user", content: "debate" },
    visibleMessages: [],
    controller: new AbortController(),
    getApiKey: vi.fn(),
    t: ((key: string) => key),
    applyWorkflowSnapshot: vi.fn(),
    setMessages: vi.fn(),
    setPanelOpen: vi.fn(),
    setIsStreaming: vi.fn(),
    setStreamError: vi.fn(),
    setSwitchNotice: vi.fn(),
    setCacheNotice: vi.fn(),
    setPersistNotice: vi.fn(),
    setDebateParticipants: vi.fn(),
    markStickToBottom: vi.fn(),
    isCurrentTurn: () => true,
    releaseTurnState: vi.fn(() => true),
    ...overrides,
  };
}

beforeEach(() => {
  mocks.executeDebateTurn.mockReset();
  mocks.createWorkflow.mockReset().mockResolvedValue(undefined);
  mocks.saveWorkflow.mockReset().mockResolvedValue(undefined);
  vi.spyOn(crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000001");
});

describe("shouldRunDebateTurn", () => {
  it("never starts debate in pure single-model mode", () => {
    expect(
      shouldRunDebateTurn({
        pureMode: true,
        text: "让几个模型互相反驳并裁判",
        intentDecision: {
          action: "continue_run",
          targetRunId: null,
          confidence: 1,
          reason: "explicit",
          evidenceTurnIds: [],
          patch: { debateRequested: true },
        },
      }),
    ).toBe(false);
  });

  it("starts from either the intent decision or an explicit user request", () => {
    expect(
      shouldRunDebateTurn({
        pureMode: false,
        text: "继续",
        intentDecision: {
          action: "continue_run",
          targetRunId: null,
          confidence: 1,
          reason: "intent",
          evidenceTurnIds: [],
          patch: { debateRequested: true },
        },
      }),
    ).toBe(true);

    expect(
      shouldRunDebateTurn({
        pureMode: false,
        text: "开始多模型对弈，互相反驳后裁判",
        intentDecision: null,
      }),
    ).toBe(true);
  });

  it("does not start for an ordinary chat turn", () => {
    expect(
      shouldRunDebateTurn({
        pureMode: false,
        text: "解释一下现在的进度",
        intentDecision: null,
      }),
    ).toBe(false);
  });
});

describe("runDebateRuntime turn ownership", () => {
  it("旧对弈晚成功时不得写入或清除已经开始的新轮状态", async () => {
    const turn = deferred<{
      content: string;
      usage: { inputTokens: number; outputTokens: number };
      participants: unknown[];
      result: { rounds: unknown[]; finalSolution: string };
    }>();
    mocks.executeDebateTurn.mockReturnValue(turn.promise);
    let current = true;
    const releaseTurnState = vi.fn(() => false);
    const options = makeRuntimeOptions({
      isCurrentTurn: () => current,
      releaseTurnState,
    });

    const pending = runDebateRuntime(options as never);
    await vi.waitFor(() => expect(mocks.executeDebateTurn).toHaveBeenCalledOnce());
    current = false;
    turn.resolve({
      content: "旧轮晚到答案",
      usage: { inputTokens: 1, outputTokens: 1 },
      participants: [],
      result: { rounds: [], finalSolution: "旧轮晚到答案" },
    });

    await expect(pending).resolves.toBe(true);
    expect(options.setMessages).toHaveBeenCalledTimes(1);
    expect(options.prep.persistAssistant).not.toHaveBeenCalled();
    expect(options.setIsStreaming).toHaveBeenCalledTimes(1);
    expect(options.setIsStreaming).toHaveBeenLastCalledWith(true);
    expect(options.setDebateParticipants).not.toHaveBeenCalledWith(null);
    expect(releaseTurnState).toHaveBeenCalledOnce();
  });

  it("旧对弈取消结果可落旧 workflow，但不得把旧快照覆盖到当前界面", async () => {
    const turn = deferred<never>();
    mocks.executeDebateTurn.mockReturnValue(turn.promise);
    let current = true;
    const applyWorkflowSnapshot = vi.fn();
    const options = makeRuntimeOptions({
      prep: {
        conversationId: null,
        workspacePath: null,
        workflowSnapshot: {
          runId: "run-old",
          status: "running",
          currentNodeId: "node-old",
          nodes: [{ id: "node-old", status: "running" }],
        },
        workflowRunId: "run-old",
        intentDecision: null,
        persistAssistant: vi.fn(),
      },
      applyWorkflowSnapshot,
      isCurrentTurn: () => current,
      releaseTurnState: vi.fn(() => false),
    });

    const pending = runDebateRuntime(options as never);
    await vi.waitFor(() => expect(mocks.executeDebateTurn).toHaveBeenCalledOnce());
    current = false;
    const abortError = new Error("stopped");
    abortError.name = "AbortError";
    turn.reject(abortError);

    await expect(pending).resolves.toBe(true);
    expect(mocks.saveWorkflow).toHaveBeenCalledOnce();
    expect(applyWorkflowSnapshot).not.toHaveBeenCalled();
    expect(options.setIsStreaming).toHaveBeenCalledTimes(1);
    expect(options.setDebateParticipants).not.toHaveBeenCalledWith(null);
  });
});
