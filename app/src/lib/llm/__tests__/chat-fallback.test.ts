// chat-fallback 单元测试（v0.4.1 重构版：models 数组 + SwitchReason + 内置 recordUsageEvent）
import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  streamText: vi.fn(),
}));

vi.mock("ai", () => ({ streamText: mocks.streamText, stepCountIs: (n: number) => n }));
// provider-factory 直接 mock 掉（不再需要验证 getLanguageModel 内部）
vi.mock("../provider-factory", () => ({
  getLanguageModel: vi.fn((type: string) => ({ __mock: true, type })),
}));
// recordUsageEvent mock 掉（隔离 chat-fallback 的内置 record 行为）
vi.mock("../usage-tracker", () => ({
  recordUsageEvent: vi.fn(),
}));

import {
  streamWithFallback,
  toModelEndpoint,
  type ModelEndpoint,
  type StreamCallbacks,
  type SwitchReason,
} from "../chat-fallback";
import { _resetCooldowns, isInCooldown, markModelFailed } from "../model-cooldown";
import { recordUsageEvent } from "../usage-tracker";

const primary: ModelEndpoint = {
  modelId: "m-primary",
  modelName: "primary-model",
  providerType: "anthropic",
  providerId: "prov-anthropic",
  apiCredentialId: "cred-anthropic",
  apiKey: "sk-test-primary",
  baseUrl: "https://api.anthropic.com",
  displayLabel: "Primary",
};

const fallback: ModelEndpoint = {
  modelId: "m-fallback",
  modelName: "fallback-model",
  providerType: "openai",
  providerId: "prov-openai",
  apiCredentialId: "cred-openai",
  apiKey: "sk-test-fallback",
  baseUrl: "https://api.openai.com",
  displayLabel: "Fallback",
};

beforeEach(() => {
  _resetCooldowns();
  mocks.streamText.mockReset();
  vi.mocked(recordUsageEvent).mockReset();
});

// C 档第2步（2026-07-12）：生产代码改读 result.fullStream（text-delta/reasoning-delta
// 分轨），不再只读 textStream——mock 也要跟着提供 fullStream，否则
// `for await (const part of result.fullStream)` 直接报 undefined 不可迭代。
// 仍然保留 textStream 字段（没有消费方读它了，留着无害，避免要改全部调用点类型）。
function makeSuccessStream(
  deltas: string[],
  usage = { inputTokens: 10, outputTokens: 5 },
  finishReason = "stop",
) {
  return {
    textStream: (async function* () {
      for (const d of deltas) yield d;
    })(),
    fullStream: (async function* () {
      for (const d of deltas) yield { type: "text-delta" as const, id: "0", text: d };
    })(),
    usage: Promise.resolve(usage),
    finishReason: Promise.resolve(finishReason),
  };
}

/** 模拟走结构化 reasoning 通道（如 DeepSeek reasoning_content）的模型：先吐若干
 *  reasoning-delta，再吐若干 text-delta。用于验证 fullStream 分轨改造真的生效。 */
function makeReasoningStream(
  reasoningDeltas: string[],
  textDeltas: string[],
  usage = { inputTokens: 10, outputTokens: 5 },
  finishReason = "stop",
) {
  return {
    textStream: (async function* () {
      for (const d of textDeltas) yield d;
    })(),
    fullStream: (async function* () {
      for (const d of reasoningDeltas) yield { type: "reasoning-delta" as const, id: "r0", text: d };
      yield { type: "reasoning-end" as const, id: "r0" };
      for (const d of textDeltas) yield { type: "text-delta" as const, id: "t0", text: d };
    })(),
    usage: Promise.resolve(usage),
    finishReason: Promise.resolve(finishReason),
  };
}

function makeFailingStream(error: unknown) {
  return {
    textStream: (async function* () {
      throw error;
    })(),
    fullStream: (async function* () {
      throw error;
    })(),
    usage: Promise.resolve(undefined),
    finishReason: Promise.resolve(undefined),
  };
}

function makePartialFailingStream(deltas: string[], error: unknown) {
  return {
    textStream: (async function* () {
      for (const d of deltas) yield d;
      throw error;
    })(),
    fullStream: (async function* () {
      for (const d of deltas) yield { type: "text-delta" as const, id: "0", text: d };
      throw error;
    })(),
    usage: Promise.resolve(undefined),
    finishReason: Promise.resolve(undefined),
  };
}

describe("streamWithFallback - 主模型正常", () => {
  it("主模型成功时不切 fallback", async () => {
    mocks.streamText.mockReturnValueOnce(makeSuccessStream(["Hi", " there"]));

    const deltas: string[] = [];
    const switched: Array<unknown> = [];
    const usages: Array<{ mid: string; reason: string }> = [];
    const audits: Array<unknown> = [];
    const cbs: StreamCallbacks = {
      onDelta: (d) => deltas.push(d),
      onSwitched: (f, t, r) => switched.push({ from: f.modelId, to: t.modelId, r }),
      onUsage: (_u, m, r) => usages.push({ mid: m.modelId, reason: r }),
      onInvocationAudit: (event) => audits.push(event),
    };

    const result = await streamWithFallback([primary, fallback], [{ role: "user", content: "hi" }], cbs);
    expect(result).toEqual({ usedModelId: "m-primary", switched: false });
    expect(deltas.join("")).toBe("Hi there");
    expect(switched).toEqual([]);
    expect(usages).toEqual([{ mid: "m-primary", reason: "stop" }]);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      modelId: "m-primary",
      providerType: "anthropic",
      providerKind: "api",
      status: "success",
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 5, toolCallCount: 0 },
    });
  });

  it("主模型成功时调用一次 streamText（不调 fallback）", async () => {
    mocks.streamText.mockReturnValueOnce(makeSuccessStream(["ok"]));
    const cbs: StreamCallbacks = { onDelta: () => {} };
    await streamWithFallback([primary, fallback], [{ role: "user", content: "x" }], cbs);
    expect(mocks.streamText).toHaveBeenCalledTimes(1);
  });
});

