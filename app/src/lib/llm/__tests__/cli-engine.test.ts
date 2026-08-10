// cli-engine 单测 — 覆盖 spawn 流式 + abort 真杀子进程
//
// 关键覆盖点（v0.9 改进-3）：
//   1. abort signal 触发 → invoke("kill_cli") 真被调到（否则子进程仍在后台跑）
//   2. 自然 terminated（code=0）→ resolve stop
//   3. terminated 非零 + stderr → reject 带 stderr 内容
//   4. error event → reject 错误消息
//   5. spawn 失败 → reject
//   6. stdout 流式解析 → onDelta / onUsage / onRateLimit 三种回调都被调

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock Tauri core：记下所有 invoke 调用，并提供可手动推事件的 Channel。
type ChannelHandler = (ev: unknown) => void;

class FakeChannel<T> {
  onmessage: ChannelHandler | null = null;
  send(ev: T): void {
    this.onmessage?.(ev);
  }
}

type InvokeFn = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
const invokeMock = vi.fn<InvokeFn>(async () => undefined);

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...(args as Parameters<InvokeFn>)),
  Channel: FakeChannel,
}));

// import 必须在 mock 之后
const { streamViaCli } = await import("../cli-engine");
const { CLI_DEFAULT_PROGRAM } = await import("../cli-protocol");

