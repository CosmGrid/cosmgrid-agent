// CLI 引擎协议层（纯逻辑，无 Tauri 依赖，可单测）
//
// 这是「spawn 官方 CLI 吃订阅额度」这条接入路径的核心。与 provider-factory（API 直连）
// 平行：API 直连按 token 付费、走 Vercel AI SDK；CLI 引擎 spawn 本机 `claude` / `codex`，
// 吃用户已买的订阅五小时额度，不按 token 付费。
//
// 关键设计（2026-06-21 实地验证 `claude -p` 跑通、确认吃订阅五小时额度）：
//   1. 污染隔离：cc switch 会往 ~/.claude/settings.json 的 env 字段塞 ANTHROPIC_BASE_URL
//      （指向 MiniMax）等，导致 spawn 出来的 claude 跑去第三方而非订阅。两道防线：
//      (a) 启动参数 `--setting-sources ""` 让 claude 忽略所有本地 settings 文件；
//      (b) 受控 env：把 ANTHROPIC_* / CLAUDE_CODE_* 污染变量从子进程环境里抹掉。
//   2. 输出是 JSONL（每行一个 JSON 对象），不是纯文本流。claude 与 codex 的事件结构不同，
//      各自一个解析器，归一化成统一的 CliStreamEvent。
//   3. claude 的 stream-json 里 `rate_limit_event` 带订阅额度剩余，未来可接 Token Plan 显示。

/** 支持的 CLI 引擎类型（对应 Provider.type） */
const CLI_PROVIDER_TYPES = ["claude-cli", "codex-cli"] as const;
export type CliProviderType = (typeof CLI_PROVIDER_TYPES)[number];

/** 该 provider type 是否走 CLI 引擎（而非 provider-factory / streamText） */
export function isCliProviderType(type: string): type is CliProviderType {
  return (CLI_PROVIDER_TYPES as readonly string[]).includes(type);
}

/** 各 CLI 的默认可执行文件名（用户没填绝对路径时回退到 PATH 查找） */
export const CLI_DEFAULT_PROGRAM: Record<CliProviderType, string> = {
  "claude-cli": "claude",
  "codex-cli": "codex",
};

// ============ 受控环境变量 ============

/**
 * 必须从子进程环境里抹掉的变量：cc switch / Claude Code 注入这些会让 claude 改走第三方
 * 路由（如 MiniMax）或误判嵌套会话。抹掉后 claude 回落到订阅 OAuth 登录态。
 * 前缀匹配：任何以这些开头的 key 都清。
 */
const POLLUTING_ENV_PREFIXES = [
  "ANTHROPIC_", // BASE_URL / AUTH_TOKEN / API_KEY / MODEL / DEFAULT_*_MODEL …
  "CLAUDECODE",
  "CLAUDE_CODE_",
  "CLAUDE_AGENT_SDK_",
] as const;

/**
 * 从父进程环境算出「要传给子进程的受控环境」。
 * 做法：拷贝父环境，删掉所有命中污染前缀的 key。返回新对象（不可变，不改入参）。
 */
export function buildControlledEnv(
  parentEnv: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parentEnv)) {
    if (value === undefined) continue;
    const polluted = POLLUTING_ENV_PREFIXES.some((p) => key.startsWith(p));
    if (polluted) continue;
    out[key] = value;
  }
  return out;
}

// ============ 调用参数构造 ============

export interface CliMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

/**
 * 把多轮对话历史拼成单个 prompt 文本传给 CLI（v1 策略）。
 * CLI 的 `-p` / `exec` 是单轮入口，跨进程 spawn 不持久 session，所以把整段历史
 * 序列化成文本带过去——限额自动换模型时同一份历史照样带，不丢上下文。
 */
export function buildPromptFromMessages(messages: readonly CliMessage[]): string {
  const parts: string[] = [];
  for (const m of messages) {
    if (m.role === "system") parts.push(`[System]\n${m.content}`);
    else if (m.role === "user") parts.push(`[User]\n${m.content}`);
    else parts.push(`[Assistant]\n${m.content}`);
  }
  return parts.join("\n\n");
}