describe("阶段 F1 H2：actorRole 透传到 recordUsageEvent（review F1-1/-7）", () => {
  beforeEach(() => {
    mocks.streamText.mockReset();
    vi.mocked(recordUsageEvent).mockReset();
    _resetCooldowns();
  });

  it("actorRole='leader' → recordUsageEvent 入参含 roleKind='leader'（ChatPage 主对话场景）", async () => {
    mocks.streamText.mockReturnValueOnce(makeSuccessStream(["hi"]));
    const cbs: StreamCallbacks = { onDelta: () => {} };
    await streamWithFallback([primary], [{ role: "user", content: "x" }], cbs, {
      actorRole: "leader",
    });
    expect(vi.mocked(recordUsageEvent)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(recordUsageEvent).mock.calls[0]![0]).toMatchObject({ roleKind: "leader" });
  });

  it("actorRole=undefined → recordUsageEvent 入参不设 roleKind 字段（让 db 层 ?? null 兜底 → 落 NULL → 聚合'未分类'组）", async () => {
    mocks.streamText.mockReturnValueOnce(makeSuccessStream(["hi"]));
    const cbs: StreamCallbacks = { onDelta: () => {} };
    await streamWithFallback([primary], [{ role: "user", content: "x" }], cbs);
    // 不传 options.actorRole → spread 守门（line 301 ...(params.roleKind !== undefined ? { roleKind } : {})）
    // → 入参对象上不该有 roleKind 字段
    const calledArg = vi.mocked(recordUsageEvent).mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect("roleKind" in calledArg).toBe(false);
  });

  it("actorRole=null → recordUsageEvent 入参 roleKind=null（明确归'未分类'组，区别于 undefined）", async () => {
    mocks.streamText.mockReturnValueOnce(makeSuccessStream(["hi"]));
    const cbs: StreamCallbacks = { onDelta: () => {} };
    await streamWithFallback([primary], [{ role: "user", content: "x" }], cbs, {
      actorRole: null,
    });
    expect(vi.mocked(recordUsageEvent)).toHaveBeenCalledTimes(1);
    const calledArg = vi.mocked(recordUsageEvent).mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(calledArg.roleKind).toBeNull();
  });

  it("actorRole='stage' → recordUsageEvent 入参含 roleKind='stage'（ProjectDetailPage stage 路径）", async () => {
    mocks.streamText.mockReturnValueOnce(makeSuccessStream(["hi"]));
    const cbs: StreamCallbacks = { onDelta: () => {} };
    await streamWithFallback([primary], [{ role: "user", content: "x" }], cbs, {
      actorRole: "stage",
    });
    expect(vi.mocked(recordUsageEvent).mock.calls[0]![0]).toMatchObject({ roleKind: "stage" });
  });
});

describe("streamWithFallback - 主模型失败分类", () => {
  it.each<[number, string, boolean]>([
    [401, "auth_invalid", true],
    [403, "auth_forbidden", true],
    [404, "model_not_found", true],
    [429, "rate_limit", true],
    [500, "server_error", true],
    [413, "context_overflow", false],
  ])("HTTP %i → category 切=%s, shouldFallback=%s", async (status, label, shouldSwitch) => {
    mocks.streamText.mockReturnValueOnce(
      makeFailingStream({ statusCode: status, message: `HTTP ${status}` }),
    );
    if (shouldSwitch) {
      mocks.streamText.mockReturnValueOnce(makeSuccessStream(["from fallback"]));
    }

    const switched: Array<{ from: string; to: string; reason: SwitchReason }> = [];
    const deltas: string[] = [];
    const audits: Array<unknown> = [];
    const cbs: StreamCallbacks = {
      onDelta: (d) => deltas.push(d),
      onSwitched: (f, t, r) => switched.push({ from: f.modelId, to: t.modelId, reason: r }),
      onInvocationAudit: (event) => audits.push(event),
    };

    if (shouldSwitch) {
      const result = await streamWithFallback(
        [primary, fallback],
        [{ role: "user", content: "x" }],
        cbs,
      );
      expect(result.switched).toBe(true);
      expect(result.usedModelId).toBe("m-fallback");
      expect(switched).toHaveLength(1);
      expect(switched[0]!.reason).toEqual({ kind: "error", category: label });
      expect(deltas.join("")).toBe("from fallback");
      expect(mocks.streamText).toHaveBeenCalledTimes(2);
      expect(audits.map((event) => (event as { status: string }).status)).toEqual(["error", "success"]);
      expect(audits[0]).toMatchObject({
        modelId: "m-primary",
        providerKind: "api",
        status: "error",
        errorCategory: label,
      });
    } else {
      await expect(
        streamWithFallback([primary, fallback], [{ role: "user", content: "x" }], cbs),
      ).rejects.toBeDefined();
      expect(switched).toEqual([]);
      expect(mocks.streamText).toHaveBeenCalledTimes(1);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        modelId: "m-primary",
        status: "error",
        errorCategory: label,
      });
    }
  });
});

describe("streamWithFallback - 网络/超时错误", () => {
  it.each<[string, Error]>([
    ["timeout", new Error("Request timed out")],
    ["ECONNREFUSED", new Error("connect ECONNREFUSED")],
  ])("%s → 切 fallback", async (_label, err) => {
    mocks.streamText.mockReturnValueOnce(makeFailingStream(err));
    mocks.streamText.mockReturnValueOnce(makeSuccessStream(["ok"]));

    const cbs: StreamCallbacks = { onDelta: () => {} };
    const result = await streamWithFallback(
      [primary, fallback],
      [{ role: "user", content: "x" }],
      cbs,
    );
    expect(result.switched).toBe(true);
    expect(result.usedModelId).toBe("m-fallback");
  });
});

