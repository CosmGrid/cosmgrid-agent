// chat-fallback 的单模型单次调用逻辑（CLI/API 双路径），从 chat-fallback.ts 的
// streamWithFallback 内部嵌套函数 runAttempt 拆出（2026-07-09）。这是原文件里最大、
// 也最自成一体的一块——它只负责"对着一个 ModelEndpoint 跑一次"，完全不碰外层 fallback
// 循环的聚合状态（models 数组遍历、usedIndex、aggregateUsage 等），提出来对行为零影响，
// 只是把闭包捕获的 callbacks/options 改成显式参数。

import { streamText, stepCountIs, type ModelMessage } from "ai";
import { cliSessions } from "../db";
import { getLanguageModel } from "./provider-factory";
import { classifyLlmError } from "./error-classifier";
import { isCliProviderType, type CliMessage } from "./cli-protocol";
import { streamViaCli } from "./cli-engine";
import { detectDoomLoop, type StepToolCall } from "./harness/doom-loop";
import { sanitizePseudoToolHistory } from "./harness/sanitize-history";
import { resolveMaxOutputTokens } from "./model-limits";
import { isNormalFinishReason, isRecoverableTruncation } from "./finish-reason";
import type { ChatMsg } from "./context-compressor";
import type { ModelEndpoint, StreamCallbacks, StreamUsage, StreamWithFallbackOptions } from "./chat-fallback-types";
import { classifyStructuredParts } from "@/lib/security-invariants/web-fetch-privacy";

/** 单次模型调用需要用到的回调子集——onSwitched/onUsage/onFinalToolCalls/onInvocationAudit
 *  属于外层 fallback 循环的编排结果，不该也不会被单次 attempt 触发。 */
type AttemptCallbacks = Pick<StreamCallbacks, "onDelta" | "onStatus" | "onResolvedModel" | "onRecovered">;

export interface ModelAttemptResult {
  streamUsage: StreamUsage;
  finishReason: string;
  wasAborted: boolean;
  partialText: string;
  toolCalls: StepToolCall[];
  /** 本轮真实产出的结构化 ModelMessage（assistant 的 tool-call 部件 + tool 角色的结果消息 + 最终文字）。
   *  这是「结构化工具历史」修复的真相源：落库到 messages.parts，下一轮原样回放，弱模型就不会
   *  因为看到「散文压平的历史」而照着编造（对照实验见 harness/sanitize-history.ts 头注释）。
   *  CLI 路径为 undefined（claude/codex 自带协议，我们只拿到文字，无结构可存 → 回放退化回文本）。 */
  responseMessages?: ModelMessage[];
  /** 本次调用实际跑了多少个 AI SDK step（含没有工具调用的纯文字 step）。CLI 路径恒为 0
   *  （不走 stepCountIs）。用于判断"是否把 maxToolSteps 步数预算耗尽"——注意 AI SDK 的
   *  stopWhen: stepCountIs(N) 只有边界那一步恰好还在调工具时，finishReason 才会报
   *  "tool-calls"；如果边界那一步模型自己选择只写文字，finishReason 会正常报 "stop"，
   *  看起来跟真收尾一样。所以不能靠 finishReason 字符串判断是否撞了步数上限，必须
   *  数真实 step 数（见 chat-fallback.ts 的 stepBudgetTruncated 判定）。 */
  stepCount: number;
}

