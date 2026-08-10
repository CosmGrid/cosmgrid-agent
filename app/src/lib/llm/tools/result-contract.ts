// Harness 工程实施计划 阶段2：ToolResult v2 结构化结果与错误恢复协议。
//
// 病根：旧 ToolResult 只有 status + output + reversible，模型看不到错误码、是否可重试、
// 产物在哪、建议下一步是什么，结果是同一个"command failed"反复被模型重试同样参数。
//
// 解法：所有内置工具返回 ToolResultV2：status / summary / output / artifacts / nextActions /
// error（code / rootCauseHint / retryable / retryInstruction / stopCondition）。旧
// {status, output} 通过 compatFromLegacy 兜底，老数据兼容可读。
//
// 三条不变量（计划阶段2）：
// 1. status 是真相源：success / warning / error / denied / timeout，模型只看这一个就知道要不要继续。
// 2. error.code 必填稳定字符串：模型能据此做策略切换（vs 看一段自由文本自己猜）。
// 3. retryable=true 时必须有 retryInstruction（具体下一步）；retryable=false 时必须有
//    stopCondition（明确告诉模型不该再试 / 应该请求用户）。

import type { ContentPart, ToolResult } from "./types";
import { redactApiKeys } from "../../security-invariants/api-key-patterns";

/** 工具执行终态。
 *  - success：完成目标，输出可消费。
 *  - warning：完成但部分不达预期（如 read 返回空、glob 无匹配）——模型应换源而不是重试同一参数。
 *  - error：执行失败，可重试与否看 error.retryable。
 *  - denied：被用户或安全网拒绝，retryable 一定 false，必须停下或请求用户。
 *  - timeout：执行超时，retryable 通常 true 但受 maxAttempts 约束。
 *
 *  旧 ToolStatus 没有 "warning"——这里新增，对应"功能 OK 但结果有问题"这一类（空 grep 命中、
 *  空 glob 命中、view_image 解码失败但没崩）。模型看到 warning 不会误判成 success，但也不
 *  会把它当失败走 repair 循环。 */
export type ToolStatus = "success" | "warning" | "error" | "denied" | "timeout";

/** 工具产物引用：文件 / diff / 命令输出 / URL / 记忆 / 诊断信息。
 *  - file：路径（含是否在工作区外）
 *  - diff：补丁片段（人类/审计侧查看用）
 *  - command_output：可重放的命令 + 退出码
 *  - url：外部资源（web_fetch 结果等）
 *  - memory：项目记忆条目 id
 *  - diagnostic：LSP 报错 / build 报错（强类型诊断）
 *
 *  id 字段可选：artifact 由工具自己产出时，id 通常还没生成（id 是审计写入后才有），
 *  此时 UI 用 uri 当作主键，模型只看 uri 也能跳转/定位。 */
export interface ToolArtifactRef {
  id?: string;
  kind: "file" | "diff" | "command_output" | "url" | "memory" | "diagnostic";
  uri: string;
  label: string;
  /** 命令产物的退出码（kind=command_output 时填） */
  exitCode?: number;
  /** 文件产物是否在工作区之外（kind=file 时填，true 表示引用的是 workspacePath 外的路径） */
  external?: boolean;
}

/** 工具建议下一步动作。
 *  - action：稳定动作名（open_file / run_tests / read_again / ask_user / switch_model ...）
 *  - reason：一句话原因，模型据此判断是否采纳
 *  - safe：该动作是否可在没有用户确认的情况下执行（如 open_file 只读无需确认，
 *    run_tests 是写命令需 confirm） */
export interface ToolNextAction {
  action: string;
  reason: string;
  safe: boolean;
}

/** 结构化错误信息。
 *  - code 必须是稳定字符串，模型能据此做策略切换。允许的自由文本在 rootCauseHint 里。
 *  - retryable + retryInstruction 必须成对出现：模型想重试就按 retryInstruction 来。
 *  - stopCondition 当 retryable=false 时填，告诉模型正确的停止方式（"切换策略 X" /
 *    "请求用户授权 Y"），而不是让它干等着。 */