describe("streamWithFallback - partial 文本 + 不同错误分类的 fallback 行为", () => {
  // 1.1 关键场景：主模型流出部分文本后被服务端拒（429/401/5xx），
  // 必须切 fallback 且把 partial 塞回 + onSwitched category 正确分类
  it.each<[number, string]>([
    [429, "rate_limit"],
    [401, "auth_invalid"],
    [500, "server_error"],
  ])(
    "partial 文本 + HTTP %i → 切 fallback + 上下文带 partial + onSwitched(category=%s)",
    async (status, label) => {
      mocks.streamText.mockReturnValueOnce(
        makePartialFailingStream(["主模型已输出片段。"], {
          statusCode: status,
          message: `HTTP ${status}`,
        }),
      );
      mocks.streamText.mockReturnValueOnce(makeSuccessStream(["fallback 续写。"]));

      const deltas: string[] = [];
      const switched: Array<{ from: string; to: string; reason: SwitchReason }> = [];
      const cbs: StreamCallbacks = {
        onDelta: (d) => deltas.push(d),
        onSwitched: (f, t, r) => switched.push({ from: f.modelId, to: t.modelId, reason: r }),
      };

      const result = await streamWithFallback(
        [primary, fallback],
        [{ role: "user", content: "完整任务" }],
        cbs,
      );

      expect(result).toEqual({ usedModelId: "m-fallback", switched: true });
      expect(deltas.join("")).toBe("主模型已输出片段。fallback 续写。");
      expect(switched).toHaveLength(1);
      expect(switched[0]!.reason).toEqual({ kind: "error", category: label });
      const fallbackCall = mocks.streamText.mock.calls[1]![0] as {
        messages: Array<{ role: string; content: string }>;
      };
      expect(fallbackCall.messages.some((m) => m.role === "assistant" && m.content === "主模型已输出片段。")).toBe(true);
      expect(fallbackCall.messages.at(-1)?.content).toContain("不要重复已经完成的内容");
    },
  );

  it("链上所有模型 partial 后都失败 → 抛错且 partial 不被吞", async () => {
    mocks.streamText
      .mockReturnValueOnce(makePartialFailingStream(["主模型片段。"], { statusCode: 429, message: "HTTP 429" }))
      .mockReturnValueOnce(makePartialFailingStream(["fallback 片段。"], { statusCode: 429, message: "HTTP 429" }));

    await expect(
      streamWithFallback(
        [primary, fallback],
        [{ role: "user", content: "x" }],
        { onDelta: () => {} },
      ),
    ).rejects.toBeDefined();
    expect(mocks.streamText).toHaveBeenCalledTimes(2);
  });
});

