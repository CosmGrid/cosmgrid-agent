// LLM 错误分类 + 清洗
// 解决两个关键安全问题：
// 1. 用户截图报错时会泄漏 API Key 前缀（如 "sk-ant-api03-xxx"）
// 2. 原始错误信息对小白用户不友好（"TypeError: fetch failed at..."）
//
// 设计原则：
// 1. sanitizeError 永远剥掉 API Key 模式（防御性）
// 2. classifyLlmError 把错误分桶（401/403/429/超时/网络/未知）
// 3. 返回结构化结果 {httpStatus, userMessage, technicalMessage}，让路由层决策怎么响应
//
// 1.2 修复（2026-07-02）：classifyLlmError 接受 providerType 第三参数，按 provider
//   专属规则表匹配（覆盖国产 provider 中文错误体）；通用英文兜底保留作为最后防线。
// 1.4 修复（2026-07-02）：新增 cli_not_installed / cli_not_logged_in 分类，
//   专门给"本机 CLI 没装 / 没登录"用，UI 引导用户去安装而不是重试。

import { getProviderPatterns, type ProviderErrorPatterns } from "@/lib/policy/provider-error-rules";
import { redactApiKeys } from "@/lib/security-invariants/api-key-patterns";

/**
 * LLM 错误分类
 */
export type LlmErrorCategory =
  | "auth_invalid" // 401 - API Key 无效 / 过期
  | "auth_forbidden" // 403 - 权限不足
  | "rate_limit" // 429 - 套餐耗尽
  | "timeout" // 请求超时
  | "network" // 网络故障
  | "web_content_unavailable" // 外部网页/链接内容无法读取
  | "context_overflow" // 上下文超出窗口
  | "model_not_found" // 404 - 模型下线
  | "server_error" // 5xx - provider 服务故障
  | "cli_not_installed" // 1.4 新增：spawn 失败，本机 CLI 程序不存在
  // 1.4 新增，⚠️ 2026-07-02 代码审查发现：这个分类目前没有任何代码路径会真正产出它——
  // extractCliKind 只识别 spawnFailed/executionFailed/stalled 三种，没有专门的"未登录"信号。
  // "spawn 成功但未登录"这种场景目前会落进 executionFailed → 通用 server_error 兜底，
  // 不会命中这个分类。真要实现，需要先跑一遍 claude/codex CLI 在未登录状态下的真实输出
  // （类似 provider-error-rules.ts 的 probe 方式），拿到真实 stderr 文案再回填检测规则，
  // 不能凭猜测写关键词匹配（这正是 1.2 那批 provider 规则最初的教训）。保留这个分类是
  // 因为它是一个有意义的未来分支，但目前是声明了但未接线的状态，不要以为它已经生效。
  | "cli_not_logged_in"
  // 修复（2026-07-02，用户实测发现）：chat-fallback.ts 撞到步数/续跑预算上限时抛的
  // 裸英文 Error（"truncated after N automatic continuations" / "ended abnormally"），
  // 之前没有任何分类规则命中，落进 unknown 变成"对话失败，请稍后重试"——这句话具有
  // 误导性，暗示重试能解决，但如果是任务太复杂/多步预算不够，原样重试大概率还会再撞上。
  | "tool_budget_exhausted"
  // 修复（2026-07-05，用户实测发现）：链上所有模型都在失败冷却中时 chat-fallback.ts
  // 抛的裸英文 Error（"All models are cooling down: ..."），之前落进 unknown，用户只看到
  // 一句生硬英文，不知道具体哪几个模型、还要等多久，也不知道重启 app 能立即清空冷却
  // （冷却状态只在内存里，见 model-cooldown.ts）。
  | "all_models_cooling"
  | "unknown"; // 其他

/**
 * 分类后的错误（结构化）
 */
export interface ClassifiedLlmError {
  category: LlmErrorCategory;
  /** 推荐 HTTP 状态码（给前端用） */
  httpStatus: number;
  /** 给用户看的中文友好文案 */
  userMessage: string;
  /** 给开发者/日志的技术详情（已脱敏） */
  technicalMessage: string;
  /**
   * 是否推荐回退到 fallback 模型
   * - true: 401/403/404/429/超时/网络/5xx → 切
   * - false: context_overflow（换模型也救不了）/ unknown（保守，可能是 bug）
   * chat-fallback 消费这个字段决定要不要切
   */
  shouldFallback: boolean;
}