export interface ToolErrorInfo {
  code: string;
  rootCauseHint: string;
  retryable: boolean;
  retryInstruction?: string;
  stopCondition?: string;
}

/** 工具结果 v2。包住旧 ToolResult 字段，向后兼容老代码：仍保留 status + output + parts +
 *  reversible，新增结构化字段。 */
export interface ToolResultV2 {
  /** 兼容旧 API：与 ToolStatus 枚举一致。 */
  status: ToolStatus;
  /** 一句话结果摘要（≤ 80 字），UI 工具卡优先展示；模型也可快速扫读。
   *  缺省值由 compatFromLegacy / buildResultV2 自动从 output 截前 80 字兜底。 */
  summary: string;
  /** 给模型看的输出（成功是内容，失败是错误信息）。 */
  output: string;
  /** 多模态内容片段（view_image 工具用），不影响 summary/audit。 */
  parts?: ContentPart[];
  /** 结构化产物引用（文件 / diff / url / 记忆 / 诊断）—— UI 用它生成可点击入口，
   *  阶段3 证据链也通过它把"修改了哪个文件"挂到声明上。 */
  artifacts: ToolArtifactRef[];
  /** 给模型看的建议下一步（含 ask_user / switch_model 等终止类动作）。
   *  成功时也允许填，比如"tests 还没跑，是否继续？"——模型据此决定下一轮是否触发。 */
  nextActions: ToolNextAction[];
  /** 失败时的结构化错误信息。status === "success"/"warning" 时 undefined。 */
  error?: ToolErrorInfo;
  /** 这次执行是否可回滚（写操作有 git commit 则 true）。 */
  reversible?: boolean;
  /** 工具执行耗时毫秒（executor 统一注入，工具本身不填）。 */
  durationMs?: number;
  /** 2026-07-15 review 修复：这次执行是否真的弹过确认框并被用户同意——不是从 status/
   *  tool.readOnly 反推的。大多数写工具（write/edit/hashline_edit/memory）无条件走
   *  requireApprovalAsV2，旧的"status !== denied && !tool.readOnly"推导对它们是准的；
   *  但 bash 工具内部有 isReadOnlyCommand 判定，命中时跳过确认直接执行——这种情况下
   *  tool.readOnly 仍是 false（bash 整体能写），旧推导会把"系统判定安全免确认"误记成
   *  "用户确认过"，审计日志失真。只读工具/未显式声明的工具留 undefined，
   *  persistToolExecution 落库时回退到旧推导（向后兼容，不强制所有工具都改）。 */
  userConfirmed?: boolean;
}

// =====================================================================
// 稳定错误码（阶段2 起所有内置工具必须从中取，不允许自由发明）
// =====================================================================
//
// 设计原则：
// 1. 稳定：模型可基于 code 做策略路由，不能因文案变动误判。
// 2. 自描述：从名字能猜出意思，不需要查文档。
// 3. 跟 retryable 对齐：每种错误天然对应"该不该重试"，写在分类里而不是文档里。
//
// TOOL_DOOM_LOOP 必须保留：阶段2 工作项 9 明确要求"Doom Loop 触发时不能只 abort，
// 必须返回 TOOL_DOOM_LOOP 并提示换策略或请求用户"。

/** 输入侧错误：模型给的参数就是错的，重试同一参数必死。 */
export const TOOL_INVALID_PARAMS = "TOOL_INVALID_PARAMS";

/** 路径 / 命令安全拦截：用户已经拒绝 or 安全网 block 命中，重试必须等用户批准或换路径。 */
export const TOOL_DENIED = "TOOL_DENIED";

/** 路径在工作区外且不在白名单。 */
export const TOOL_PATH_OUTSIDE_WORKSPACE = "TOOL_PATH_OUTSIDE_WORKSPACE";