describe("streamWithFallback - 非用户中断自动恢复", () => {
  it("finishReason=length 时自动让同一模型从中断处续写，不把截断当完成", async () => {
    mocks.streamText
      .mockReturnValueOnce(makeSuccessStream(["第一段"], { inputTokens: 10, outputTokens: 20 }, "length"))
      .mockReturnValueOnce(makeSuccessStream(["第二段"], { inputTokens: 5, outputTokens: 10 }, "stop"));

    const deltas: string[] = [];
    const usages: Array<{ reason: string; input: number; output: number }> = [];
    const cbs: StreamCallbacks = {
      onDelta: (d) => deltas.push(d),
      onUsage: (u, _m, reason) => usages.push({ reason, input: u.inputTokens, output: u.outputTokens }),
    };

    const result = await streamWithFallback([primary], [{ role: "user", content: "写完整方案" }], cbs);

    expect(result).toEqual({ usedModelId: "m-primary", switched: false });
    expect(deltas.join("")).toBe("第一段第二段");
    expect(mocks.streamText).toHaveBeenCalledTimes(2);
    expect(usages).toEqual([{ reason: "stop", input: 15, output: 30 }]);
    expect(recordUsageEvent).toHaveBeenCalledTimes(1);
    expect(recordUsageEvent).toHaveBeenCalledWith(expect.objectContaining({
      finishReason: "stop",
      usage: expect.objectContaining({ inputTokens: 15, outputTokens: 30 }),
    }));
    const secondCall = mocks.streamText.mock.calls[1]![0] as { messages: Array<{ role: string; content: string }> };
    expect(secondCall.messages.at(-1)?.content).toContain("从刚才中断处继续");
  });

  it("finishReason=tool-calls（撞 stopWhen 步数上限）自动续写，不当异常抛错炸链（修多角色接力硬失败 bug）", async () => {
    mocks.streamText
      .mockReturnValueOnce(makeSuccessStream(["先读了一半文件"], { inputTokens: 10, outputTokens: 20 }, "tool-calls"))
      .mockReturnValueOnce(makeSuccessStream(["读完了，结论是……"], { inputTokens: 5, outputTokens: 10 }, "stop"));

    const deltas: string[] = [];
    const result = await streamWithFallback(
      [primary],
      [{ role: "user", content: "帮我读完整个项目" }],
      { onDelta: (d) => deltas.push(d) },
    );

    expect(result).toEqual({ usedModelId: "m-primary", switched: false });
    expect(deltas.join("")).toBe("先读了一半文件读完了，结论是……");
    expect(mocks.streamText).toHaveBeenCalledTimes(2);
    const secondCall = mocks.streamText.mock.calls[1]![0] as { messages: Array<{ role: string; content: string }> };
    expect(secondCall.messages.at(-1)?.content).toContain("从刚才中断处继续");
  });

  it("finishReason=tool-calls 连续续接超过 MAX_AUTO_CONTINUATIONS(2) 次仍不报错（工具步数截断走总量红线，不占文字截断的续接批次数预算）", async () => {
    // 4 批全是 tool-calls（撞步数上限），第 5 批才 stop——如果误用了文字截断的
    // "续接2次" 上限，第 3 批就会被判定续接耗尽直接抛错；现在应该一路续到收尾。
    mocks.streamText
      .mockReturnValueOnce(makeSuccessStream(["第1批"], { inputTokens: 1, outputTokens: 1 }, "tool-calls"))
      .mockReturnValueOnce(makeSuccessStream(["第2批"], { inputTokens: 1, outputTokens: 1 }, "tool-calls"))
      .mockReturnValueOnce(makeSuccessStream(["第3批"], { inputTokens: 1, outputTokens: 1 }, "tool-calls"))
      .mockReturnValueOnce(makeSuccessStream(["第4批"], { inputTokens: 1, outputTokens: 1 }, "tool-calls"))
      .mockReturnValueOnce(makeSuccessStream(["收尾"], { inputTokens: 1, outputTokens: 1 }, "stop"));

    const deltas: string[] = [];
    const result = await streamWithFallback(
      [primary],
      [{ role: "user", content: "帮我改完整个项目的 30 个文件" }],
      { onDelta: (d) => deltas.push(d) },
    );

    expect(result).toEqual({ usedModelId: "m-primary", switched: false });
    expect(mocks.streamText).toHaveBeenCalledTimes(5);
    expect(deltas.join("")).toBe("第1批第2批第3批第4批收尾");
  });

  it("finishReason=stop 但真实 stepCount 已耗尽 maxToolSteps（假收尾）→ 视同工具步数截断自动续写，不当正常完成（2026-07-13 真实故障：19次工具调用后模型只写一句空话就收尾）", async () => {
    // 第一批：streamText 内部跑满 3 步（maxToolSteps=3），边界第3步模型自己选择不调工具、
    // 只写一句"我先去做，稍后继续"就正常 stop——AI SDK 不会把这种情况报成 finishReason=
    // tool-calls，必须靠真实 stepCount 判定，不能信 finishReason 字符串。
    mocks.streamText
      .mockImplementationOnce((args: { onStepFinish?: (e: { toolCalls: unknown[] }) => void }) => {
        for (let i = 0; i < 3; i++) args.onStepFinish?.({ toolCalls: [] });
        return makeSuccessStream(["我先去做，稍后继续"], { inputTokens: 1, outputTokens: 1 }, "stop");
      })
      .mockReturnValueOnce(makeSuccessStream(["真正写完了结论"], { inputTokens: 1, outputTokens: 1 }, "stop"));

    const deltas: string[] = [];
    const result = await streamWithFallback(
      [primary],
      [{ role: "user", content: "帮我核对一堆文档" }],
      { onDelta: (d) => deltas.push(d) },
      { tools: {} as never, maxToolSteps: 3 },
    );

    expect(result).toEqual({ usedModelId: "m-primary", switched: false });
    expect(mocks.streamText).toHaveBeenCalledTimes(2);
    expect(deltas.join("")).toBe("我先去做，稍后继续真正写完了结论");
    const secondCall = mocks.streamText.mock.calls[1]![0] as { messages: Array<{ role: string; content: string }> };
    expect(secondCall.messages.at(-1)?.content).toContain("从刚才中断处继续");
  });

  it("finishReason=stop 且 stepCount 未耗尽 maxToolSteps → 正常完成，不触发假收尾续接（不误伤真正的短任务）", async () => {
    mocks.streamText.mockImplementationOnce((args: { onStepFinish?: (e: { toolCalls: unknown[] }) => void }) => {
      args.onStepFinish?.({ toolCalls: [] }); // 只跑 1 步，远没到 maxToolSteps=20
      return makeSuccessStream(["答案是 42"], { inputTokens: 1, outputTokens: 1 }, "stop");
    });

    const result = await streamWithFallback(
      [primary],
      [{ role: "user", content: "1+41等于几" }],
      { onDelta: () => {} },
      { tools: {} as never },
    );

    expect(result).toEqual({ usedModelId: "m-primary", switched: false });
    expect(mocks.streamText).toHaveBeenCalledTimes(1);
  });

  it("流式输出一半后网络断开时，切 fallback 并带上已输出片段继续", async () => {
    mocks.streamText
      .mockReturnValueOnce(makePartialFailingStream(["已经完成一半。"], new Error("fetch failed")))
      .mockReturnValueOnce(makeSuccessStream(["继续完成剩余。"], { inputTokens: 8, outputTokens: 12 }, "stop"));

    const deltas: string[] = [];
    const switched: Array<{ from: string; to: string }> = [];
    const cbs: StreamCallbacks = {
      onDelta: (d) => deltas.push(d),
      onSwitched: (from, to) => switched.push({ from: from.modelId, to: to.modelId }),
    };

    const result = await streamWithFallback(
      [primary, fallback],
      [{ role: "user", content: "继续做完整任务" }],
      cbs,
    );

    expect(result).toEqual({ usedModelId: "m-fallback", switched: true });
    expect(deltas.join("")).toBe("已经完成一半。继续完成剩余。");
    expect(switched).toEqual([{ from: "m-primary", to: "m-fallback" }]);
    const secondCall = mocks.streamText.mock.calls[1]![0] as { messages: Array<{ role: string; content: string }> };
    expect(secondCall.messages.some((m) => m.role === "assistant" && m.content === "已经完成一半。")).toBe(true);
    expect(secondCall.messages.at(-1)?.content).toContain("不要重复已经完成的内容");
    expect(recordUsageEvent).toHaveBeenCalledWith(expect.objectContaining({
      modelId: "m-primary",
      finishReason: "network",
    }));
    expect(recordUsageEvent).toHaveBeenCalledWith(expect.objectContaining({
      modelId: "m-fallback",
      finishReason: "stop",
    }));
  });

  it("同一模型连续截断超过续写预算后切 fallback，不能把 length 当正常完成", async () => {
    mocks.streamText
      .mockReturnValueOnce(makeSuccessStream(["A"], { inputTokens: 1, outputTokens: 1 }, "length"))
      .mockReturnValueOnce(makeSuccessStream(["B"], { inputTokens: 1, outputTokens: 1 }, "length"))
      .mockReturnValueOnce(makeSuccessStream(["C"], { inputTokens: 1, outputTokens: 1 }, "length"))
      .mockReturnValueOnce(makeSuccessStream(["D"], { inputTokens: 1, outputTokens: 1 }, "stop"));

    const deltas: string[] = [];
    const result = await streamWithFallback(
      [primary, fallback],
      [{ role: "user", content: "写到完整结束" }],
      { onDelta: (d) => deltas.push(d) },
    );

    expect(result).toEqual({ usedModelId: "m-fallback", switched: true });
    expect(deltas.join("")).toBe("ABCD");
    expect(recordUsageEvent).toHaveBeenCalledWith(expect.objectContaining({
      modelId: "m-fallback",
      finishReason: "stop",
    }));
  });

  it("finishReason=end_turn 视为正常完成，兼容 Claude/Codex CLI stop_reason", async () => {
    mocks.streamText.mockReturnValueOnce(makeSuccessStream(["ok"], { inputTokens: 2, outputTokens: 3 }, "end_turn"));

    const result = await streamWithFallback(
      [primary, fallback],
      [{ role: "user", content: "x" }],
      { onDelta: () => {} },
    );

    expect(result).toEqual({ usedModelId: "m-primary", switched: false });
    expect(mocks.streamText).toHaveBeenCalledTimes(1);
    expect(recordUsageEvent).toHaveBeenCalledWith(expect.objectContaining({
      finishReason: "end_turn",
    }));
  });

  it("finishReason=content_filter 这类非正常结束不能当成功，会切 fallback 继续", async () => {
    mocks.streamText
      .mockReturnValueOnce(makeSuccessStream(["半截"], { inputTokens: 1, outputTokens: 1 }, "content_filter"))
      .mockReturnValueOnce(makeSuccessStream(["恢复"], { inputTokens: 1, outputTokens: 1 }, "stop"));

    const deltas: string[] = [];
    const result = await streamWithFallback(
      [primary, fallback],
      [{ role: "user", content: "x" }],
      { onDelta: (d) => deltas.push(d) },
    );

    expect(result).toEqual({ usedModelId: "m-fallback", switched: true });
    expect(deltas.join("")).toBe("半截恢复");
    expect(recordUsageEvent).toHaveBeenCalledWith(expect.objectContaining({
      modelId: "m-primary",
      finishReason: "content_filter",
    }));
    expect(recordUsageEvent).toHaveBeenCalledWith(expect.objectContaining({
      modelId: "m-fallback",
      finishReason: "stop",
    }));
  });
});

