// CLI 引擎 spawn 层（依赖 Tauri，运行时才生效）
//
// 把 cli-protocol（纯逻辑）和 Rust 的 spawn_cli_stream 命令接起来：
//   构造参数 → invoke Rust spawn → Channel 流式收 stdout 行 → 协议层解析 → 回调。
// 与 provider-factory + streamText（API 直连）平行，由 chat-fallback 按 provider 类型分流。

import { Channel, invoke } from "@tauri-apps/api/core";
import {
  buildCliArgs,
  buildCliResumeArgs,
  buildPromptFromMessages,
  parseCliStreamLine,
  CLI_DEFAULT_PROGRAM,
  type CliProviderType,
  type CliMessage,
  type CliAccessOptions,
} from "./cli-protocol";
import { COSMGRID_RULES, buildIdentityLine } from "./prompts/cosmgrid-rules";

const CLI_PROVIDER_DISPLAY_NAME: Record<CliProviderType, string> = {
  "claude-cli": "Claude",
  "codex-cli": "Codex",
};

/** CLI 引擎的系统提示：身份陈述（driver = 实际 spawn 的 CLI + 模型名）+ 核心规则。 */
function buildCliSystemPrompt(providerType: CliProviderType, modelName: string): string {
  const providerLabel = CLI_PROVIDER_DISPLAY_NAME[providerType];
  const driverLabel = modelName.trim() ? `${providerLabel}（${modelName.trim()}）` : providerLabel;
  return `${buildIdentityLine(driverLabel)}\n\n${COSMGRID_RULES}`;
}

/** CLI 错误事件 kind（与 src-tauri/src/lib.rs CliErrorKind 对应） */
type CliErrorKind = "spawnFailed" | "executionFailed" | "stalled";

/** Rust spawn_cli_stream 通过 Channel 推回的原始事件（与 lib.rs 的 CliStreamEvent 对应） */
type RustCliEvent =
  | { type: "stdout"; line: string }
  | { type: "stderr"; line: string }
  | { type: "terminated"; code: number | null }
  | { type: "error"; message: string; kind: CliErrorKind };

export interface CliEndpoint {
  providerType: CliProviderType;
  /** 模型别名/全名（传 --model） */
  modelName: string;
  /** CLI 可执行文件绝对路径；空则回退到 PATH 查找默认名 */
  program?: string;
  /** CLI 子进程工作目录；绑定工作文件夹时必须传，避免读到 Cosmgrid-Agent 自身 */
  workingDirectory?: string | null;
}

export interface CliStreamCallbacks {
  onDelta: (text: string) => void;
  onStatus?: (text: string) => void;
  onUsage?: (usage: { inputTokens: number; outputTokens: number }) => void;
  /** 订阅额度状态（claude 的 rate_limit_event），用于未来接 Token Plan 显示 */
  onRateLimit?: (info: { resetsAt: number | null; limitType: string | null }) => void;
  onSession?: (officialSessionId: string) => void;
  onModel?: (modelName: string) => void;
}

export interface CliStreamResult {
  inputTokens: number;
  outputTokens: number;
  finishReason: string;
  officialSessionId: string | null;
  actualModelName: string | null;
}