/** 路径不合法（解析失败、含 NUL 等）。 */
export const TOOL_INVALID_PATH = "TOOL_INVALID_PATH";

/** 读不到：文件不存在 / 权限不足 / fs 错误。retryable 通常 false（旧路径 / 权限不会自动变好）。 */
export const TOOL_NOT_FOUND = "TOOL_NOT_FOUND";

/** read/edit/write old_string 不唯一：模型必须补更多上下文再重试。 */
export const TOOL_OLD_STRING_AMBIGUOUS = "TOOL_OLD_STRING_AMBIGUOUS";

/** edit/write 没找到 old_string：可能文件已被改动，建议先 read 一次再改。 */
export const TOOL_OLD_STRING_MISSING = "TOOL_OLD_STRING_MISSING";

/** 命令超时：retryable 默认 true，但受 maxAttempts 约束。 */
export const TOOL_TIMEOUT = "TOOL_TIMEOUT";

/** 命令退出码非 0。retryable 视命令语义。 */
export const TOOL_COMMAND_FAILED = "TOOL_COMMAND_FAILED";

/** 网络层失败（web_fetch / web_search）。retryable 通常 true（DNS 抖动等）。 */
export const TOOL_NETWORK_ERROR = "TOOL_NETWORK_ERROR";

/** HTTP 状态码 4xx/5xx。retryable 看具体状态：429/5xx 通常 true，401/403 false。 */
export const TOOL_HTTP_ERROR = "TOOL_HTTP_ERROR";

/** URL 不合法（SSRF 命中私有地址段）。retryable false。 */
export const TOOL_INVALID_URL = "TOOL_INVALID_URL";

/** MCP 第三方返回结构不符合预期 / 非文本内容无法透传。retryable true（让对方再发一次）。 */
export const TOOL_MCP_BAD_RESPONSE = "TOOL_MCP_BAD_RESPONSE";

/** LSP / 编译报错：build 失败。retryable false（要修代码，不是修命令）。 */
export const TOOL_DIAGNOSTIC = "TOOL_DIAGNOSTIC";

/** Doom Loop：同一 (tool_name, input) 重复次数超过阈值，禁止继续原样重试。 */
export const TOOL_DOOM_LOOP = "TOOL_DOOM_LOOP";

/** 用户取消 / abort：与 denied 不同——denied 是"主动拒绝授权"，cancelled 是"中途叫停"。
 *  cancelled 不计入 retry budget，也不进 repair 循环。 */
export const TOOL_CANCELLED = "TOOL_CANCELLED";

/** 未知 / 兜底错误。retryable false。 */
export const TOOL_UNKNOWN_ERROR = "TOOL_UNKNOWN_ERROR";

// =====================================================================
// 构造器（让工具实现写起来像旧 ToolResult，但自动补齐 v2 字段）
// =====================================================================

/** 工具构造 v2 成功结果。 */
export function successResult(input: {
  output: string;
  summary?: string;
  artifacts?: ToolArtifactRef[];
  nextActions?: ToolNextAction[];
  parts?: ContentPart[];
  reversible?: boolean;
}): ToolResultV2 {
  return {
    status: "success",
    summary: input.summary ?? summarize(input.output),
    output: input.output,
    artifacts: input.artifacts ?? [],
    nextActions: input.nextActions ?? [],
    ...(input.parts ? { parts: input.parts } : {}),
    ...(input.reversible !== undefined ? { reversible: input.reversible } : {}),
  };
}

/** 工具构造 v2 警告结果（功能 OK，但产物不达预期）。 */
export function warningResult(input: {
  output: string;
  summary?: string;
  artifacts?: ToolArtifactRef[];
  nextActions?: ToolNextAction[];
  error: ToolErrorInfo;
  reversible?: boolean;
}): ToolResultV2 {
  return {
    status: "warning",
    summary: input.summary ?? summarize(input.output),
    output: input.output,
    artifacts: input.artifacts ?? [],
    nextActions: input.nextActions ?? [],
    error: input.error,
    ...(input.reversible !== undefined ? { reversible: input.reversible } : {}),
  };
}