// ============ 权限档位 → CLI 沙箱/权限参数映射 ============
//
// 关键（2026-07-07，用户实测"让 codex 保存到桌面被拒 Operation not permitted"）：
// app 的"只读/确认写/自动"档位，管的是 API 模式下我们自己内置的 write 工具，**从来没
// 传给过 CLI 引擎**。CLI 引擎（claude/codex）spawn 出去后用的是它们自己的工具、跑在各自
// 的沙箱/权限体系里，默认只能写工作目录内——用户绑的工作文件夹之外（如桌面）一律拒绝。
// 用户的真实痛点是"我的意图没传给 CLI"（他直接开 codex 就能写桌面，因为交互模式会弹审批；
// 我们用 codex exec 非交互模式，那条审批通道断了）。这里把 app 档位翻译成两个引擎各自的
// 启动参数，让意图在"开工前"就传达到位：
//   - codex：--sandbox read-only|workspace-write（读写总闸）
//   - claude：--permission-mode plan|acceptEdits（读写总闸）
//   - 两者通用：--add-dir <目录> 把工作区之外的目录（用户确认放行的桌面）并入可写范围
// writableRoots 由上层在"确认写/自动 + 用户确认放行"后填入（见 useChatStream 的折中弹窗）。
//
// 现状标注（2026-07-18 写权限双层重构）：这条 read→plan/read-only 的映射目前**未接线**——
// CliAccessOptions.cliAccess 字段在全代码库里从未被赋值过一次（chat-fallback-attempt.ts
// 只在 `options.cliAccess` 存在时才透传，但没有任何调用方构造过带 cliAccess 的 options），
// 所以 buildCliArgs/buildCliResumeArgs 里 `access?.permissionMode` 恒为 undefined，实际
// spawn 出去的 CLI 进程从不带 --permission-mode/--sandbox 参数，沿用各 CLI 自己的默认值。
// API 路径（useChatStream 内置工具）的 read/confirm/auto 三档语义已在本轮重构里理清
// （见 app-settings.ts getPermissionMode 默认值改 confirm + tool-permission-policy.ts +
// write-guard-runtime.ts），但 CLI 路径（spawn claude/codex）的权限档接线是后续独立工作，
// 目前两条路径的 read 档语义可能不一致——留这条注释防止被遗忘。

export type CliPermissionMode = "read" | "confirm" | "auto";

export interface CliAccessOptions {
  /** app 权限档位。不传 = 不显式设置，沿用各 CLI 默认（保持旧行为，向后兼容）。 */
  permissionMode?: CliPermissionMode;
  /** 工作区之外额外放行的可写目录（如用户确认后的桌面）。两个引擎都用 --add-dir。 */
  writableRoots?: string[];
}

/** codex --sandbox：只读→read-only，确认写/自动→workspace-write（不完全放开，仅工作区+放行目录可写）。 */
function codexSandboxMode(mode: CliPermissionMode): "read-only" | "workspace-write" {
  return mode === "read" ? "read-only" : "workspace-write";
}

/** claude --permission-mode：只读→plan（只读规划不写盘），确认写/自动→acceptEdits（可写；非交互 -p 下不逐次弹问）。 */
function claudePermissionMode(mode: CliPermissionMode): "plan" | "acceptEdits" {
  return mode === "read" ? "plan" : "acceptEdits";
}

/** 把 --add-dir <每个 writableRoot> 追加进 args（claude/codex 通用；空/空白目录跳过）。 */
function appendWritableRoots(args: string[], writableRoots?: string[]): void {
  for (const dir of writableRoots ?? []) {
    if (dir.trim()) args.push("--add-dir", dir);
  }
}