describe("streamWithFallback - fullStream 分轨 reasoning/text（C 档第2步，2026-07-12）", () => {
  // 关键发现：AI SDK 的 textStream getter 只过滤 text-delta，reasoning-delta 会被
  // 直接丢弃（见 chat-fallback-attempt.ts 里的源码引用）——对走结构化 reasoning
  // 通道的 provider（DeepSeek 等），旧代码根本不会把思考内容纳入 partialText，
  // 既不显示也不参与完整性判定。这组测试证明 fullStream 改造后思考内容被正确
  // 包装成 <think> 标签、完整流入 onDelta 和最终落库内容。
  it("reasoning-delta 被包装成 <think> 标签，与 text-delta 正确拼接", async () => {
    mocks.streamText.mockReturnValueOnce(
      makeReasoningStream(["先想一下，", "今天是星期几"], ["星期日，2026 年 7 月 12 日。"]),
    );

    const deltas: string[] = [];
    const cbs: StreamCallbacks = { onDelta: (d) => deltas.push(d) };

    const result = await streamWithFallback([primary], [{ role: "user", content: "今天星期几" }], cbs);

    expect(result).toEqual({ usedModelId: "m-primary", switched: false });
    const full = deltas.join("");
    expect(full).toBe("<think>先想一下，今天是星期几</think>星期日，2026 年 7 月 12 日。");
  });

  it("只有 reasoning-delta 没有 text-delta（纯思考无正文）→ 当截断自动续写", async () => {
    // 对齐第1步的完整性判定：reasoning 永远不算"可见正文"，哪怕它被完整包好 <think> 标签。
    mocks.streamText
      .mockReturnValueOnce(makeReasoningStream(["想了很久但没有结论"], []))
      .mockReturnValueOnce(makeSuccessStream(["这是真正的正文"]));

    const result = await streamWithFallback([primary], [{ role: "user", content: "x" }], { onDelta: () => {} });

    expect(result).toEqual({ usedModelId: "m-primary", switched: false });
    expect(mocks.streamText).toHaveBeenCalledTimes(2);
  });
});

describe("streamWithFallback - 内容完整性校验（C 档第1/3步，2026-07-12）", () => {
  // 用户实测复现：MiniMax-M3 finishReason=stop，但内容卡在未闭合的 <think> 块里，
  // 没有任何可见正文。旧逻辑只信 finishReason=stop → 直接当成功落库，界面冻结在
  // "进行中"、无提示。新逻辑：finishReason 正常但可见正文为空 → 当截断处理，自动续跑。
  it("finishReason=stop 但只有未闭合的 <think>（无正文）→ 当截断自动续写，不当成功", async () => {
    mocks.streamText
      .mockReturnValueOnce(
        makeSuccessStream(
          ["<think>用户问今天星期几，我需要想一下"],
          { inputTokens: 10, outputTokens: 20 },
          "stop",
        ),
      )
      .mockReturnValueOnce(
        makeSuccessStream(["</think>星期日，2026 年 7 月 12 日。"], { inputTokens: 5, outputTokens: 10 }, "stop"),
      );

    const deltas: string[] = [];
    const recovered: Array<{ mode: string }> = [];
    const cbs: StreamCallbacks = {
      onDelta: (d) => deltas.push(d),
      onRecovered: (mode) => recovered.push({ mode }),
    };

    const result = await streamWithFallback([primary], [{ role: "user", content: "今天星期几" }], cbs);

    expect(result).toEqual({ usedModelId: "m-primary", switched: false });
    expect(mocks.streamText).toHaveBeenCalledTimes(2);
    expect(recovered).toEqual([{ mode: "context_replay" }]);
    // 最终 usage 落库时用的是"最后一次真正成功"的 finishReason，不是 empty_response
    expect(recordUsageEvent).toHaveBeenCalledTimes(1);
    expect(recordUsageEvent).toHaveBeenCalledWith(
      expect.objectContaining({ finishReason: "stop" }),
    );
    const secondCall = mocks.streamText.mock.calls[1]![0] as { messages: Array<{ role: string; content: string }> };
    expect(secondCall.messages.at(-1)?.content).toContain("从刚才中断处继续");
  });

  it("finishReason=stop 且正文完全为空 → 当截断自动续写", async () => {
    mocks.streamText
      .mockReturnValueOnce(makeSuccessStream([""], { inputTokens: 10, outputTokens: 0 }, "stop"))
      .mockReturnValueOnce(makeSuccessStream(["实际的回答内容"], { inputTokens: 5, outputTokens: 10 }, "stop"));

    const deltas: string[] = [];
    const result = await streamWithFallback(
      [primary],
      [{ role: "user", content: "x" }],
      { onDelta: (d) => deltas.push(d) },
    );

    expect(result).toEqual({ usedModelId: "m-primary", switched: false });
    expect(mocks.streamText).toHaveBeenCalledTimes(2);
    expect(deltas.join("")).toBe("实际的回答内容");
  });

  it("连续多次空内容超过续写预算后切 fallback，不会无限重试同一模型", async () => {
    mocks.streamText
      .mockReturnValueOnce(makeSuccessStream(["<think>想"], { inputTokens: 1, outputTokens: 1 }, "stop"))
      .mockReturnValueOnce(makeSuccessStream(["<think>又想"], { inputTokens: 1, outputTokens: 1 }, "stop"))
      .mockReturnValueOnce(makeSuccessStream(["<think>还在想"], { inputTokens: 1, outputTokens: 1 }, "stop"))
      .mockReturnValueOnce(makeSuccessStream(["fallback 给出了正文"], { inputTokens: 1, outputTokens: 1 }, "stop"));

    const result = await streamWithFallback(
      [primary, fallback],
      [{ role: "user", content: "x" }],
      { onDelta: () => {} },
    );

    expect(result).toEqual({ usedModelId: "m-fallback", switched: true });
    // primary 最多重试 MAX_AUTO_CONTINUATIONS(2) 次后放弃切 fallback：共 3 次 primary + 1 次 fallback
    expect(mocks.streamText).toHaveBeenCalledTimes(4);
    expect(recordUsageEvent).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: "m-primary", finishReason: "empty_response" }),
    );
  });

  it("正文非空即使很短也不触发截断逻辑（不误伤正常简短回答）", async () => {
    mocks.streamText.mockReturnValueOnce(makeSuccessStream(["好的"], { inputTokens: 5, outputTokens: 2 }, "stop"));

    const result = await streamWithFallback([primary], [{ role: "user", content: "x" }], { onDelta: () => {} });

    expect(result).toEqual({ usedModelId: "m-primary", switched: false });
    expect(mocks.streamText).toHaveBeenCalledTimes(1);
  });
});