/** 工具构造 v2 错误结果。 */
export function errorResult(input: {
  output: string;
  summary?: string;
  error: ToolErrorInfo;
  artifacts?: ToolArtifactRef[];
  nextActions?: ToolNextAction[];
  parts?: ContentPart[];
  reversible?: boolean;
}): ToolResultV2 {
  return {
    status: "error",
    summary: input.summary ?? summarize(input.output),
    output: input.output,
    artifacts: input.artifacts ?? [],
    nextActions: input.nextActions ?? [],
    error: input.error,
    ...(input.parts ? { parts: input.parts } : {}),
    ...(input.reversible !== undefined ? { reversible: input.reversible } : {}),
  };
}

/** 工具构造 v2 denied 结果（用户拒绝 / 安全网拒绝）。retryable 一定 false。 */
export function deniedResult(input: {
  output: string;
  summary?: string;
  reason: string;
  artifacts?: ToolArtifactRef[];
  nextActions?: ToolNextAction[];
}): ToolResultV2 {
  return {
    status: "denied",
    summary: input.summary ?? summarize(input.output),
    output: input.output,
    artifacts: input.artifacts ?? [],
    nextActions: input.nextActions ?? [],
    error: {
      code: TOOL_DENIED,
      rootCauseHint: input.reason,
      retryable: false,
      stopCondition: "等待用户授权或换非写操作路径",
    },
  };
}

/** 工具构造 v2 timeout 结果。retryable 默认 true，但 stopCondition 给出最大次数说明。 */
export function timeoutResult(input: {
  output: string;
  summary?: string;
  error?: Pick<ToolErrorInfo, "rootCauseHint" | "retryInstruction">;
  artifacts?: ToolArtifactRef[];
}): ToolResultV2 {
  const error: ToolErrorInfo = {
    code: TOOL_TIMEOUT,
    rootCauseHint: input.error?.rootCauseHint ?? "执行超过时间上限",
    retryable: true,
    retryInstruction: input.error?.retryInstruction ?? "可缩小输入范围后重试一次",
    stopCondition: "超过 2 次后请请求用户或切更小粒度",
  };
  return {
    status: "timeout",
    summary: input.summary ?? summarize(input.output),
    output: input.output,
    artifacts: input.artifacts ?? [],
    nextActions: [
      { action: "缩小范围后重试", reason: "通常是命令范围太宽 / 文件太大", safe: false },
    ],
    error,
  };
}

// =====================================================================
// 兼容适配：老 ToolResult / 老数据库行 → ToolResultV2
// =====================================================================

/** 把旧 {status, output, reversible} 转 v2。用于：
 *  1. 还没迁移到 v2 的工具（兜底）。
 *  2. 老数据库行 result_json 缺失时回读。 */
export function compatFromLegacy(legacy: Pick<ToolResult, "status" | "output" | "reversible" | "parts">): ToolResultV2 {
  // denied 在老协议里没有 error 字段，但语义上是确定的——补 TOOL_DENIED。
  // timeout 同理（如果传进来）。
  // 注意：老 protocol 的 ToolStatus 是 "success" | "error" | "denied" | "timeout"，
  // 缺 "warning"——老数据不会撞 warning 分支。
  const status: ToolStatus = legacy.status;
  const error: ToolErrorInfo | undefined =
    status === "denied"
      ? {
          code: TOOL_DENIED,
          rootCauseHint: legacy.output,
          retryable: false,
          stopCondition: "等待用户授权或换非写操作路径",
        }
      : status === "timeout"
        ? {
            code: TOOL_TIMEOUT,
            rootCauseHint: legacy.output,
            retryable: true,
            retryInstruction: "可缩小输入范围后重试一次",
            stopCondition: "超过 2 次后请请求用户或切更小粒度",
          }
        : status === "error"
          ? {
              code: TOOL_UNKNOWN_ERROR,
              rootCauseHint: legacy.output,
              retryable: false,
            }
          : undefined;

  return {
    status,
    summary: summarize(legacy.output),
    output: legacy.output,
    artifacts: [],
    nextActions: [],
    ...(legacy.parts ? { parts: legacy.parts } : {}),
    ...(error ? { error } : {}),
    ...(legacy.reversible !== undefined ? { reversible: legacy.reversible } : {}),
  };
}