/**
 * 已知 API Key 模式（用于从错误信息里剥离）
 * 覆盖：OpenAI / Anthropic / Google / DeepSeek / GLM
 *
 * 实现已搬到 lib/security-invariants/api-key-patterns.ts（阶段 3 R7 集中）。
 * 本函数保留为稳定 API 入口（兼容所有 call sites），内部委托 redactApiKeys。
 */
export function sanitizeError(raw: unknown): string {
  return redactApiKeys(raw);
}

/**
 * 提取 HTTP 状态码（从 Vercel AI SDK / fetch 错误对象）
 * Vercel AI SDK 把 statusCode 放在 error.statusCode 或 error.response.status
 */
function extractStatusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const e = error as Record<string, unknown>;
  if (typeof e.statusCode === "number") return e.statusCode;
  if (typeof e.status === "number") return e.status;
  if (typeof e.code === "number") return e.code;
  // AI_APICallError 通常有 status
  if (typeof e.response === "object" && e.response !== null) {
    const response = e.response as Record<string, unknown>;
    if (typeof response.status === "number") return response.status;
  }
  return undefined;
}

/**
 * 提取错误消息文本
 */
function extractMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null) {
    const e = error as Record<string, unknown>;
    if (typeof e.message === "string") return e.message;
  }
  return String(error);
}

/**
 * 提取 CLI 错误 kind（1.4 修复）。
 * cli-engine.ts 抛 Error 时挂的 __cliKind 字段（"spawnFailed" / "executionFailed" / "stalled"）。
 * 有这个字段说明错误来自 CLI 路径，应优先按 CLI 场景分类（不要走通用网络/超时）。
 */
function extractCliKind(error: unknown): "spawnFailed" | "executionFailed" | "stalled" | null {
  if (typeof error !== "object" || error === null) return null;
  const e = error as Record<string, unknown>;
  const kind = e.__cliKind;
  if (kind === "spawnFailed" || kind === "executionFailed" || kind === "stalled") return kind;
  return null;
}

/**
 * 按 provider 专属**状态码**匹配错误分类（1.2 修复）。
 * 只看 statusCode，不看关键词。
 * 必须在通用 HTTP 状态码检查之前调用——否则像智谱 1214（限流，数值上落在 5xx 区间）
 * 会被通用 statusCode >= 500 分支先收走为 server_error。
 *
 * **只匹配 provider 自定义 code**（不在标准 HTTP 401/403/404/413/429/5xx 范围内的）。
 * 标准 HTTP 状态码让通用分支处理（401 → auth_invalid，403 → auth_forbidden，等等），
 * 这样 provider rules 不会跟通用语义冲突。
 */
const HTTP_STANDARD_STATUS_CODES = new Set<number>([
  401, 403, 404, 413, 429, 500, 501, 502, 503, 504, 505,
  // 5xx 通用范围（只列 500-505，其他 5xx 一律走 provider rules / 通用 server_error）
]);

function isStandardHttpStatusCode(statusCode: number): boolean {
  if (HTTP_STANDARD_STATUS_CODES.has(statusCode)) return true;
  if (statusCode >= 500 && statusCode <= 505) return true;
  return false;
}

function matchProviderByStatusCode(
  patterns: ProviderErrorPatterns,
  statusCode: number | undefined,
): LlmErrorCategory | null {
  if (statusCode === undefined) return null;
  // 标准 HTTP 状态码让通用分支处理，不在这里匹配
  if (isStandardHttpStatusCode(statusCode)) return null;
  if (patterns.rateLimitStatusCodes.includes(statusCode)) return "rate_limit";
  if (patterns.authStatusCodes.includes(statusCode)) return "auth_invalid";
  if (patterns.contextOverflowStatusCodes.includes(statusCode)) return "context_overflow";
  if (patterns.modelNotFoundStatusCodes.includes(statusCode)) return "model_not_found";
  return null;
}

/**
 * 按 provider 专属**关键词**匹配错误分类（1.2 修复）。
 * 只看关键词（错误文本已 lowercase），不看 statusCode。
 * 在通用英文兜底之前调用——覆盖国产 provider 中文错误体。
 *
 * 优先级：rate_limit > auth_invalid > context_overflow > model_not_found
 * （多个分类都命中时按优先级取第一个）
 */