describe("streamWithFallback - 无 fallback", () => {
  it("主模型失败直接抛错（没有 fallback）", async () => {
    mocks.streamText.mockReturnValueOnce(
      makeFailingStream({ statusCode: 401, message: "bad key" }),
    );
    const cbs: StreamCallbacks = { onDelta: () => {} };
    await expect(
      streamWithFallback([primary], [{ role: "user", content: "x" }], cbs),
    ).rejects.toBeDefined();
    expect(mocks.streamText).toHaveBeenCalledTimes(1);
  });

  it("无 fallback 时 cooldown 跳过会抛错", async () => {
    markModelFailed(primary.modelId);
    const cbs: StreamCallbacks = { onDelta: () => {} };
    await expect(
      streamWithFallback([primary], [{ role: "user", content: "x" }], cbs),
    ).rejects.toThrow(/cooling|unavailable|fallback/i);
  });
});

describe("streamWithFallback - cooldown 行为", () => {
  it("主模型在 cooldown → 直接用 fallback + 触发 onSwitched(kind=cooldown)", async () => {
    markModelFailed(primary.modelId);
    mocks.streamText.mockReturnValueOnce(makeSuccessStream(["from fallback"]));

    const switched: Array<{ from: string; to: string; reason: SwitchReason }> = [];
    const cbs: StreamCallbacks = {
      onDelta: () => {},
      onSwitched: (f, t, r) => switched.push({ from: f.modelId, to: t.modelId, reason: r }),
    };

    const result = await streamWithFallback(
      [primary, fallback],
      [{ role: "user", content: "x" }],
      cbs,
    );
    expect(result.switched).toBe(true);
    expect(result.usedModelId).toBe("m-fallback");
    expect(switched).toHaveLength(1);
    expect(switched[0]!.reason).toEqual({ kind: "cooldown" }); // ⚠️ 不再假报 rate_limit
  });

  it("主模型成功后清空 cooldown", async () => {
    mocks.streamText.mockReturnValueOnce(makeSuccessStream(["ok"]));
    const cbs: StreamCallbacks = { onDelta: () => {} };
    await streamWithFallback([primary], [{ role: "user", content: "x" }], cbs);
    expect(isInCooldown(primary.modelId)).toBe(false);
  });

  it("主模型失败 → markModelFailed 把它丢进 cooldown", async () => {
    mocks.streamText.mockReturnValueOnce(
      makeFailingStream({ statusCode: 500, message: "fail" }),
    );
    mocks.streamText.mockReturnValueOnce(makeSuccessStream(["ok"]));
    const cbs: StreamCallbacks = { onDelta: () => {} };
    await streamWithFallback([primary, fallback], [{ role: "user", content: "x" }], cbs);
    expect(isInCooldown(primary.modelId)).toBe(true);
  });

  // 真实事故（2026-07-05）：链上所有模型都在冷却中时，之前抛的是一句生硬英文
  // "All models are cooling down — please try again later"，用户不知道具体哪个模型、
  // 还要等多久。现在报错里要带上每个模型的显示名 + 剩余时间，交给 error-classifier.ts 翻译。
  it("链上所有模型都在冷却中 → 抛错带上每个模型的名字和剩余时间", async () => {
    markModelFailed(primary.modelId);
    markModelFailed(fallback.modelId);
    const cbs: StreamCallbacks = { onDelta: () => {} };

    await expect(streamWithFallback([primary, fallback], [{ role: "user", content: "x" }], cbs)).rejects.toThrow(
      /All models are cooling down: Primary（还需 \d+(?: 分 \d+ 秒| 分钟| 秒)）、Fallback（还需 \d+(?: 分 \d+ 秒| 分钟| 秒)）/,
    );
  });
});