/** 构造 spawn 用的参数（不含 program 本身）。
 *  systemPrompt：CosmGrid 核心规则，经 claude 的 --append-system-prompt 正式注入——
 *  因为 --setting-sources "" 屏蔽了本机 CLAUDE.md，必须我们显式塞，CLI 才受同一套约束。
 *  access：把 app 权限档位 + 放行目录翻译成 CLI 各自的沙箱/权限参数（见上方注释块）。 */
export function buildCliArgs(
  providerType: CliProviderType,
  modelName: string,
  prompt: string,
  systemPrompt?: string,
  access?: CliAccessOptions,
): string[] {
  if (providerType === "claude-cli") {
    // --output-format stream-json 需要配合 --verbose；--setting-sources "" 隔离被污染的本地配置
    const args = [
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--setting-sources",
      "",
    ];
    if (access?.permissionMode) args.push("--permission-mode", claudePermissionMode(access.permissionMode));
    appendWritableRoots(args, access?.writableRoots);
    if (systemPrompt?.trim()) args.push("--append-system-prompt", systemPrompt);
    if (modelName.trim()) args.push("--model", modelName);
    return args;
  }
  // codex-cli：codex exec --json 输出 JSONL（codex 无 --append-system-prompt，规则随 prompt 文本带过去）
  // --skip-git-repo-check：修复（2026-07-07，用户实测发现）——codex 自带"工作目录必须是
  // 已信任的 git 仓库"检查，工作文件夹不是 git 仓库时会直接拒绝执行，并且会静默把 cwd
  // 换成别的目录继续跑（实测复现：换成了完全无关的目录）。这道检查跟我们自己的
  // 只读/确认写/自动权限模型无关（那套是我们自己控制的，不受这个参数影响）——不跳过
  // 这道检查，用户选的非 git 工作文件夹会被 codex 直接拒绝或换到错误目录。
  const args = ["exec", prompt, "--json", "--skip-git-repo-check"];
  if (access?.permissionMode) args.push("--sandbox", codexSandboxMode(access.permissionMode));
  appendWritableRoots(args, access?.writableRoots);
  if (modelName.trim()) args.push("--model", modelName);
  return args;
}

export function buildCliResumeArgs(
  providerType: CliProviderType,
  modelName: string,
  officialSessionId: string,
  prompt: string,
  systemPrompt?: string,
  access?: CliAccessOptions,
): string[] {
  if (providerType === "claude-cli") {
    const args = [
      "--resume",
      officialSessionId,
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--setting-sources",
      "",
    ];
    if (access?.permissionMode) args.push("--permission-mode", claudePermissionMode(access.permissionMode));
    appendWritableRoots(args, access?.writableRoots);
    if (systemPrompt?.trim()) args.push("--append-system-prompt", systemPrompt);
    if (modelName.trim()) args.push("--model", modelName);
    return args;
  }
  const args = ["exec", "resume", officialSessionId, prompt, "--json", "--skip-git-repo-check"];
  if (access?.permissionMode) args.push("--sandbox", codexSandboxMode(access.permissionMode));
  appendWritableRoots(args, access?.writableRoots);
  if (modelName.trim()) args.push("--model", modelName);
  return args;
}

export type CliResumeCapability =
  | { mode: "stateless"; reason: string }
  | { mode: "resumable"; sessionId: string; resumeArgs: string[] };

// ============ JSONL 输出解析 ============

/** 归一化后的流事件：上层只认这几种，不关心 claude / codex 的原始结构差异 */
export type CliStreamEvent =
  | { kind: "delta"; text: string }
  | { kind: "status"; text: string }
  | { kind: "model"; modelName: string }
  | { kind: "usage"; inputTokens: number; outputTokens: number }
  | { kind: "rate_limit"; resetsAt: number | null; limitType: string | null }
  | { kind: "session"; sessionId: string }
  | { kind: "error"; message: string }
  | { kind: "done"; finishReason: string };

interface ClaudeContentBlock {
  type: string;
  text?: string;
}

/**
 * 解析一行 claude stream-json。返回 0 或多个归一化事件（一行可能同时含文本和 usage）。
 * 容错：非 JSON 行 / 未知 type 一律返回空数组，不抛错（CLI 偶尔混入非 JSON 日志行）。
 */