/** 一句话摘要：从 output 取首行 / 前 80 字，去掉空白噪声。 */
export function summarize(output: string, maxLen = 80): string {
  const firstLine = output.split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (firstLine.length <= maxLen) return firstLine || "(无输出)";
  return firstLine.slice(0, maxLen - 1) + "…";
}

// =====================================================================
// 上下文注入：脱敏 + 截断（给 buildAiSdkTools 用）
// =====================================================================

/** 注入模型上下文前给 ToolResultV2 做的统一处理：
 *  1. status / summary / error / artifacts 头部保留（这些是结构化救命信息，不能丢）。
 *  2. output 截断到 maxChars（默认 10_000，跟旧 MAX_OUTPUT_CHARS 一致），超出加注 "(truncated)"。
 *  3. 把 secret-like 字段（key=xxx / token=xxx / Authorization: Bearer xxx）从 output 和
 *     summary 里脱敏，避免泄露到下一轮 prompt。
 *  4. parts 不参与脱敏（多模态内容已经是 base64，本身不在脱敏范围）。 */
export function truncateForContext(result: ToolResultV2, maxChars = 10_000): ToolResultV2 {
  const clippedOutput = clipAndRedact(result.output, maxChars);
  // summary 走一遍 kv/Bearer 脱敏（redactSecret）+ 厂商 key 前缀脱敏（redactApiKeys），
  // 与 output 的 clipAndRedact 保持一致，避免 sk-ant- / sk-proj- / AIza / gsk_ 从摘要泄露。
  const clippedSummary = redactApiKeys(redactSecret(result.summary));

  // 不重新 redact parts（多模态不走字符串脱敏）
  return {
    ...result,
    output: clippedOutput,
    summary: clippedSummary,
  };
}

/** 截断 + secret 脱敏。单独导出让 write/edit 等长输出工具复用。
 *  脱敏覆盖两类：① kv / Bearer / Authorization 头（redactSecret）；
 *  ② 厂商 API key 前缀（redactApiKeys：sk-ant- / sk-proj- / AIza / gsk_ 等）。
 *  这是工具输出落库前 + 注入模型上下文前的统一脱敏关卡，单一事实来源。 */
export function clipAndRedact(text: string, maxChars: number): string {
  const redacted = redactApiKeys(redactSecret(text));
  if (redacted.length <= maxChars) return redacted;
  return redacted.slice(0, maxChars) + "\n…(truncated)";
}

/**
 * 把 secret-like 字段从自由文本里抹掉。
 * 匹配三种典型形态：
 *   - `key=xxx` / `secret: xxx` / `token=xxx` / `password=xxx`（kv 形式，值长度 ≥ 8）
 *   - `Authorization: Bearer xxxx` / `ApiKey: xxxx`（HTTP 头形式）
 *   - 长 hex/base36 串（≥ 32 字符，且不能跟在前面的字母后——避免误伤 hash 显示等）
 *
 * 保守策略：宁少脱敏不误伤。所以白名单短字符串、UUID-ish 短串、明显是路径/文件名的不动。
 * 触发脱敏后用 `[REDACTED]` 替代，模型看到就知道这里原本有 secret 但不需要拿。
 */