describe("streamWithFallback - D4 额度熔断", () => {
  const quotaGuard = (ids: string[]) => ({
    getExhaustedModelIds: () => new Set(ids),
  });

  it("主模型额度耗尽 → 直接跳到 fallback + 触发 onSwitched(kind=quota)", async () => {
    mocks.streamText.mockReturnValueOnce(makeSuccessStream(["from fallback"]));

    const switched: Array<{ from: string; to: string; reason: SwitchReason }> = [];
    const audits: Array<{ status: string; modelId: string }> = [];
    const cbs: StreamCallbacks = {
      onDelta: () => {},
      onSwitched: (f, t, r) => switched.push({ from: f.modelId, to: t.modelId, reason: r }),
      onInvocationAudit: (event) => audits.push({ status: event.status, modelId: event.modelId }),
    };

    const result = await streamWithFallback(
      [primary, fallback],
      [{ role: "user", content: "x" }],
      cbs,
      { quotaGuard: quotaGuard(["m-primary"]) },
    );
    expect(result.switched).toBe(true);
    expect(result.usedModelId).toBe("m-fallback");
    expect(switched).toHaveLength(1);
    expect(switched[0]!.reason).toEqual({ kind: "quota" });
    expect(audits.some((a) => a.status === "quota_exhausted" && a.modelId === "m-primary")).toBe(true);
  });

  it("所有模型额度都耗尽 → 抛错（与 cooldown 分开），不调用任何模型", async () => {
    const cbs: StreamCallbacks = { onDelta: () => {} };
    await expect(
      streamWithFallback(
        [primary, fallback],
        [{ role: "user", content: "x" }],
        cbs,
        { quotaGuard: quotaGuard(["m-primary", "m-fallback"]) },
      ),
    ).rejects.toThrow(/All models exhausted quota: Primary、Fallback/);
    expect(mocks.streamText).not.toHaveBeenCalled();
  });

  it("额度守卫缺失 → 不熔断，主模型正常跑（保持原有行为，CLI 等路径安全）", async () => {
    mocks.streamText.mockReturnValueOnce(makeSuccessStream(["ok"]));
    const cbs: StreamCallbacks = { onDelta: () => {} };
    const result = await streamWithFallback(
      [primary, fallback],
      [{ role: "user", content: "x" }],
      cbs,
    );
    expect(result).toEqual({ usedModelId: "m-primary", switched: false });
    expect(mocks.streamText).toHaveBeenCalledTimes(1);
  });

  it("额度耗尽但后备也失败 → 切到后备时不再被额度拦截、正常走 fallback 错误分类", async () => {
    mocks.streamText.mockReturnValueOnce(makeSuccessStream(["from fallback"]));
    const cbs: StreamCallbacks = { onDelta: () => {} };
    const result = await streamWithFallback(
      [primary, fallback],
      [{ role: "user", content: "x" }],
      cbs,
      { quotaGuard: quotaGuard(["m-primary"]) },
    );
    expect(result.usedModelId).toBe("m-fallback");
  });

  // 2026-07-15 review 回归测试：cooldown 和 quota 交错时，之前的实现分两个独立循环——
  // quota 循环把 startIdx 推到的模型从未做过 cooldown 检查，会选中一个实际在 cooldown
  // 的模型去真实请求。见 chat-fallback.ts 里 D4 skip 循环的合并注释。
  it("cooldown 与 quota 交错 → 第三个模型仍需过 cooldown 检查，不能被跳过检测漏掉", async () => {
    const third: ModelEndpoint = {
      modelId: "m-third",
      modelName: "third-model",
      providerType: "openai",
      providerId: "prov-third",
      apiCredentialId: "cred-third",
      apiKey: "sk-test-third",
      baseUrl: "https://api.third.example",
      displayLabel: "Third",
    };
    // primary 在 cooldown，fallback 额度耗尽（不在 cooldown），third 也在 cooldown（不在额度耗尽集合）。
    markModelFailed(primary.modelId);
    markModelFailed(third.modelId);
    expect(isInCooldown(primary.modelId)).toBe(true);
    expect(isInCooldown(third.modelId)).toBe(true);

    const cbs: StreamCallbacks = { onDelta: () => {} };
    await expect(
      streamWithFallback(
        [primary, fallback, third],
        [{ role: "user", content: "x" }],
        cbs,
        { quotaGuard: quotaGuard(["m-fallback"]) },
      ),
    ).rejects.toThrow(/All models are cooling down/);
    // 三个模型全部被正确判定为不可用（cooldown 或 quota），没有一个真的发起请求——
    // 之前的 bug 会让 third 绕过 cooldown 检查被直接调用。
    expect(mocks.streamText).not.toHaveBeenCalled();
  });

  // 2026-07-16 review 修复回归测试：上面那条测试只断言了错误前缀，没检查 detail 里
  // 每个模型的具体文案——之前不管是 cooldown 还是 quota_exhausted，detail 里统一走
  // formatCooldownRemainingMs(getCooldownRemainingMs(...))，quota 耗尽的模型不在
  // cooldown 状态表里、remainingMs 恒为 0，Math.max(1,...) 保底成"还需 1 秒"，
  // 误导用户以为等 1 秒就行——实际是套餐用完，永远不会自己恢复。这里精确断言：
  // 真冷却的模型带"还需 N"，quota 耗尽的模型改标"套餐额度已用尽，等待无效"，不再
  // 出现假的"还需 1 秒"。
  it("cooldown 与 quota 交错 → quota 耗尽的模型不再显示假的'还需 1 秒'", async () => {
    markModelFailed(primary.modelId);
    const cbs: StreamCallbacks = { onDelta: () => {} };

    await expect(
      streamWithFallback(
        [primary, fallback],
        [{ role: "user", content: "x" }],
        cbs,
        { quotaGuard: quotaGuard(["m-fallback"]) },
      ),
    ).rejects.toThrow(
      /All models are cooling down: Primary（还需 \d+(?: 分 \d+ 秒| 分钟| 秒)）、Fallback（套餐额度已用尽，等待无效）/,
    );
  });
});

describe("streamWithFallback - abort 处理", () => {
  it("主动 abort 不算失败、不切 fallback、不写 UsageEvent", async () => {
    const abortError = Object.assign(new Error("aborted"), { name: "AbortError" });
    mocks.streamText.mockReturnValueOnce(makeFailingStream(abortError));

    const switched: string[] = [];
    const cbs: StreamCallbacks = {
      onDelta: () => {},
      onSwitched: (f, t) => switched.push(`${f.modelId}→${t.modelId}`),
    };

    const controller = new AbortController();
    controller.abort();
    const result = await streamWithFallback(
      [primary, fallback],
      [{ role: "user", content: "x" }],
      cbs,
      { signal: controller.signal },
    );
    expect(result.switched).toBe(false);
    expect(switched).toEqual([]);
    expect(recordUsageEvent).not.toHaveBeenCalled();
  });
});