export function parseClaudeStreamLine(line: string): CliStreamEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return [];
  }
  const type = obj["type"];
  const events: CliStreamEvent[] = [];

  if (type === "system" && obj["subtype"] === "init" && typeof obj["session_id"] === "string") {
    events.push({ kind: "session", sessionId: obj["session_id"] });
    if (typeof obj["model"] === "string" && obj["model"]) {
      events.push({ kind: "model", modelName: obj["model"] });
    }
    return events;
  }

  if (type === "assistant") {
    const message = obj["message"] as { content?: ClaudeContentBlock[]; model?: string } | undefined;
    // Claude CLI 在鉴权失败时会先吐一条 model="<synthetic>" 的 assistant 文本，
    // 随后才在 result 事件里标 is_error=true。这里不能把那条合成文本当成正常回复。
    if (typeof obj["error"] === "string" || message?.model === "<synthetic>") return [];
    const blocks = message?.content ?? [];
    for (const b of blocks) {
      if (b.type === "text" && typeof b.text === "string" && b.text) {
        events.push({ kind: "delta", text: b.text });
      }
    }
    return events;
  }

  if (type === "rate_limit_event") {
    const info = obj["rate_limit_info"] as
      | { resetsAt?: number; rateLimitType?: string }
      | undefined;
    events.push({
      kind: "rate_limit",
      resetsAt: typeof info?.resetsAt === "number" ? info.resetsAt : null,
      limitType: typeof info?.rateLimitType === "string" ? info.rateLimitType : null,
    });
    return events;
  }

  if (type === "result") {
    const isError = obj["is_error"] === true;
    if (isError) {
      const msg = typeof obj["result"] === "string" ? obj["result"] : "CLI returned an error";
      events.push({ kind: "error", message: msg });
      return events;
    }
    const usage = obj["usage"] as
      | { input_tokens?: number; output_tokens?: number }
      | undefined;
    events.push({
      kind: "usage",
      inputTokens: usage?.input_tokens ?? 0,
      outputTokens: usage?.output_tokens ?? 0,
    });
    const stopReason = typeof obj["stop_reason"] === "string" ? obj["stop_reason"] : "stop";
    events.push({ kind: "done", finishReason: stopReason });
    return events;
  }

  return events;
}

/**
 * 解析一行 codex --json。codex 的事件结构与 claude 不同（待 codex 套餐恢复后按实测细化）。
 * 当前按已知通用结构解析：item/message 文本增量 + token_count 用量。容错同上。
 */