/** 给本次 spawn 生成唯一 id，Rust 端据此存 child 句柄、abort 时按 id kill。 */
function newCliSessionId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `cli-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * spawn 本机 CLI 流式对话。成功 resolve usage；CLI 报错（未登录 / 额度耗尽 / 非零退出）reject。
 * abort：前端停止接收并 resolve（finishReason="abort"），同时 invoke kill_cli 真正 SIGKILL
 *   子进程——否则 CLI 仍在后台跑完，白耗订阅额度。
 */
export async function streamViaCli(
  endpoint: CliEndpoint,
  messages: readonly CliMessage[],
  callbacks: CliStreamCallbacks,
  options: {
    signal?: AbortSignal;
    resumeSessionId?: string | null;
    resumePrompt?: string;
    /** 权限档位 + 放行目录：翻译成 CLI 各自的 --sandbox/--permission-mode/--add-dir（见 cli-protocol）。 */
    access?: CliAccessOptions;
  } = {},
): Promise<CliStreamResult> {
  const program = endpoint.program?.trim() || CLI_DEFAULT_PROGRAM[endpoint.providerType];
  const prompt = buildPromptFromMessages(messages);
  const systemPrompt = buildCliSystemPrompt(endpoint.providerType, endpoint.modelName);
  const args = options.resumeSessionId
    ? buildCliResumeArgs(
        endpoint.providerType,
        endpoint.modelName,
        options.resumeSessionId,
        options.resumePrompt ?? prompt,
        systemPrompt,
        options.access,
      )
    : buildCliArgs(endpoint.providerType, endpoint.modelName, prompt, systemPrompt, options.access);
  const sessionId = newCliSessionId();

  let usage = { inputTokens: 0, outputTokens: 0 };
  let finishReason = "stop";
  let errorMsg: string | null = null;
  let errorKind: CliErrorKind | null = null;
  let stderrBuf = "";
  let officialSessionId: string | null = options.resumeSessionId ?? null;
  let actualModelName: string | null = null;

  return new Promise<CliStreamResult>((resolve, reject) => {
    let settled = false;

    // 1.3 修复：JS 侧 watchdog（Rust 侧 60s 是主防线，这是双保险 + 兜底）
    // 比 Rust 略长（90s），给 Rust 一点缓冲避免误判；任一事件都重置计时器
    const JS_STALL_TIMEOUT_MS = 90_000;
    let stallTimer: ReturnType<typeof setTimeout> | null = null;
    const armWatchdog = (): void => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        options.signal?.removeEventListener("abort", handleAbort);
        void invoke("kill_cli", { sessionId }).catch(() => {});
        const err = new Error(
          `CLI 进程 ${JS_STALL_TIMEOUT_MS / 1000} 秒内未产生任何事件`,
        ) as Error & { __cliKind?: CliErrorKind; officialSessionId?: string | null };
        err.__cliKind = "stalled";
        err.officialSessionId = officialSessionId;
        reject(err);
      }, JS_STALL_TIMEOUT_MS);
    };
    const disarmWatchdog = (): void => {
      if (stallTimer) {
        clearTimeout(stallTimer);
        stallTimer = null;
      }
    };
    armWatchdog();

    const settle = () => {
      if (settled) return;
      settled = true;
      disarmWatchdog();
      options.signal?.removeEventListener("abort", handleAbort);
      if (errorMsg) {
        const err = new Error(errorMsg) as Error & {
          __cliKind?: CliErrorKind;
          officialSessionId?: string | null;
        };
        if (errorKind) err.__cliKind = errorKind;
        err.officialSessionId = officialSessionId;
        reject(err);
      } else resolve({ ...usage, finishReason, officialSessionId, actualModelName });
    };

    const channel = new Channel<RustCliEvent>();
    channel.onmessage = (ev) => {
      if (settled) return;
      // 任何事件都重置 watchdog
      armWatchdog();
      switch (ev.type) {
        case "stdout": {
          // 一次回调可能含多行（Rust 按行 trim 但保险再按 \n 拆）
          for (const line of ev.line.split("\n")) {
            for (const e of parseCliStreamLine(endpoint.providerType, line)) {
              if (e.kind === "delta") callbacks.onDelta(e.text);
              else if (e.kind === "status") callbacks.onStatus?.(e.text);
              else if (e.kind === "usage") {
                usage = { inputTokens: e.inputTokens, outputTokens: e.outputTokens };
                callbacks.onUsage?.(usage);
              } else if (e.kind === "session") {
                officialSessionId = e.sessionId;
                callbacks.onSession?.(e.sessionId);
              } else if (e.kind === "model") {
                actualModelName = e.modelName;
                callbacks.onModel?.(e.modelName);
              } else if (e.kind === "rate_limit") {
                callbacks.onRateLimit?.({ resetsAt: e.resetsAt, limitType: e.limitType });
              } else if (e.kind === "error") {
                errorMsg = e.message;
              } else if (e.kind === "done") {
                finishReason = e.finishReason;
              }
            }
          }
          break;
        }
        case "stderr":
          stderrBuf += `${ev.line}\n`;
          break;
        case "error":
          // 1.4 修复：从 Rust 端接收 kind，spawn_failed 时给用户友好文案
          errorMsg = ev.message;
          errorKind = ev.kind;
          break;
        case "terminated":
          if (!errorMsg && ev.code !== 0 && ev.code !== null) {
            errorMsg = stderrBuf.trim() || `CLI exited with code ${ev.code}`;
            errorKind = "executionFailed";
          }
          settle();
          break;
      }
    };

    // abort：前端立即收尾恢复 UI，并请 Rust 真正杀掉子进程（停止白耗额度）。
    // kill_cli 失败不影响前端收尾——进程可能已自然结束，只记日志不阻塞。
    const handleAbort = (): void => {
      if (settled) return;
      settled = true;
      disarmWatchdog();
      options.signal?.removeEventListener("abort", handleAbort);
      void invoke("kill_cli", { sessionId }).catch((err: unknown) => {
        console.warn("kill_cli 失败（子进程可能已结束）：", err);
      });
      resolve({ ...usage, finishReason: "abort", officialSessionId, actualModelName });
    };
    // 2026-07-15 review 修复：先查一次 signal 是否已经 aborted，再决定是直接处理还是挂监听——
    // AbortSignal 的 'abort' 事件只在真正 abort 的那一刻广播一次，如果 signal 在这次 attempt
    // 开始之前（比如续接批次之间的间隙）就已经被点了停止，只用 addEventListener 会永远收不到
    // 那个已经错过的事件，导致这次调用完全无视用户的停止操作，一路跑到自然结束（CLI 路径下
    // 子进程真的会被 spawn 出来继续吃订阅额度）。已经 aborted 就直接处理，不再往下 spawn。
    if (options.signal?.aborted) {
      handleAbort();
      return;
    }
    // 2026-07-16 review 修复：这里之前只做了上面那个"提前 aborted 就同步兜底"的修复，
    // 没有对称加 removeEventListener——一次对话里如果发生 native resume / harness 重试
    // 导致 streamViaCli 被多次调用（共享同一个 options.signal 对应的 AbortController），
    // 每次调用都会在这个 controller 上永久挂一个新的 handleAbort 监听器，直到整轮对话
    // 结束、controller 被丢弃才随对象一起被 GC——单轮内监听器数量有界，不是跨会话累积，
    // 但跟 chat-fallback-attempt.ts 那边已经做的对称清理（options.signal?.removeEventListener
    // 在 finally 里）不一致。现在 settle()/handleAbort() 自身/watchdog 超时三条退出路径
    // 都补上了 removeEventListener，跟 API 路径保持一致。
    options.signal?.addEventListener("abort", handleAbort);

    invoke("spawn_cli_stream", {
      params: {
        sessionId,
        program,
        args,
        extraEnv: {},
        workingDirectory: endpoint.workingDirectory ?? null,
      },
      onEvent: channel,
    }).catch((err: unknown) => {
      if (settled) return;
      const raw = err instanceof Error ? err.message : String(err);
      errorMsg = raw;
      // 1.4 修复：兜底识别 spawn 阶段失败（Rust 端如果没正确发 Error 事件，
      // 这里从原始错误字符串兜底识别 spawn_failed）
      errorKind = classifySpawnFailure(raw);
      disarmWatchdog();
      settle();
    });
  });
}

/**
 * 1.4 修复：从原始错误字符串兜底识别 spawn 阶段失败
 * （理想情况 Rust 端已发 kind=spawnFailed Error 事件；这里只兜底）
 */
function classifySpawnFailure(msg: string): CliErrorKind {
  const lower = msg.toLowerCase();
  if (
    lower.includes("no such file") ||
    lower.includes("not found") ||
    lower.includes("os error 2") ||
    lower.includes("permission denied") ||
    lower.includes("access is denied")
  ) {
    return "spawnFailed";
  }
  return "executionFailed";
}