function matchProviderByKeywords(
  patterns: ProviderErrorPatterns,
  lower: string,
): LlmErrorCategory | null {
  if (patterns.rateLimitKeywords.some((k) => lower.includes(k.toLowerCase()))) return "rate_limit";
  if (patterns.authKeywords.some((k) => lower.includes(k.toLowerCase()))) return "auth_invalid";
  if (patterns.contextOverflowKeywords.some((k) => lower.includes(k.toLowerCase()))) return "context_overflow";
  if (patterns.modelNotFoundKeywords.some((k) => lower.includes(k.toLowerCase()))) return "model_not_found";
  return null;
}

/**
 * 把 provider 匹配出的 category 构造成完整 ClassifiedLlmError（1.2 修复）。
 */
function buildProviderCategorized(
  category: LlmErrorCategory,
  sanitized: string,
  msg: (zh: string, key: string) => string,
): ClassifiedLlmError {
  switch (category) {
    case "rate_limit":
      return {
        category: "rate_limit",
        httpStatus: 429,
        userMessage: msg(
          "套餐额度已耗尽或被限流，请稍后重试或检查套餐状态",
          "errorClassifier.rate_limit",
        ),
        technicalMessage: sanitized,
        shouldFallback: true,
      };
    case "auth_invalid":
      return {
        category: "auth_invalid",
        httpStatus: 401,
        userMessage: msg(
          "API Key 无效或已过期，请在 API 接入页检查",
          "errorClassifier.auth_invalid",
        ),
        technicalMessage: sanitized,
        shouldFallback: true,
      };
    case "context_overflow":
      return {
        category: "context_overflow",
        httpStatus: 413,
        userMessage: msg(
          "对话内容超出模型上下文窗口，请新建对话或缩短历史",
          "errorClassifier.context_overflow",
        ),
        technicalMessage: sanitized,
        shouldFallback: false,
      };
    case "model_not_found":
      return {
        category: "model_not_found",
        httpStatus: 404,
        userMessage: msg(
          "模型不存在或已下线，请检查模型名称",
          "errorClassifier.model_not_found",
        ),
        technicalMessage: sanitized,
        shouldFallback: true,
      };
    default:
      return {
        category: "unknown",
        httpStatus: 500,
        userMessage: msg("对话失败，请稍后重试", "errorClassifier.unknown"),
        technicalMessage: sanitized,
        shouldFallback: false,
      };
  }
}

/**
 * 把 LLM 错误分桶成结构化结果
 * @param error - 原始错误（可能是 Vercel AI SDK 的 AIError / fetch 错误 / 任意 Error）
 * @param t - (可选) i18next t 函数，传了之后 userMessage 会用 t() 翻译
 * @param providerType - (可选) provider 类型（如 "anthropic" / "openai" / "MiniMax" / "deepseek" / "glm" / "kimi"），
 *   传了之后会按 provider 专属规则表优先匹配（覆盖国产 provider 中文错误体）。
 *   不传或未注册的 provider 走通用英文兜底。
 * @returns 分类结果 + 友好文案
 */