export function parseCodexStreamLine(line: string): CliStreamEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return [];
  }
  const type = obj["type"];
  const events: CliStreamEvent[] = [];

  if (type === "thread.started" && typeof obj["thread_id"] === "string") {
    events.push({ kind: "session", sessionId: obj["thread_id"] });
    return events;
  }

  const item = obj["item"] as Record<string, unknown> | undefined;

  // codex 文本增量：
  // - 旧格式：{ type: "agent_message", text: "..." }
  // - 当前实测：{ type: "item.completed", item: { type: "agent_message", text: "..." } }
  const text = (item?.["text"] ?? item?.["delta"] ?? obj["delta"] ?? obj["text"]) as unknown;
  const itemType = item?.["type"];
  if (
    (type === "agent_message" || type === "item.completed" || type === "message") &&
    (type !== "item.completed" || itemType === undefined || itemType === "agent_message") &&
    typeof text === "string" &&
    text
  ) {
    events.push({ kind: "delta", text });
  }

  if (type === "token_count" || type === "usage" || type === "turn.completed") {
    const usage = (obj["usage"] ?? obj) as { input_tokens?: number; output_tokens?: number };
    if (typeof usage.input_tokens === "number" || typeof usage.output_tokens === "number") {
      events.push({
        kind: "usage",
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
      });
    }
  }

  if (type === "item.started" && itemType === "mcp_tool_call") {
    const server = typeof item?.["server"] === "string" ? item.server : "tool";
    const tool = typeof item?.["tool"] === "string" ? item.tool : "call";
    events.push({ kind: "status", text: `正在调用 ${server}.${tool}...` });
  }

  if (type === "item.completed" && itemType === "mcp_tool_call") {
    const status = item?.["status"];
    if (status === "failed") {
      const error = item?.["error"] as { message?: string } | null | undefined;
      const message = typeof error?.message === "string" ? error.message : "工具调用失败";
      events.push({ kind: "status", text: `工具调用失败：${message}` });
    }
  }

  // 修复（2026-07-07，用户实测发现）：codex 自己读文件/跑命令走的是 command_execution
  // 这个 item type，不是 mcp_tool_call（那个只对接 MCP 协议的外部工具）——之前完全没识别，
  // 导致 codex 不管内部真实干了多少活，界面永远只显示死板的"思考中"，看不出它到底在
  // 动还是卡死了。这里把它接进同一套 status 事件，实测字段名：item.command / item.exit_code。
  if (type === "item.started" && itemType === "command_execution") {
    const command = typeof item?.["command"] === "string" ? item.command : "命令";
    events.push({ kind: "status", text: `正在执行：${command}` });
  }

  if (type === "item.completed" && itemType === "command_execution") {
    const exitCode = item?.["exit_code"];
    const command = typeof item?.["command"] === "string" ? item.command : "命令";
    if (typeof exitCode === "number" && exitCode !== 0) {
      events.push({ kind: "status", text: `命令执行失败（退出码 ${exitCode}）：${command}` });
    } else {
      events.push({ kind: "status", text: `已执行：${command}` });
    }
  }

  if (type === "error") {
    const rawMessage = obj["message"];
    const msg = typeof rawMessage === "string" ? rawMessage : "codex returned an error";
    // 修复（2026-07-07，用户实测发现，日志实锤）：codex 网络重连时吐的
    // {"type":"error","message":"Reconnecting... N/5 (request timed out)"} 跟真正致命
    // 错误长得一模一样（都是顶层 type:"error"）。之前一律当致命错误，一旦收到就把
    // errorMsg 钉死——即使 codex 之后重连成功、正常跑完整个回合，最终 settle() 时还是会
    // 把这段已经成功的结果当失败整段扔掉。"N/5" 说明这是 codex 自己在报告重试进度，
    // 不是终态失败，只当状态提示，不污染最终结果。
    if (/^reconnecting\.\.\.\s*\d+\/\d+/i.test(msg.trim())) {
      events.push({ kind: "status", text: `网络连接不稳定，${msg}` });
    } else {
      events.push({ kind: "error", message: msg });
    }
  }

  if (type === "task_complete" || type === "turn.completed") {
    events.push({ kind: "done", finishReason: "stop" });
  }

  return events;
}

/** 按 provider 类型选对应解析器 */
export function parseCliStreamLine(
  providerType: CliProviderType,
  line: string,
): CliStreamEvent[] {
  return providerType === "claude-cli"
    ? parseClaudeStreamLine(line)
    : parseCodexStreamLine(line);
}

export function extractOfficialSessionId(
  providerType: CliProviderType,
  line: string,
): string | null {
  const sessionEvent = parseCliStreamLine(providerType, line).find((event) => event.kind === "session");
  return sessionEvent?.kind === "session" ? sessionEvent.sessionId : null;
}

export function detectCliResumeCapability(args: {
  providerType: CliProviderType;
  modelName: string;
  officialSessionId: string | null;
}): CliResumeCapability {
  if (!args.officialSessionId) {
    return { mode: "stateless", reason: "CLI output did not expose a stable official session id" };
  }
  return {
    mode: "resumable",
    sessionId: args.officialSessionId,
    resumeArgs: buildCliResumeArgs(
      args.providerType,
      args.modelName,
      args.officialSessionId,
      "Continue from where you stopped. Do not repeat completed content.",
    ),
  };
}
