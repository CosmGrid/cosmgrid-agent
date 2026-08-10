import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TurnIntentDecision } from "@/lib/workflow/types";
import { runSemanticCacheRuntime } from "@/pages/chat/cache-runtime";
import type { ChatMessage } from "@/pages/chat/types";

const mocks = vi.hoisted(() => ({
  lookupCache: vi.fn(),
}));

vi.mock("@/lib/llm/semantic-cache", () => ({
  lookupCache: mocks.lookupCache,
}));

const answerOnlyDecision: TurnIntentDecision = {
  action: "answer_only",
  targetRunId: null,
  confidence: 1,
  reason: "test",
  evidenceTurnIds: [],
};

describe("runSemanticCacheRuntime", () => {
  beforeEach(() => {
    mocks.lookupCache.mockReset();
    vi.spyOn(crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000001");
  });

  it("命中缓存时展示缓存答案、持久化，并结束本轮流式状态", async () => {
    mocks.lookupCache.mockResolvedValue({
      id: "cache-1",
      responseText: "cached answer",
      modelId: "model-1",
      similarity: 0.96,
      ageMs: 2 * 86_400_000,
    });
    const setMessages = vi.fn();
    const persistAssistant = vi.fn();
    const onCacheHitDone = vi.fn();
    const newMessages: ChatMessage[] = [{ id: "user-1", role: "user", content: "hello" }];

    const result = await runSemanticCacheRuntime({
      text: "解释一下这个概念",
      newMessages,
      modelId: "model-1",
      modelLabel: "Model One",
      pureMode: false,
      smartRoutingEnabled: true,
      workspacePath: null,
      workflowSnapshot: null,
      intentJudgeCalledThisTurn: true,
      turnIntentDecision: answerOnlyDecision,
      intentJudgeModel: null,
      persistAssistant,
      cacheHitLabel: (days) => `${days} days`,
      markStickToBottom: vi.fn(),
      setMessages,
      setIsStreaming: vi.fn(),
      setStreamError: vi.fn(),
      setSwitchNotice: vi.fn(),
      setCacheNotice: vi.fn(),
      setPersistNotice: vi.fn(),
      onCacheHitDone,
      isCurrentTurn: () => true,
    });

    expect(result.hit).toBe(true);
    expect(setMessages).toHaveBeenCalledWith([...newMessages, expect.objectContaining({ id: "00000000-0000-4000-8000-000000000001" })]);
    const update = setMessages.mock.calls[1]?.[0] as (messages: ChatMessage[]) => ChatMessage[];
    expect(update([{ id: "00000000-0000-4000-8000-000000000001", role: "assistant", content: "" }])).toEqual([
      { id: "00000000-0000-4000-8000-000000000001", role: "assistant", content: "cached answer" },
    ]);
    expect(persistAssistant).toHaveBeenCalledWith("cached answer", "model-1");
    expect(onCacheHitDone).toHaveBeenCalledOnce();
  });

  it("未命中缓存时返回主流式流程需要的准备数据", async () => {
    mocks.lookupCache.mockResolvedValue(null);

    const result = await runSemanticCacheRuntime({
      text: "解释一下这个概念",
      newMessages: [],
      modelId: "model-1",
      modelLabel: "Model One",
      pureMode: false,
      smartRoutingEnabled: true,
      workspacePath: null,
      workflowSnapshot: null,
      intentJudgeCalledThisTurn: true,
      turnIntentDecision: answerOnlyDecision,
      intentJudgeModel: null,
      persistAssistant: vi.fn(),
      cacheHitLabel: (days) => `${days} days`,
      markStickToBottom: vi.fn(),
      setMessages: vi.fn(),
      setIsStreaming: vi.fn(),
      setStreamError: vi.fn(),
      setSwitchNotice: vi.fn(),
      setCacheNotice: vi.fn(),
      setPersistNotice: vi.fn(),
      onCacheHitDone: vi.fn(),
      isCurrentTurn: () => true,
    });

    expect(result).toMatchObject({
      hit: false,
      assistantId: "00000000-0000-4000-8000-000000000001",
      taskRole: "standard",
      cacheEligible: true,
      cacheIntent: answerOnlyDecision,
    });
  });

  it("Stop 后晚到的缓存命中不持久化，也不覆盖新轮提示", async () => {
    let resolveLookup!: (value: {
      id: string;
      responseText: string;
      modelId: string;
      similarity: number;
      ageMs: number;
    }) => void;
    mocks.lookupCache.mockImplementation(() => new Promise((resolve) => {
      resolveLookup = resolve;
    }));
    let current = true;
    const persistAssistant = vi.fn();
    const setCacheNotice = vi.fn();
    const onCacheHitDone = vi.fn();
    const setMessages = vi.fn();

    const pending = runSemanticCacheRuntime({
      text: "解释一下这个概念",
      newMessages: [],
      modelId: "model-1",
      modelLabel: "Model One",
      pureMode: false,
      smartRoutingEnabled: true,
      workspacePath: null,
      workflowSnapshot: null,
      intentJudgeCalledThisTurn: true,
      turnIntentDecision: answerOnlyDecision,
      intentJudgeModel: null,
      persistAssistant,
      cacheHitLabel: (days) => `${days} days`,
      markStickToBottom: vi.fn(),
      setMessages,
      setIsStreaming: vi.fn(),
      setStreamError: vi.fn(),
      setSwitchNotice: vi.fn(),
      setCacheNotice,
      setPersistNotice: vi.fn(),
      onCacheHitDone,
      isCurrentTurn: () => current,
    });

    await vi.waitFor(() => expect(mocks.lookupCache).toHaveBeenCalledOnce());
    current = false;
    resolveLookup({
      id: "cache-late",
      responseText: "late cached answer",
      modelId: "model-1",
      similarity: 0.99,
      ageMs: 0,
    });

    await expect(pending).resolves.toEqual({ hit: true });
    expect(setMessages).toHaveBeenCalledTimes(1);
    expect(persistAssistant).not.toHaveBeenCalled();
    expect(setCacheNotice).not.toHaveBeenCalledWith(expect.stringContaining("days"));
    expect(onCacheHitDone).not.toHaveBeenCalled();
  });
});