export function classifyLlmError(
  error: unknown,
  t?: (k: string) => string,
  providerType?: string,
): ClassifiedLlmError {
  const rawMessage = extractMessage(error);
  const statusCode = extractStatusCode(error);
  const sanitized = sanitizeError(rawMessage);

  // 1.4 修复：CLI 路径错误优先识别（不走通用 HTTP 检查，spawn 失败没 statusCode）
  const cliKind = extractCliKind(error);
  if (cliKind === "spawnFailed") {
    return {
      category: "cli_not_installed",
      httpStatus: 500,
      userMessage: "没有检测到本机安装的 Claude/Codex CLI，请先在终端运行 `claude login` 或安装 CLI 后再试",
      technicalMessage: sanitized,
      // 关键：not_found 错误不能切 fallback（换别的模型救不了），必须让用户先装 CLI
      shouldFallback: false,
    };
  }
  if (cliKind === "stalled") {
    return {
      category: "timeout",
      httpStatus: 504,
      userMessage: "CLI 进程卡死未产生任何事件，已自动终止，请重试",
      technicalMessage: sanitized,
      shouldFallback: true,
    };
  }
  // executionFailed 走通用 server_error 兜底（保持现有 fallback 行为）

  // 没传 t 时用中文（向后兼容）；传了 t 时用 t() 翻译，缺失 fallback 到 key
  const msg = (zh: string, key: string) => (t ? (t(key) || zh) : zh);

  // 按 HTTP 状态码优先分类

  // 1.2 修复：先按 provider 自定义状态码检查（必须在通用 HTTP 检查之前，
  // 否则智谱 1214 这类数值上落在 5xx 区间的 code 会被收走为 server_error）
  const patterns = getProviderPatterns(providerType);
  const byStatus = matchProviderByStatusCode(patterns, statusCode);
  if (byStatus) {
    return buildProviderCategorized(byStatus, sanitized, msg);
  }

  if (statusCode === 401) {
    return {
      category: "auth_invalid",
      httpStatus: 401,
      userMessage: cliKind
        ? "本机 CLI 登录状态可能已过期，请在终端运行 `claude /login`（或 `codex login`）后重试"
        : msg("API Key 无效或已过期，请在 API 接入页检查", "errorClassifier.auth_invalid"),
      technicalMessage: sanitized,
      shouldFallback: true,
    };
  }

  if (/401|invalid authentication credentials|failed to authenticate|authentication_failed/i.test(rawMessage)) {
    return {
      category: "auth_invalid",
      httpStatus: 401,
      userMessage: msg("登录凭据无效或已过期，请重新登录对应 CLI / API 账号", "errorClassifier.auth_invalid"),
      technicalMessage: sanitized,
      shouldFallback: false,
    };
  }
  if (statusCode === 403) {
    return {
      category: "auth_forbidden",
      httpStatus: 403,
      userMessage: msg("API Key 权限不足，请检查账户是否欠费或套餐限制", "errorClassifier.auth_forbidden"),
      technicalMessage: sanitized,
      shouldFallback: true,
    };
  }
  if (statusCode === 404) {
    return {
      category: "model_not_found",
      httpStatus: 404,
      userMessage: msg("模型不存在或已下线，请检查模型名称", "errorClassifier.model_not_found"),
      technicalMessage: sanitized,
      shouldFallback: true,
    };
  }
  if (statusCode === 413 || statusCode === 429) {
    // 413 = payload too large（上下文超出）
    if (statusCode === 413 || /context.{0,20}(length|window|size)/i.test(rawMessage)) {
      return {
        category: "context_overflow",
        httpStatus: 413,
        userMessage: msg("对话内容超出模型上下文窗口，请新建对话或缩短历史", "errorClassifier.context_overflow"),
        technicalMessage: sanitized,
        shouldFallback: false, // 换模型也救不了
      };
    }
    return {
      category: "rate_limit",
      httpStatus: 429,
      userMessage: msg("套餐额度已耗尽或被限流，请稍后重试或检查套餐状态", "errorClassifier.rate_limit"),
      technicalMessage: sanitized,
      shouldFallback: true,
    };
  }
  if (statusCode !== undefined && statusCode >= 500) {
    return {
      category: "server_error",
      httpStatus: statusCode,
      userMessage: msg("AI 服务暂时不可用，请稍后重试", "errorClassifier.server_error"),
      technicalMessage: sanitized,
      shouldFallback: true,
    };
  }

  const lower = rawMessage.toLowerCase();

  // 1.2 修复：provider 专属关键词匹配（在通用英文兜底前按 provider 规则查）
  // 覆盖国产 provider 的中文错误体（如 MiniMax "余额不足" / 智谱 "鉴权失败"）
  const matchedByProvider = matchProviderByKeywords(patterns, lower);
  if (matchedByProvider) {
    return buildProviderCategorized(matchedByProvider, sanitized, msg);
  }

  // 没状态码时按错误文本分类（通用英文兜底，保留作为最后防线）
  if (
    lower.includes("rate limit") ||
    lower.includes("rate_limit") ||
    lower.includes("quota exceeded") ||
    lower.includes("usage limit") ||
    lower.includes("too many requests")
  ) {
    return {
      category: "rate_limit",
      httpStatus: 429,
      userMessage: msg("套餐额度已耗尽或被限流，请稍后重试或检查套餐状态", "errorClassifier.rate_limit"),
      technicalMessage: sanitized,
      shouldFallback: true,
    };
  }
  if (
    lower.includes("unauthorized") ||
    lower.includes("invalid api key") ||
    lower.includes("invalid token") ||
    lower.includes("authentication failed") ||
    lower.includes("auth failed")
  ) {
    // cliKind === "executionFailed" 到这里：这段关键词原本是为 API 直连 provider 写的
    // （错误来自 HTTP 响应体）。CLI 引擎走订阅 OAuth 登录，压根没有"API Key"这个概念——
    // "请在 API 接入页检查"这句话对 claude-cli/codex-cli 用户来说是误导性的胡言乱语。
    // 而且这里的匹配源头是子进程 stderr 原文任意关键词命中，置信度天生不如真实 HTTP 401，
    // 有可能是别的执行错误（比如 --resume 用了失效的 session id）被误判成"未登录"。
    return {
      category: "auth_invalid",
      httpStatus: 401,
      userMessage: cliKind
        ? "本机 CLI 登录状态可能已过期，或本次执行失败被误判为登录问题——请先在终端确认 `claude`/`codex` 能正常对话，再重试"
        : msg("API Key 无效或已过期，请在 API 接入页检查", "errorClassifier.auth_invalid"),
      technicalMessage: sanitized,
      shouldFallback: true,
    };
  }
  if (
    lower.includes("cli exited with code") ||
    lower.includes("process exited with code") ||
    lower.includes("child process exited") ||
    lower.includes("subprocess exited")
  ) {
    return {
      category: "server_error",
      httpStatus: 502,
      userMessage: msg("AI 执行进程异常退出，正在尝试自动恢复", "errorClassifier.server_error"),
      technicalMessage: sanitized,
      shouldFallback: true,
    };
  }
  if (
    lower === "load failed" ||
    lower.includes("failed to load") ||
    lower.includes("url content") ||
    lower.includes("unsupported url") ||
    lower.includes("unable to access url")
  ) {
    return {
      category: "web_content_unavailable",
      httpStatus: 422,
      userMessage: msg("外部链接内容读取失败。微信文章这类页面经常需要登录或被防抓取，请把正文粘贴进来，或截图/导出后发给我，我再按参考文章重写。", "errorClassifier.web_content_unavailable"),
      technicalMessage: sanitized,
      shouldFallback: false,
    };
  }
  if (rawMessage.includes("SSE_CHUNK_TIMEOUT")) {
    // provider 流式响应中途死寂（干完活没发结束信号 / 连接僵死）。按可恢复处理：切下一个模型续。
    return {
      category: "timeout",
      httpStatus: 504,
      userMessage: msg("当前模型响应中断（可能已完成但未正常结束），正在自动切换模型继续", "errorClassifier.stream_stalled"),
      technicalMessage: sanitized,
      shouldFallback: true,
    };
  }
  if (lower.includes("timeout") || lower.includes("aborted") || lower.includes("timed out")) {
    return {
      category: "timeout",
      httpStatus: 504,
      userMessage: msg("请求超时，请检查网络或稍后重试", "errorClassifier.timeout"),
      technicalMessage: sanitized,
      shouldFallback: true,
    };
  }
  if (
    lower.includes("econnrefused") ||
    lower.includes("enotfound") ||
    lower.includes("fetch failed") ||
    lower.includes("network")
  ) {
    return {
      category: "network",
      httpStatus: 502,
      userMessage: msg("网络连接失败，请检查网络或 Base URL 配置", "errorClassifier.network"),
      technicalMessage: sanitized,
      shouldFallback: true,
    };
  }

  // 修复（2026-07-05）：链上所有模型都在冷却中时的裸错误，见 chat-fallback.ts。
  // detail 部分（冒号后面）在抛错时已经拼好了中文"模型名（还需 N 分钟）"，这里原样透出，
  // 不重新解析——两边约定好格式即可，不用把冷却状态结构穿两遍。
  if (lower.startsWith("all models are cooling down")) {
    // 注意：detail 里含运行时才知道的模型名/剩余分钟，天生没法走 msg() 那套"静态 zh
    // 兜底 + i18n key"模式（key 查回来的是写死的静态文案，会把这些动态信息盖掉）——
    // 这里直接拼接返回，不接 t()。
    //
    // review F-15 修复（2026-07-13 审查）：之前用 rawMessage.slice(...) 切片 →
    // 未走 sanitize 的 rawMessage 文本会进 userMessage,理论上有 API key 泄漏窗口。
    // 修法：先 sanitize rawMessage，再从 sanitized 文本里取 detail 分段。
    const idx = sanitized.indexOf(":");
    const detail = idx >= 0 ? sanitized.slice(idx + 1).trim() : sanitized;
    // 注意：这个前缀 + 后缀文案是固定格式，`app/src/pages/chat/cooldown-error.ts` 的
    // `parseCooldownCountdownMessage` 靠 `message.includes("所有可用模型目前都在冷却中")`
    // 做实时倒计时 UI 的解析门槛，`COOLDOWN_ENTRY_RE` 再从 detail 里抠出"还需 N 秒/分"的
    // 条目渲染活的倒计时——不能改这个前缀，否则会整个跳过倒计时解析，退化成静态文本。
    // 2026-07-16 review 修复的"quota 耗尽误标还需 1 秒"问题已经在 chat-fallback.ts 的
    // detail 构造那一步修掉了（quota 耗尽的模型现在标"套餐额度已用尽，等待无效"，不含
    // "还需"字样，不会被 COOLDOWN_ENTRY_RE 误抓进倒计时——这样反而是期望行为：真正在
    // 冷却的模型才会出现在活的倒计时里，quota 耗尽的模型不会被倒计时结束后误判成"可以
    // 重试了"）。
    return {
      category: "all_models_cooling",
      httpStatus: 503,
      userMessage: `所有可用模型目前都在冷却中：${detail}。倒计时结束后可以继续发送`,
      technicalMessage: sanitized,
      shouldFallback: false,
    };
  }

  // 修复（2026-07-02）：chat-fallback.ts 撞到自动续跑上限/finishReason异常时抛的裸错误，
  // 只有在链上最后一个模型也失败时才会抛出（前面的模型已经全部试过），所以不用 shouldFallback。
  if (lower.includes("truncated after") && lower.includes("automatic continuations")) {
    // C 档第1/5步（2026-07-12）：finishReason 正常（stop/end_turn）但可见正文为空/只有
    // 未闭合思考块，反复重试仍拿不到内容——这跟"length/步数截断反复重试仍失败"是两种
    // 不同的故事，该给用户的建议也不一样（换问法 vs 拆任务），所以单独识别。
    if (lower.includes("reason: empty_response")) {
      return {
        category: "tool_budget_exhausted",
        httpStatus: 500,
        userMessage: msg(
          "模型这轮反复没有产出有效内容（可能思考到一半就停了），已自动重试多次仍未成功。建议换个问法，或切换其他模型试试",
          "errorClassifier.empty_response_exhausted",
        ),
        technicalMessage: sanitized,
        shouldFallback: false,
      };
    }
    return {
      category: "tool_budget_exhausted",
      httpStatus: 500,
      userMessage: msg(
        "这轮任务需要的步骤比较多，没能在预算内跑完。建议把任务拆成更小的步骤分开说，或者换个模型试试",
        "errorClassifier.tool_budget_exhausted",
      ),
      technicalMessage: sanitized,
      shouldFallback: false,
    };
  }
  if (lower.includes("ended abnormally")) {
    return {
      category: "tool_budget_exhausted",
      httpStatus: 500,
      userMessage: msg(
        "模型这轮没能正常结束回复，可能是任务太复杂或触发了重复调用保护。建议把任务拆成更小的步骤分开说",
        "errorClassifier.tool_budget_exhausted",
      ),
      technicalMessage: sanitized,
      shouldFallback: false,
    };
  }

  // C 档第5步（2026-07-12）：落到 unknown 说明现有 provider 规则表（provider-error-rules.ts）
  // 没识别出这条错误——之前这种情况原始报文直接丢失，只能靠用户截图反馈才知道要补规则，
  // 跟本文件开头写的"probe 脚本探测后回填"工作流对不上（没有报文就没法回填）。这里只是
  // 留痕，不代表分类结果本身变了（分类仍然是 unknown/shouldFallback:false，行为不变）。
  if (providerType) {
    console.warn(
      `[error-classifier] 未识别的 provider 错误（可作为 probe 数据回填 provider-error-rules.ts）: ` +
        `provider=${providerType} statusCode=${statusCode ?? "N/A"} message=${sanitized}`,
    );
  }

  return {
    category: "unknown",
    httpStatus: 500,
    userMessage: msg("对话失败，请稍后重试", "errorClassifier.unknown"),
    technicalMessage: sanitized,
    shouldFallback: false, // 保守：unknown 多半是 bug，不浪费 fallback 配额
  };
}

/**
 * 公共 type guard：检查 unknown error 是否是 classifyLlmError 包装的结构化错误
 * 给路由层 catch 后转 HTTP response 用
 */
export function asClassifiedError(error: unknown): ClassifiedLlmError | null {
  if (
    error &&
    typeof error === "object" &&
    "category" in error &&
    "httpStatus" in error &&
    "userMessage" in error &&
    "shouldFallback" in error
  ) {
    return error as ClassifiedLlmError;
  }
  return null;
}