/**
 * 把 ChatMsg[] 里的多条 system 消息抽出来合并成一个字符串，剩下的对话消息（user/assistant）
 * 单独返回，供 API 路径用 AI SDK 的 `system` 参数发送。
 *
 * 为什么（2026-07-16 工程化根因修复）：Vercel AI SDK 官方明确警告"不要把 system 消息塞进
 * messages 数组，要用 system 参数"（既有 prompt injection 安全风险，也是非标准用法）。
 * 我们上游 buildChatPromptMessages 一直产出 10+ 条并排的 {role:"system"} 塞进 messages——
 * dump 真实请求体证实发给模型的是 system×N → user 的畸形序列。Claude/GPT 容错强能扛，但
 * MiniMax-M3 等国内 reasoning 模型的 chat template 渲染连续多条 system 时会退化，第一个
 * token 就吐轮次控制特殊 token（如 <|user_mask|>）然后 stop，连工具都来不及调用。
 *
 * 隔离性：只在"发给模型前的最后一步"做这个打包转换。上游的 prompt 组装、上下文压缩、
 * 记忆注入、工具挂载、消息持久化全部不受影响——它们照旧产出/处理含 system 的 ChatMsg[]，
 * 这里只把最终要发出去的 system 从 messages 数组挪到标准的 system 参数。CLI 路径不用这个
 * （claude/codex 自带协议，见下方 isCliProviderType 分支）。
 */
export function splitSystemFromMessages(messages: ChatMsg[]): {
  system: string | undefined;
  rest: ModelMessage[];
} {
  const systemTexts: string[] = [];
  const rest: ModelMessage[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      // system 的 content 正常是纯字符串；防御性处理数组型 content（跟 CLI 路径同款折叠）。
      systemTexts.push(
        typeof m.content === "string"
          ? m.content
          : m.content.filter((p) => p.type === "text").map((p) => ("text" in p ? p.text : "")).join(""),
      );
    } else if (m.role === "assistant" && m.parts && m.parts.length > 0) {
      // 结构化工具历史：展开真实的 assistant(tool-call)/tool(result)/文字序列回放，
      // 而不是把整轮压平成一条 content 散文——这是弱模型不再照散文编造的关键（探针 C 证明）。
      const classified = classifyStructuredParts(JSON.stringify(m.parts));
      if (classified.status === "safe") rest.push(...m.parts);
    } else {
      rest.push({ role: m.role, content: m.content } as ModelMessage);
    }
  }
  const system = systemTexts.length > 0 ? systemTexts.join("\n\n") : undefined;
  return { system, rest };
}

/**
 * 对着一个 ModelEndpoint 跑一次调用（CLI 或 API，按 target.providerType 分流）。
 * - CLI 路径：spawn 本机 claude/codex，遇到可恢复截断会原生 resume 一次
 * - API 路径：Vercel AI SDK streamText，多步 agentic 工具调用 + doom-loop 检测
 */