beforeEach(() => {
  invokeMock.mockClear();
  invokeMock.mockResolvedValue(undefined);
  // cli-engine.ts:127 在 kill_cli 抛错时打 console.warn —— 测试 spy 掉避免噪音污染测试输出
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

const messages = [{ role: "user" as const, content: "hi" }];
const endpoint = { providerType: "claude-cli" as const, modelName: "claude-sonnet-4-6" };

/** 拿到 spawn_cli_stream 那次 invoke 调用时构造的 Channel 实例（测试主动推事件用） */
function captureSpawnChannel(): FakeChannel<unknown> {
  const spawnCall = invokeMock.mock.calls.find((c) => c[0] === "spawn_cli_stream");
  if (!spawnCall) throw new Error("spawn_cli_stream 未被 invoke");
  const call = spawnCall[1] as { onEvent?: FakeChannel<unknown> } | undefined;
  if (!call?.onEvent) throw new Error("onEvent channel 未传");
  return call.onEvent;
}

describe("streamViaCli 正常流式", () => {
  it("stdout 解析为 delta → onDelta 被调", async () => {
    const onDelta = vi.fn();
    const p = streamViaCli(endpoint, messages, { onDelta });
    const ch = captureSpawnChannel();

    ch.send({
      type: "stdout",
      line: '{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}',
    });
    ch.send({ type: "terminated", code: 0 });

    const res = await p;
    expect(onDelta).toHaveBeenCalledWith("hello");
    expect(res.finishReason).toBe("stop");
  });

  it("stdout 含 usage → onUsage 被调且最终 usage 正确", async () => {
    const onUsage = vi.fn();
    const p = streamViaCli(endpoint, messages, { onDelta: vi.fn(), onUsage });
    const ch = captureSpawnChannel();

    ch.send({
      type: "stdout",
      line: '{"type":"result","is_error":false,"usage":{"input_tokens":12,"output_tokens":34},"stop_reason":"end_turn"}',
    });
    ch.send({ type: "terminated", code: 0 });

    const res = await p;
    expect(onUsage).toHaveBeenCalled();
    expect(res.inputTokens).toBe(12);
    expect(res.outputTokens).toBe(34);
  });

  it("stdout 含 rate_limit → onRateLimit 被调", async () => {
    const onRateLimit = vi.fn();
    const p = streamViaCli(endpoint, messages, { onDelta: vi.fn(), onRateLimit });
    const ch = captureSpawnChannel();

    ch.send({
      type: "stdout",
      line: '{"type":"rate_limit_event","rate_limit_info":{"resetsAt":1234567890,"rateLimitType":"five_hour"}}',
    });
    ch.send({ type: "terminated", code: 0 });

    await p;
    expect(onRateLimit).toHaveBeenCalledWith({ resetsAt: 1234567890, limitType: "five_hour" });
  });

  it("stdout 含官方 session 事件 → onSession 被调且结果带 officialSessionId", async () => {
    const onSession = vi.fn();
    const onModel = vi.fn();
    const p = streamViaCli(endpoint, messages, { onDelta: vi.fn(), onSession, onModel });
    const ch = captureSpawnChannel();

    ch.send({
      type: "stdout",
      line: '{"type":"system","subtype":"init","session_id":"sess-1","model":"claude-sonnet-4-6"}',
    });
    ch.send({ type: "terminated", code: 0 });

    const res = await p;
    expect(onSession).toHaveBeenCalledWith("sess-1");
    expect(onModel).toHaveBeenCalledWith("claude-sonnet-4-6");
    expect(res.officialSessionId).toBe("sess-1");
    expect(res.actualModelName).toBe("claude-sonnet-4-6");
  });
});

describe("streamViaCli 错误路径", () => {
  it("error event → terminated 后 reject 错误消息", async () => {
    const p = streamViaCli(endpoint, messages, { onDelta: vi.fn() });
    const ch = captureSpawnChannel();

    ch.send({ type: "error", message: "rate limited" });
    ch.send({ type: "terminated", code: 1 });

    await expect(p).rejects.toThrow("rate limited");
  });

  it("terminated 非零退出 + stderr → reject 带 stderr 内容", async () => {
    const p = streamViaCli(endpoint, messages, { onDelta: vi.fn() });
    const ch = captureSpawnChannel();

    ch.send({ type: "stderr", line: "auth failed" });
    ch.send({ type: "terminated", code: 1 });

    await expect(p).rejects.toThrow("auth failed");
  });

  it("spawn 本身失败 → reject", async () => {
    invokeMock.mockImplementationOnce(async (cmd: string) => {
      if (cmd === "spawn_cli_stream") throw new Error("binary not found");
      return undefined;
    });

    await expect(streamViaCli(endpoint, messages, { onDelta: vi.fn() })).rejects.toThrow(
      "binary not found",
    );
  });

  it("CLI 报错时 reject 仍带 officialSessionId，供原生续跑", async () => {
    const p = streamViaCli(endpoint, messages, { onDelta: vi.fn() });
    const ch = captureSpawnChannel();

    ch.send({
      type: "stdout",
      line: '{"type":"system","subtype":"init","session_id":"sess-1"}',
    });
    ch.send({ type: "error", message: "network down" });
    ch.send({ type: "terminated", code: 1 });

    await expect(p).rejects.toMatchObject({ officialSessionId: "sess-1" });
  });

  // ============ 1.4 修复：spawn 失败 / stalled 识别 ============

  it("Rust 发 spawnFailed Error 事件 → reject 带 __cliKind=spawnFailed", async () => {
    const p = streamViaCli(endpoint, messages, { onDelta: vi.fn() });
    const ch = captureSpawnChannel();

    ch.send({
      type: "error",
      message: "No such file or directory (os error 2)",
      kind: "spawnFailed",
    });
    ch.send({ type: "terminated", code: null });

    const err = await p.catch((e: unknown) => e);
    expect((err as { __cliKind?: string }).__cliKind).toBe("spawnFailed");
  });

  it("Rust 发 stalled Error 事件 → reject 带 __cliKind=stalled", async () => {
    const p = streamViaCli(endpoint, messages, { onDelta: vi.fn() });
    const ch = captureSpawnChannel();

    ch.send({
      type: "error",
      message: "CLI 进程超过 60 秒未产生任何事件，已自动终止",
      kind: "stalled",
    });
    ch.send({ type: "terminated", code: null });

    const err = await p.catch((e: unknown) => e);
    expect((err as { __cliKind?: string }).__cliKind).toBe("stalled");
  });

  it("spawn 失败兜底识别：invoke throw 'No such file or directory' → spawnFailed", async () => {
    // Rust 端如果没正确发 Error 事件（极端情况），JS 从原始错误字符串兜底识别
    invokeMock.mockImplementationOnce(async (cmd: string) => {
      if (cmd === "spawn_cli_stream") throw new Error("No such file or directory (os error 2)");
      return undefined;
    });

    const err = await streamViaCli(endpoint, messages, { onDelta: vi.fn() }).catch(
      (e: unknown) => e,
    );
    expect((err as { __cliKind?: string }).__cliKind).toBe("spawnFailed");
  });

  it("spawn 失败兜底识别：invoke throw 'permission denied' → spawnFailed", async () => {
    invokeMock.mockImplementationOnce(async (cmd: string) => {
      if (cmd === "spawn_cli_stream") throw new Error("permission denied");
      return undefined;
    });

    const err = await streamViaCli(endpoint, messages, { onDelta: vi.fn() }).catch(
      (e: unknown) => e,
    );
    expect((err as { __cliKind?: string }).__cliKind).toBe("spawnFailed");
  });

  it("spawn 失败兜底识别：非 spawn 错误（如 'command failed'）→ executionFailed", async () => {
    invokeMock.mockImplementationOnce(async (cmd: string) => {
      if (cmd === "spawn_cli_stream") throw new Error("some other failure");
      return undefined;
    });

    const err = await streamViaCli(endpoint, messages, { onDelta: vi.fn() }).catch(
      (e: unknown) => e,
    );
    expect((err as { __cliKind?: string }).__cliKind).toBe("executionFailed");
  });
});

describe("streamViaCli JS watchdog 双保险（1.3）", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("spawn 后 90s 无任何事件 → reject stalled + 自动 kill_cli", async () => {
    // 不发任何事件，让 watchdog 触发
    const p = streamViaCli(endpoint, messages, { onDelta: vi.fn() });
    await Promise.resolve(); // 让 invoke 落入队列
    captureSpawnChannel(); // 确认 spawn_cli_stream 已发起

    // 推进时间到 90s
    vi.advanceTimersByTime(91_000);

    const err = await p.catch((e: unknown) => e);
    expect((err as { __cliKind?: string }).__cliKind).toBe("stalled");
    // 双重保险：watchdog 触发时也调 kill_cli（Rust 端 60s 没触发时的兜底）
    const killCalls = invokeMock.mock.calls.filter((c) => c[0] === "kill_cli");
    expect(killCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("有事件时 watchdog 重置计时器（手动 verify）", async () => {
    const p = streamViaCli(endpoint, messages, { onDelta: vi.fn() });
    await Promise.resolve();
    const ch = captureSpawnChannel();

    // 推进 80s（还没到 90s 阈值）
    vi.advanceTimersByTime(80_000);
    // 发一个事件，重置 watchdog
    ch.send({
      type: "stdout",
      line: '{"type":"assistant","message":{"content":[{"type":"text","text":"chunk"}]}}',
    });
    await Promise.resolve();
    // 再推进 80s（仍没到 90s，因为重置了）
    vi.advanceTimersByTime(80_000);

    // 还没 settle（说明 watchdog 没误触发）
    // 清理：发 terminated 收尾
    ch.send({ type: "terminated", code: 0 });
    await p;
  });
});

describe("streamViaCli abort 真杀子进程（改进-3 核心）", () => {
  it("abort signal 触发 → invoke('kill_cli') 被调到 + resolve finishReason='abort'", async () => {
    const ac = new AbortController();
    const onDelta = vi.fn();

    const p = streamViaCli(endpoint, messages, { onDelta }, { signal: ac.signal });

    // 等下一拍 microtask 让 invoke("spawn_cli_stream") 落入队列
    await Promise.resolve();
    captureSpawnChannel(); // 确认 spawn_cli_stream 已发起

    // 用户点「停止」→ 触发 abort
    ac.abort();

    const res = await p;
    expect(res.finishReason).toBe("abort");

    // 核心断言：abort 后真的调了 kill_cli（不调的话子进程继续跑、白耗订阅额度）
    const killCalls = invokeMock.mock.calls.filter((c) => c[0] === "kill_cli");
    expect(killCalls).toHaveLength(1);
    const killParams = killCalls[0]?.[1] as { sessionId?: string } | undefined;
    expect(killParams?.sessionId).toBeTruthy();
  });

  it("abort 后即使 kill_cli 抛错也不影响前端收尾", async () => {
    // 模拟进程已自然结束（kill_cli 找不到句柄 → Rust 返回 false，但 invoke 层不应抛）
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "kill_cli") throw new Error("session not found");
      return undefined;
    });

    const ac = new AbortController();
    const p = streamViaCli(endpoint, messages, { onDelta: vi.fn() }, { signal: ac.signal });
    await Promise.resolve();
    ac.abort();

    // 不抛、能 resolve 出来
    const res = await p;
    expect(res.finishReason).toBe("abort");
  });

  it("进程已 terminated 后 abort 不再调 kill_cli（已结束不重复杀）", async () => {
    const ac = new AbortController();
    const p = streamViaCli(endpoint, messages, { onDelta: vi.fn() }, { signal: ac.signal });

    await Promise.resolve();
    const ch = captureSpawnChannel();
    ch.send({ type: "terminated", code: 0 });
    // 让 terminated 事件完整跑完 → settled=true → abort handler 看到 settled 应直接 return
    await Promise.resolve();
    ac.abort();

    await p;

    const killCalls = invokeMock.mock.calls.filter((c) => c[0] === "kill_cli");
    expect(killCalls).toHaveLength(0);
  });

  // 2026-07-15 review 修复回归测试：signal 在调用 streamViaCli 之前就已经 aborted
  // （对应 chat-fallback.ts 续接场景：两次 runModelAttempt 之间用户点了停止）。
  // 旧实现只用 addEventListener("abort", ...)，已经发生过的 abort 事件不会补发，
  // 会导致这次调用完全无视停止请求、真的 spawn 出子进程继续跑。
  it("signal 在调用前就已 aborted → 立即 resolve abort，不 spawn 子进程", async () => {
    const ac = new AbortController();
    ac.abort(); // 调用 streamViaCli 之前就已经 aborted

    const res = await streamViaCli(endpoint, messages, { onDelta: vi.fn() }, { signal: ac.signal });

    expect(res.finishReason).toBe("abort");
    // 核心断言：根本不应该发起 spawn_cli_stream，用户已经要求停止
    const spawnCalls = invokeMock.mock.calls.filter((c) => c[0] === "spawn_cli_stream");
    expect(spawnCalls).toHaveLength(0);
  });

  // 2026-07-16 review 修复回归测试：之前只有 API 直连路径（chat-fallback-attempt.ts）
  // 在结束时对称 removeEventListener，CLI 路径只 addEventListener 从没清理过——同一轮
  // 对话内如果 native resume/harness 重试导致 streamViaCli 被多次调用（共享同一个
  // AbortController），每次调用都会在这个 controller 上永久多挂一个监听器。断言正常
  // 结束（非 abort）后监听器确实被移除，而不是只靠 settled 标志位在内部挡一下。
  it("正常 terminated 结束后应该 removeEventListener，不留下监听器", async () => {
    const ac = new AbortController();
    const removeSpy = vi.spyOn(ac.signal, "removeEventListener");

    const p = streamViaCli(endpoint, messages, { onDelta: vi.fn() }, { signal: ac.signal });
    await Promise.resolve();
    const ch = captureSpawnChannel();
    ch.send({ type: "terminated", code: 0 });
    await p;

    expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("abort 触发后应该 removeEventListener 自己", async () => {
    const ac = new AbortController();
    const removeSpy = vi.spyOn(ac.signal, "removeEventListener");

    const p = streamViaCli(endpoint, messages, { onDelta: vi.fn() }, { signal: ac.signal });
    await Promise.resolve();
    captureSpawnChannel();
    ac.abort();
    await p;

    expect(removeSpy).toHaveBeenCalledWith("abort", expect.any(Function));
  });
});

describe("CLI 程序路径选择", () => {
  it("endpoint.program 为空时回退到 CLI_DEFAULT_PROGRAM", async () => {
    const p = streamViaCli({ ...endpoint }, messages, { onDelta: vi.fn() });
    await Promise.resolve();

    const spawnCall = invokeMock.mock.calls.find((c) => c[0] === "spawn_cli_stream");
    expect(spawnCall).toBeDefined();
    const call = spawnCall?.[1] as { params?: { program?: string } } | undefined;
    expect(call?.params?.program).toBe(CLI_DEFAULT_PROGRAM["claude-cli"]);

    const ch = captureSpawnChannel();
    ch.send({ type: "terminated", code: 0 });
    await p;
  });

  it("endpoint.program 显式提供时被优先采用", async () => {
    const p = streamViaCli(
      { ...endpoint, program: "/opt/homebrew/bin/claude" },
      messages,
      { onDelta: vi.fn() },
    );
    await Promise.resolve();

    const spawnCall = invokeMock.mock.calls.find((c) => c[0] === "spawn_cli_stream");
    const call = spawnCall?.[1] as { params?: { program?: string } } | undefined;
    expect(call?.params?.program).toBe("/opt/homebrew/bin/claude");

    const ch = captureSpawnChannel();
    ch.send({ type: "terminated", code: 0 });
    await p;
  });

  it("endpoint.workingDirectory 会传给 Rust spawn，避免 CLI 读错项目", async () => {
    const p = streamViaCli(
      { ...endpoint, workingDirectory: "/Users/me/project-a" },
      messages,
      { onDelta: vi.fn() },
    );
    await Promise.resolve();

    const spawnCall = invokeMock.mock.calls.find((c) => c[0] === "spawn_cli_stream");
    const call = spawnCall?.[1] as { params?: { workingDirectory?: string | null } } | undefined;
    expect(call?.params?.workingDirectory).toBe("/Users/me/project-a");

    const ch = captureSpawnChannel();
    ch.send({ type: "terminated", code: 0 });
    await p;
  });

  it("endpoint.program = ''（空串）也回退到默认（trim 后空）", async () => {
    const p = streamViaCli(
      { ...endpoint, program: "" },
      messages,
      { onDelta: vi.fn() },
    );
    await Promise.resolve();

    const spawnCall = invokeMock.mock.calls.find((c) => c[0] === "spawn_cli_stream");
    const call = spawnCall?.[1] as { params?: { program?: string } } | undefined;
    expect(call?.params?.program).toBe(CLI_DEFAULT_PROGRAM["claude-cli"]);

    const ch = captureSpawnChannel();
    ch.send({ type: "terminated", code: 0 });
    await p;
  });

  it("resumeSessionId 存在时走官方 resume 参数", async () => {
    const p = streamViaCli(
      endpoint,
      messages,
      { onDelta: vi.fn() },
      { resumeSessionId: "sess-1", resumePrompt: "continue" },
    );
    await Promise.resolve();

    const spawnCall = invokeMock.mock.calls.find((c) => c[0] === "spawn_cli_stream");
    const call = spawnCall?.[1] as { params?: { args?: string[] } } | undefined;
    expect(call?.params?.args).toContain("--resume");
    expect(call?.params?.args).toContain("sess-1");

    const ch = captureSpawnChannel();
    ch.send({ type: "terminated", code: 0 });
    await p;
  });
}); 