const SECRET_KV_PATTERN =
  /(^|[^A-Za-z0-9_])((?:api[_-]?key|api[_-]?token|access[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|secret[_-]?key|private[_-]?key|(?<![A-Za-z])(?:key|secret|token|password|passwd)(?![A-Za-z])))([:=])(\s*)(["']?)([A-Za-z0-9._\-+/=]{8,})["']?/gi;
const SECRET_HEADER_PATTERN =
  /(Authorization|Proxy-Authorization|Api-Key|X-Api-Key)(\s*:\s*)(Bearer|Basic|Token|ApiKey)?\s*(["']?)([A-Za-z0-9._\-+/=]{8,})["']?/gi;
const SECRET_BEARER_PATTERN = /\bBearer\s+([A-Za-z0-9._\-+/=]{20,})/gi;

export function redactSecret(text: string): string {
  let out = text;
  // kv 形式：保留 prefix + key + 原分隔符（= 或 :）+ 原空白（" " / ""），value 换 [REDACTED]
  out = out.replace(
    SECRET_KV_PATTERN,
    (_match, prefix: string, key: string, sep: string, space: string, _quote: string, _value: string) =>
      `${prefix}${key}${sep}${space}[REDACTED]`,
  );
  // HTTP 头形式：保留 header + 原始 ": " 分隔，scheme 保留
  out = out.replace(
    SECRET_HEADER_PATTERN,
    (_match, header: string, sepWithSpace: string, scheme?: string) =>
      `${header}${sepWithSpace}${scheme ? scheme + " " : ""}[REDACTED]`,
  );
  out = out.replace(SECRET_BEARER_PATTERN, "Bearer [REDACTED]");
  return out;
}

/**
 * 把任意 unknown 错误归一成人类可读字符串。executor.ts 工具实现和各工具文件重复
 * 出现过 `err instanceof Error ? err.message : String(err)` 19+ 次（审查 finding），
 * 统一抽到这个公共函数，避免各工具自己实现走样。
 */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * 阶段2 审查修复：fs 读取失败模板 helper。read/edit/hashline_edit/view-image 4 个工具
 * 各自重复 8 行 `try { fs.readTextFile(...) } catch { return errorResult({TOOL_NOT_FOUND}) }`，
 * 抽到这里统一处理。返回 discriminated union 让调用方按 ok/ok=false 分支处理。
 *
 * 为什么要抽到 result-contract 而不是 fs-adapter：结果契约层（status=error+error.code=
 * TOOL_NOT_FOUND）是 result-contract 的责任；fs-adapter 只关心 I/O。这一层职责清晰。
 *
 * 用法：
 *   const r = await readOrError(fs, resolved, { toolName: "read", pathLabel: resolved });
 *   if (!r.ok) return r.result;
 *   // r.content 可用
 */
export async function readOrError(
  fs: { readTextFile(path: string): Promise<string> },
  path: string,
  opts: { toolName: string; pathLabel?: string; notFoundStop?: string },
): Promise<{ ok: true; content: string } | { ok: false; result: ToolResultV2 }> {
  try {
    const content = await fs.readTextFile(path);
    return { ok: true, content };
  } catch (err) {
    const msg = errorMessage(err);
    return {
      ok: false,
      result: errorResult({
        output: `读取失败：${msg}`,
        summary: `${opts.toolName} 读取失败 ${opts.pathLabel ?? path}`,
        error: {
          code: TOOL_NOT_FOUND,
          rootCauseHint: msg,
          retryable: false,
          stopCondition: opts.notFoundStop ?? "确认文件存在 / 路径正确 / 有读权限",
        },
      }),
    };
  }
}

/** 序列化 ToolResultV2 供 tool_executions.result_json 落库。 */
export function serializeResultV2(result: ToolResultV2): string {
  return JSON.stringify(result);
}

/** 反序列化：老行 result_json 为空时返回 undefined，调用方走 compatFromLegacy。
 *  解析失败也返回 undefined（不让脏数据阻塞整条链路）。 */
export function deserializeResultV2(json: string | null | undefined): ToolResultV2 | undefined {
  if (!json) return undefined;
  try {
    const parsed = JSON.parse(json) as ToolResultV2;
    if (typeof parsed !== "object" || parsed === null) return undefined;
    if (typeof parsed.status !== "string") return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}