export async function runModelAttempt(
  target: ModelEndpoint,
  attemptMessages: ChatMsg[],
  callbacks: AttemptCallbacks,
  options: StreamWithFallbackOptions,
  // 同一模型跨续接批次累积的工具调用历史，只用于 doom-loop 判定（不计入本次返回的
  // toolCalls/streamUsage，避免外层 aggregateUsage 重复计数）。不传时默认空数组，
  // doom-loop 退化成"仅本批内检测"，跟改造前行为一致。
  priorToolCalls: StepToolCall[] = [],
): Promise<ModelAttemptResult> {
  let partialText = "";

  // 发送前最后一站：清洗历史 assistant 消息里的「文本假工具调用」（弱模型如 MiniMax-M3
  // 会照抄历史里的假标签并开始编造，见 harness/sanitize-history.ts 的对照实验说明）。
  // 只清发给模型的副本，UI 显示/存库/防幻觉判定都用外层原始 attemptMessages，不受影响。
  // realToolNames 取本轮真实注册的工具名，把 <read>/<hashline_edit> 这种「真名被演成文本」
  // 的情况也一起清掉。对干净历史是恒等（返回同一数组引用），Claude/GPT 等强模型零影响。
  const realToolNames = options.tools ? Object.keys(options.tools) : [];
  const sanitizedMessages = sanitizePseudoToolHistory(attemptMessages, realToolNames);

  if (isCliProviderType(target.providerType)) {
    // CLI 引擎路径：spawn 本机 claude/codex 吃订阅额度（baseUrl 复用为可执行文件路径）
    // CLI 不支持图片——带图消息的 chain 已在 ChatPage 过滤掉 CLI 端点；这里防御性把数组 content 折叠成纯文本
    const cliMessages: CliMessage[] = sanitizedMessages.map((m) => ({
      role: m.role as "user" | "assistant" | "system",
      content:
        typeof m.content === "string"
          ? m.content
          : m.content.filter((p) => p.type === "text").map((p) => ("text" in p ? p.text : "")).join(""),
    }));
    let officialSessionId: string | null = null;
    const persistCliSession = (sessionId: string, status: "active" | "completed" | "failed") => {
      void cliSessions.upsert({
        providerType: target.providerType as "claude-cli" | "codex-cli",
        conversationId: options.conversationId ?? null,
        projectId: options.projectId ?? null,
        officialSessionId: sessionId,
        modelName: target.modelName,
        program: target.baseUrl ?? null,
        status,
      }).catch(() => {});
    };
    const runCli = async (
      resumeSessionId?: string | null,
    ): Promise<{
      finishReason: string;
      wasAborted: boolean;
      inputTokens: number;
      outputTokens: number;
      officialSessionId: string | null;
      actualModelName: string | null;
    }> => {
      const cliResult = await streamViaCli(
        {
          providerType: target.providerType as "claude-cli" | "codex-cli",
          modelName: target.modelName,
          ...(target.baseUrl ? { program: target.baseUrl } : {}),
          ...(target.workingDirectory ? { workingDirectory: target.workingDirectory } : {}),
        },
        cliMessages,
        {
          onDelta: (delta) => {
            partialText += delta;
            callbacks.onDelta(delta);
          },
          onSession: (sessionId) => {
            officialSessionId = sessionId;
            persistCliSession(sessionId, "active");
          },
          onStatus: callbacks.onStatus,
          onModel: (modelName) => callbacks.onResolvedModel?.(modelName, target),
        },
        {
          ...(options.signal ? { signal: options.signal } : {}),
          ...(options.cliAccess ? { access: options.cliAccess } : {}),
          ...(resumeSessionId
            ? {
                resumeSessionId,
                resumePrompt: "Continue from where you stopped. Do not repeat completed content.",
              }
            : {}),
        },
      );
      if (cliResult.officialSessionId) {
        officialSessionId = cliResult.officialSessionId;
      }
      return {
        finishReason: cliResult.finishReason,
        wasAborted: cliResult.finishReason === "abort" || (options.signal?.aborted ?? false),
        inputTokens: cliResult.inputTokens,
        outputTokens: cliResult.outputTokens,
        officialSessionId,
        actualModelName: cliResult.actualModelName,
      };
    };
    try {
      const cliResult = await runCli();
      let totalInputTokens = cliResult.inputTokens;
      let totalOutputTokens = cliResult.outputTokens;
      let finishReason = cliResult.finishReason;
      let wasAborted = cliResult.wasAborted;
      if (
        !wasAborted &&
        officialSessionId &&
        isRecoverableTruncation(finishReason)
      ) {
        callbacks.onRecovered?.("native_resume");
        const resumed = await runCli(officialSessionId);
        totalInputTokens += resumed.inputTokens;
        totalOutputTokens += resumed.outputTokens;
        finishReason = resumed.finishReason;
        wasAborted = resumed.wasAborted;
      }
      if (officialSessionId) {
        persistCliSession(officialSessionId, isNormalFinishReason(finishReason) ? "completed" : "failed");
      }
      return {
        finishReason,
        wasAborted,
        partialText,
        toolCalls: [],
        stepCount: 0,
        streamUsage: {
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
          toolCallCount: 0,
        },
      };
    } catch (error) {
      // 修复（2026-07-07，用户实测发现）：原来这个 error 只用来取 sessionId，从没打印过就
      // 直接丢了——如果紧接着的 resume 重试成功，原始失败原因永远无法追溯；如果 resume
      // 也失败，resume 自己的失败原因还会在下面的空 catch 里被再丢一次，最终往上抛的是
      // 第一次的 error，两次真实失败原因全部沉默消失，devtools 里连个痕迹都没有。
      console.error("[cli-engine] 首次调用失败，尝试 native resume", error);
      const firstErrorDetail = classifyLlmError(error).technicalMessage || undefined;
      const sessionId =
        (error as { officialSessionId?: string | null })?.officialSessionId ?? officialSessionId;
      if (sessionId && !(options.signal?.aborted ?? false)) {
        try {
          callbacks.onRecovered?.("native_resume", firstErrorDetail);
          const resumed = await runCli(sessionId);
          persistCliSession(sessionId, isNormalFinishReason(resumed.finishReason) ? "completed" : "failed");
          return {
            finishReason: resumed.finishReason,
            wasAborted: resumed.wasAborted,
            partialText,
            toolCalls: [],
            stepCount: 0,
            streamUsage: {
              inputTokens: resumed.inputTokens,
              outputTokens: resumed.outputTokens,
              toolCallCount: 0,
            },
          };
        } catch (resumeError) {
          console.error("[cli-engine] native resume 重试也失败", resumeError);
          persistCliSession(sessionId, "failed");
        }
      }
      if (typeof error === "object" && error !== null) {
        (error as { __partialText?: string }).__partialText = partialText;
      }
      throw error;
    }
  }

  // API 直连路径：Vercel AI SDK streamText
  const lm = getLanguageModel(target.providerType, target.modelName, target.apiKey, target.baseUrl);
  const localAbort = new AbortController();
  const onParentAbort = () => localAbort.abort();
  // 2026-07-15 review 修复：AbortSignal 的 'abort' 事件只在真正 abort 的那一刻广播一次——
  // 续接场景下（撞步数上限后 continue 到下一次 runModelAttempt），如果用户点停止的时机
  // 刚好卡在两次 attempt 之间，这里注册监听器时 options.signal 可能已经 aborted 过了，
  // 单纯 addEventListener 会永远错过那个已经发生的事件，本次 attempt 会无视停止请求一路
  // 跑到自然结束。先补查一次已 aborted 的情况，直接同步触发，再继续监听后续的 abort。
  if (options.signal?.aborted) {
    onParentAbort();
  }
  options.signal?.addEventListener("abort", onParentAbort);
  const stepToolCalls: StepToolCall[] = [];
  let stepCount = 0;

  try {
    // 2026-07-16 工程化根因修复：把多条 system 消息从 messages 数组抽出、合并成标准的
    // system 参数（见 splitSystemFromMessages 注释）。修复 MiniMax-M3 等模型收到 system×N
    // 畸形序列时退化吐 <|user_mask|> 特殊 token、连工具都调不了的问题。
    const { system, rest } = splitSystemFromMessages(sanitizedMessages);
    const result = streamText({
      model: lm,
      ...(system ? { system } : {}),
      messages: rest,
      maxOutputTokens: options.maxOutputTokens ?? resolveMaxOutputTokens(target.modelName),
      maxRetries: 3,
      ...(options.tools ? {
        tools: options.tools,
        toolChoice: options.toolChoice ?? "auto",
        stopWhen: stepCountIs(options.maxToolSteps ?? 20),
        onStepFinish: (event) => {
          stepCount++;
          const calls = (event.toolCalls ?? []) as { toolName: string; input: unknown }[];
          for (const tc of calls) {
            stepToolCalls.push({ toolName: tc.toolName, input: tc.input });
          }
          // 修复（doom-loop 跨批失明）：stepToolCalls 只是本批（单次 runModelAttempt）内的
          // 调用记录，撞 stepCountIs 上限续接后会重新调用 runModelAttempt、本地数组清零重来
          // ——原来的写法会让 doom-loop 只在单批 12 步以内生效，续接之后完全失去空转检测能力。
          // 拼上调用方传入的跨批历史，让判定覆盖整个模型调用链，不受续接边界影响。
          if (detectDoomLoop([...priorToolCalls, ...stepToolCalls])) localAbort.abort();
        },
      } : {}),
      abortSignal: localAbort.signal,
    });

    // C 档第2步（2026-07-12）：改读 fullStream 而不是只读 textStream。
    // 关键发现：AI SDK 的 textStream getter 只过滤 part.type==="text-delta"
    // （node_modules/ai/dist/index.mjs:8102-8114），reasoning-delta 会被直接丢弃——
    // 对走结构化 reasoning 通道的 provider（如 DeepSeek 的 reasoning_content 映射），
    // 旧代码不是"思考没显示"，是思考内容彻底丢失、完全不落 partialText，
    // response-completeness.ts 的完整性判定也看不到它。
    // 这里把 reasoning-delta 重新包一层 <think> 标签喂给 onDelta，跟现有
    // parse-thinking.ts 的折叠渲染、response-completeness.ts 的可见正文判定无缝衔接，
    // 不用改 UI 渲染层或消息持久化层。MiniMax-M3 这类把 <think> 内联在纯文本里发的
    // 模型走的仍是 text-delta，不受影响（标签已经在文本里，原样透传）。
    let reasoningOpen = false;
    for await (const part of result.fullStream) {
      if (part.type === "text-delta") {
        let chunk = part.text;
        if (reasoningOpen) {
          // 防御性收尾：正常情况下 provider 会先发 reasoning-end 再发 text-delta，
          // 这里兜底万一 provider 没规规矩矩发 reasoning-end 就直接开始吐正文。
          chunk = `</think>${chunk}`;
          reasoningOpen = false;
        }
        partialText += chunk;
        callbacks.onDelta(chunk);
      } else if (part.type === "reasoning-delta") {
        if (!part.text) continue; // 部分 provider 会吐空字符串占位，不产出可见内容
        const chunk = reasoningOpen ? part.text : `<think>${part.text}`;
        reasoningOpen = true;
        partialText += chunk;
        callbacks.onDelta(chunk);
      } else if (part.type === "reasoning-end") {
        if (reasoningOpen) {
          partialText += "</think>";
          callbacks.onDelta("</think>");
          reasoningOpen = false;
        }
      } else if (part.type === "error") {
        // fullStream 用专门的 "error" part 传递流内错误（不像 textStream 那样直接让
        // for-await 抛异常）——原样 throw，交给下面既有的 catch 分支处理，
        // 保持 classifyLlmError/__partialText 兜底逻辑完全不变。
        throw part.error;
      }
    }

    const usage = await result.usage;
    const finishReason = (await result.finishReason) ?? "stop";
    // 结构化工具历史真相源：AI SDK 把本轮 agentic 循环里所有真实的 assistant(tool-call) /
    // tool(result) / assistant(text) 消息按序放在 response.messages（同一份喂回下一轮就是 API
    // 认的标准结构）。落库到 messages.parts 供下一轮结构化回放。
    // 防御式：这是增强项，取不到（provider/SDK 未暴露 response）就退化回文本回放，绝不炸本轮回答。
    let responseMessages: ModelMessage[] = [];
    try {
      responseMessages = ((await result.response)?.messages ?? []) as ModelMessage[];
    } catch {
      responseMessages = [];
    }
    return {
      finishReason,
      wasAborted: localAbort.signal.aborted || (options.signal?.aborted ?? false),
      partialText,
      toolCalls: stepToolCalls,
      responseMessages,
      stepCount,
      streamUsage: {
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        cacheReadInputTokens:
          usage?.inputTokenDetails?.cacheReadTokens ?? usage?.cachedInputTokens ?? 0,
        cacheWriteInputTokens:
          usage?.inputTokenDetails?.cacheWriteTokens ?? 0,
        toolCallCount: stepToolCalls.length,
      },
    };
  } catch (error) {
    if (typeof error === "object" && error !== null) {
      (error as { __partialText?: string }).__partialText = partialText;
    }
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", onParentAbort);
  }
}