describe("streamWithFallback - 内置 recordUsageEvent（修 ChatPage 写错 modelName 的 bug）", () => {
  it("主模型成功时调 recordUsageEvent 用主模型的 modelName/providerId/apiCredentialId", async () => {
    mocks.streamText.mockReturnValueOnce(makeSuccessStream(["ok"]));
    const cbs: StreamCallbacks = { onDelta: () => {} };
    await streamWithFallback(
      [primary, fallback],
      [{ role: "user", content: "x" }],
      cbs,
      { projectId: "p-1" },
    );
    expect(recordUsageEvent).toHaveBeenCalledTimes(1);
    expect(recordUsageEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: "m-primary",
        modelName: "primary-model",
        providerId: "prov-anthropic",
        apiCredentialId: "cred-anthropic",
        projectId: "p-1",
        finishReason: "stop",
        interrupted: false,
      }),
    );
  });

  it("切到 fallback 时 recordUsageEvent 改用 fallback 的 modelName/providerId/apiCredentialId（修 latent bug）", async () => {
    mocks.streamText.mockReturnValueOnce(
      makeFailingStream({ statusCode: 401, message: "bad key" }),
    );
    mocks.streamText.mockReturnValueOnce(makeSuccessStream(["ok"]));
    const cbs: StreamCallbacks = { onDelta: () => {} };
    await streamWithFallback(
      [primary, fallback],
      [{ role: "user", content: "x" }],
      cbs,
    );
    expect(recordUsageEvent).toHaveBeenCalledTimes(2);
    expect(recordUsageEvent).toHaveBeenNthCalledWith(1,
      expect.objectContaining({
        modelId: "m-primary",
        finishReason: "auth_invalid",
      }),
    );
    expect(recordUsageEvent).toHaveBeenNthCalledWith(2,
      expect.objectContaining({
        modelId: "m-fallback", // ✅ 不再误报为 m-primary
        modelName: "fallback-model", // ✅ 不再误报为 primary-model
        providerId: "prov-openai", // ✅ 不再误报为 prov-anthropic
        apiCredentialId: "cred-openai", // ✅ 不再误报为 cred-anthropic
      }),
    );
  });

  it("不传 projectId 时不写 projectId 字段", async () => {
    mocks.streamText.mockReturnValueOnce(makeSuccessStream(["ok"]));
    const cbs: StreamCallbacks = { onDelta: () => {} };
    await streamWithFallback([primary], [{ role: "user", content: "x" }], cbs);
    const call = vi.mocked(recordUsageEvent).mock.calls[0]?.[0];
    expect(call).toBeDefined();
    expect(call).not.toHaveProperty("projectId");
  });
});

describe("streamWithFallback - toolChoice（harness nudge 逼真调用工具）", () => {
  it("传了 tools 但不传 toolChoice → 默认 auto", async () => {
    mocks.streamText.mockReturnValueOnce(makeSuccessStream(["ok"]));
    const cbs: StreamCallbacks = { onDelta: () => {} };
    await streamWithFallback([primary], [{ role: "user", content: "x" }], cbs, {
      tools: {} as never,
    });
    expect(mocks.streamText.mock.calls[0]![0]).toMatchObject({ toolChoice: "auto" });
  });

  it("nudge 重答时传 toolChoice:'required' → 原样透传给 streamText（不是文字提醒，是 API 层锁死）", async () => {
    mocks.streamText.mockReturnValueOnce(makeSuccessStream(["ok"]));
    const cbs: StreamCallbacks = { onDelta: () => {} };
    await streamWithFallback([primary], [{ role: "user", content: "x" }], cbs, {
      tools: {} as never,
      toolChoice: "required",
    });
    expect(mocks.streamText.mock.calls[0]![0]).toMatchObject({ toolChoice: "required" });
  });

  it("不传 tools 时不传 toolChoice 给 streamText（没工具的场景不该出现这个字段）", async () => {
    mocks.streamText.mockReturnValueOnce(makeSuccessStream(["ok"]));
    const cbs: StreamCallbacks = { onDelta: () => {} };
    await streamWithFallback([primary], [{ role: "user", content: "x" }], cbs);
    expect(mocks.streamText.mock.calls[0]![0]).not.toHaveProperty("toolChoice");
  });
});

describe("toModelEndpoint builder", () => {
  it("从 DB 形态构造端点（含 providerType 校验）", () => {
    const ep = toModelEndpoint(
      {
        id: "m-1",
        name: "claude-opus-4-8",
        displayName: "Opus 4.8",
        providerId: "prov-anthropic",
        provider: { type: "anthropic" },
      },
      { id: "cred-1", baseUrl: "https://api.example.com" },
      "sk-test",
    );
    expect(ep).toEqual({
      modelId: "m-1",
      modelName: "claude-opus-4-8",
      providerType: "anthropic",
      providerId: "prov-anthropic",
      apiCredentialId: "cred-1",
      apiKey: "sk-test",
      baseUrl: "https://api.example.com",
      displayLabel: "Opus 4.8",
    });
  });

  it("displayName 为 null 时用 model.name 兜底", () => {
    const ep = toModelEndpoint(
      {
        id: "m-1",
        name: "claude-opus-4-8",
        displayName: null,
        providerId: "p",
        provider: { type: "anthropic" },
      },
      { id: "c", baseUrl: "" },
      "k",
    );
    expect(ep.displayLabel).toBe("claude-opus-4-8");
  });

  it("provider 缺失或 type 为空 → 抛错", () => {
    expect(() =>
      toModelEndpoint(
        { id: "m", name: "x", displayName: null, providerId: "p", provider: null },
        { id: "c", baseUrl: "" },
        "k",
      ),
    ).toThrow(/provider type|re-add/i);
    expect(() =>
      toModelEndpoint(
        { id: "m", name: "x", displayName: null, providerId: "p", provider: { type: "" } },
        { id: "c", baseUrl: "" },
        "k",
      ),
    ).toThrow(/provider type|re-add/i);
  });
});
