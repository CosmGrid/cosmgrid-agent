// 运行时回退链触发（v0.4.1 重构版）
// 把"主模型失败 → 自动切 fallback"逻辑抽出来，ChatPage 和 StageChat 共用。
//
// v0.4.1 重构：换成 models 数组支持 N 步 fallback 链、onSwitched 用 SwitchReason
// 类型（不再假报 rate_limit）、shouldFallback 决策从 ClassifiedLlmError 拿、
// 内置 recordUsageEvent 避免调用方写错 modelName/providerId、抽 toModelEndpoint
// builder 消除 4 处 provider.type guard。
//
// 2026-07-09 二次重构（拆热点文件，719→约300行）：原来堆在一个文件里的类型定义
// （ModelEndpoint/StreamUsage/SwitchReason/StreamCallbacks/toModelEndpoint）拆到
// chat-fallback-types.ts；单模型单次调用的 CLI/API 双路径逻辑（原 runAttempt 嵌套
// 函数）拆到 chat-fallback-attempt.ts；纯辅助函数拆到 chat-fallback-recovery.ts。
// 本文件只保留 streamWithFallback 的 fallback 链编排主循环。所有类型/函数继续从本
// 文件 re-export，7 个既有消费者（chain-runner.ts/useChatStream.ts 等）的 import
// 路径和符号完全不变，零改动。
//
// 设计决策：
// 1. 保留流式体验：主模型失败时自动切 fallback；如果已经流出部分内容，
//    会把已输出片段放回上下文，要求下一个模型从中断处继续、不要重复。
// 2. 哪些错误触发 fallback：401/403/404/429/超时/网络/5xx → 切；
//    context_overflow（413 / 上下文超长）→ 不切（换模型也救不了，让用户知道要压缩历史）；
//    unknown → 不切（保守，避免浪费 fallback 配额）。
// 3. cooldown 熔断：模型刚失败过就先跳过（见 model-cooldown.ts）。
// 4. onSwitched 用 SwitchReason（discriminated union）区分"出错切"和"cooldown 跳过"，
//    不再混用 LlmErrorCategory。
// 5. 链式调用：models 数组按顺序尝试，跳过 cooldown 的，遇到非 shouldFallback 的错就终止。

import { classifyLlmError } from "./error-classifier";
import { hydrateModelCooldowns, isInCooldown, markModelFailed, markModelSucceeded, getCooldownRemainingMs } from "./model-cooldown";
import { recordUsageEvent, type RecordUsageParams } from "./usage-tracker";
import { runModelAttempt } from "./chat-fallback-attempt";
import { buildRecoveryMessages, getPartialTextFromError, inferRole } from "./chat-fallback-recovery";
import { buildLlmInvocationAuditEvent } from "./invocation-audit";
import { ensureModelLimitsLoaded } from "./model-limits";
import { hydrateMessageRouterMarkers } from "./message-router";
import { hydrateIntentActionMarkers } from "@/lib/workflow/semantic-intent-router";
import { hydrateProviderErrorRules } from "@/lib/policy/provider-error-rules";
import { hydrateUserTierBaseline } from "@/lib/policy/user-tier-baseline";
import { hydrateDebateMarkers } from "@/lib/policy/debate-markers";
import { isNormalFinishReason, isRecoverableTruncation, isToolStepTruncation } from "./finish-reason";
import { hasEffectiveOutput } from "./response-completeness";
import type { StepToolCall } from "./harness/doom-loop";
import type { ChatMsg } from "./context-compressor";
import {
  toModelEndpoint,
  type ModelEndpoint,
  type StreamCallbacks,
  type StreamUsage,
  type StreamWithFallbackOptions,
  type SwitchReason,
} from "./chat-fallback-types";

export { toModelEndpoint };
export type { ModelEndpoint, StreamCallbacks, StreamUsage, StreamWithFallbackOptions, SwitchReason };

// 文字截断（length/max_tokens/empty_response 等）专用：模型在这句话上就是卡住了，
// 续接 2 次还写不完大概率是模型能力问题，继续放行没意义。
const MAX_AUTO_CONTINUATIONS = 2;

// 工具步数截断（finishReason=tool-calls，撞 stopWhen 步数上限）专用：这只是长任务的
// 正常中途状态，不该占用给文字截断设计的"续接批次数"预算——真正防失控的是下面这两条
// "总量"红线（总工具调用数 / 总耗时），而不是续接了几批。空转/死循环由 doom-loop 单独兜底
// （见 chat-fallback-attempt.ts 的跨批 stepToolCalls 拼接）。
const MAX_TOOL_STEP_TOTAL_CALLS = 150;
const MAX_TOOL_STEP_TOTAL_DURATION_MS = 10 * 60 * 1000;

// 假收尾（撞满 maxToolSteps 步数预算，但边界那一步模型自己选择只写文字）专用安全阀：
// 这类续接批次可能 0 工具调用，不会推高 aggregateUsage.toolCallCount，光靠上面两条
// 总量红线不够保险（2026-07-13 真实事故：真人复核方案时指出的漏洞），单独限最多续接几次。
const MAX_STEP_BUDGET_CONTINUATIONS = 2;

function formatCooldownRemainingMs(ms: number): string {
  const totalSeconds = Math.max(1, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0 && seconds > 0) return `${minutes} 分 ${seconds} 秒`;
  if (minutes > 0) return `${minutes} 分钟`;
  return `${seconds} 秒`;
}

/**
 * 流式对话，按顺序尝试 models 中的每一个端点。
 * - 跳过在 cooldown 中的模型
 * - 出错时按错误分类决定是否尝试下一个：shouldFallback=true 才跳；否则抛错
 * - 中途 abort（AbortSignal）→ 不写 usage，标记 interrupted
 * - 自动写 UsageEvent（解决调用方把 fallback 调用错记成 primary 的 latent bug）
 *
 * @param models 按优先级排序的模型链（必须至少 1 个）。fallback 写在后面。
 * @returns 最后成功调用的 modelId；如果切过，switched=true
 */
export async function streamWithFallback(
  models: ModelEndpoint[],
  messages: ChatMsg[],
  callbacks: StreamCallbacks,
  options: StreamWithFallbackOptions = {},
): Promise<{ usedModelId: string; switched: boolean }> {
  if (models.length === 0) {
    throw new Error("streamWithFallback: models array cannot be empty");
  }

  // 预热 models.dev 输出上限表（幂等、不阻塞本轮）。首轮没拉到就用 CEILING 兜底，下轮起精确 clamp。
  void ensureModelLimitsLoaded();
  // 预热引擎化 marker 表 + provider 错误规则（幂等、不阻塞本轮）。builtin 是安全兜底，
  // distribution override 缺失时行为不变。必须 .catch：resolve 失败（如测试环境无 DB）时保持
  // builtin，不能冒泡成 unhandled rejection。
  void hydrateMessageRouterMarkers().catch(() => {});
  void hydrateIntentActionMarkers().catch(() => {});
  void hydrateProviderErrorRules().catch(() => {});
  void hydrateUserTierBaseline().catch(() => {});
  void hydrateDebateMarkers().catch(() => {});
  await hydrateModelCooldowns(models.map((m) => m.modelId)).catch(() => {});

  // D4：额度熔断。先解析守卫得到"额度已耗尽"的 modelId 集合（与 cooldown 是两套独立事实）。
  // 必须在 skip 循环之前拿到——cooldown 和 quota 两个条件要在同一个循环里逐个候选交替判定。
  const exhaustedSet = options.quotaGuard
    ? new Set(await options.quotaGuard.getExhaustedModelIds())
    : new Set<string>();

  // 跳过 cooldown 中 / 额度已耗尽的模型：从前往后找第一个两者都不占的。
  // 注意：cooldown 和 quota 必须在同一个循环里对每个候选逐个判定，不能分两个独立循环各自
  // 跳完——2026-07-15 review 抓到的 bug：分两个循环时，quota 循环把 startIdx 推到的新模型
  // 从未做过 cooldown 检查（cooldown 检查只覆盖了最开始那段连续前缀），会导致最终选中一个
  // 实际仍在 cooldown 的模型去真实请求，cooldown 熔断形同虚设。
  let startIdx = 0;
  while (startIdx < models.length) {
    const candidate = models[startIdx]!;
    const inCooldown = isInCooldown(candidate.modelId);
    const quotaExhausted = !inCooldown && exhaustedSet.has(candidate.modelId);
    if (!inCooldown && !quotaExhausted) break;

    const skipped = candidate;
    const skippedAt = Date.now();
    const status = inCooldown ? "cooldown" : "quota_exhausted";
    callbacks.onInvocationAudit?.(buildLlmInvocationAuditEvent({
      target: skipped,
      status,
      startedAtMs: skippedAt,
      endedAtMs: skippedAt,
      finishReason: status,
    }));
    if (startIdx < models.length - 1) {
      const next = models[startIdx + 1]!;
      callbacks.onSwitched?.(skipped, next, { kind: inCooldown ? "cooldown" : "quota" });
    }
    startIdx++;
  }
  if (startIdx >= models.length) {
    const anyCooldown = models.some((m) => isInCooldown(m.modelId));
    if (!anyCooldown) {
      // 没有模型处于 cooldown，纯粹是额度都耗尽：抛清晰错误（与 cooldown 分开），
      // 让 UI 清掉"进行中"状态、提示续费/换套餐。
      const detail = models.map((m) => m.displayLabel ?? m.modelName).join("、");
      throw new Error(`All models exhausted quota: ${detail}`);
    }
    // 修复（2026-07-05）：之前这里直接抛裸英文 Error，classifyLlmError 认不出来只能落进
    // "unknown"兜底——用户只看到一句生硬的英文提示，不知道具体哪几个模型在冷却、还要
    // 等多久，也不知道重启 app 能立即清空（冷却状态只在内存里，见 model-cooldown.ts）。
    // 这里把每个模型的剩余冷却时间拼进消息，error-classifier.ts 按前缀识别后原样透出。
    //
    // 2026-07-16 review 修复：上面这个 map 之前对 models 里所有模型（不区分 cooldown /
    // quota_exhausted）都调 formatCooldownRemainingMs——quota 耗尽的模型根本不在
    // cooldown 状态表里，getCooldownRemainingMs 对它们返回 0，formatCooldownRemainingMs
    // 又用 Math.max(1, ...) 保底成"还需 1 秒"，误导用户以为等一下就能用，实际上是套餐
    // 额度用完，永远不会自己恢复。这条 throw 只在 anyCooldown 为真时才会走到（见上面
    // if 分支），而上面的 skip 循环保证走到这里的 models 里，每一个要么在 cooldown、
    // 要么 quota 已耗尽（两者互斥），所以按 isInCooldown 分开两种文案。
    const detail = models
      .map((m) => {
        const label = m.displayLabel ?? m.modelName;
        if (isInCooldown(m.modelId)) {
          const remaining = formatCooldownRemainingMs(getCooldownRemainingMs(m.modelId));
          return `${label}（还需 ${remaining}）`;
        }
        return `${label}（套餐额度已用尽，等待无效）`;
      })
      .join("、");
    throw new Error(`All models are cooling down: ${detail}`);
  }

  function recordUsageEventOnly(args: {
    target: ModelEndpoint;
    usage: StreamUsage;
    finishReason: string;
    startedAt: number;
  }): void {
    const params: RecordUsageParams = {
      modelId: args.target.modelId,
      modelName: args.target.modelName,
      providerType: args.target.providerType,
      providerId: args.target.providerId,
      apiCredentialId: args.target.apiCredentialId,
      usage: {
        inputTokens: args.usage.inputTokens,
        outputTokens: args.usage.outputTokens,
        cacheReadInputTokens: args.usage.cacheReadInputTokens,
        cacheWriteInputTokens: args.usage.cacheWriteInputTokens,
      },
      finishReason: args.finishReason,
      interrupted: false,
      latencyMs: Date.now() - args.startedAt,
    };
    if (options.projectId) params.projectId = options.projectId;
    if (options.conversationId) params.conversationId = options.conversationId;
    params.role = options.role ?? inferRole(messages);
    if (options.actorRole !== undefined) params.roleKind = options.actorRole;
    if (options.routingDecision) params.routingDecision = options.routingDecision;
    if (options.compressionStats) params.compressionStats = options.compressionStats;
    void recordUsageEvent(params);
  }

  function recordFinalUsage(args: {
    target: ModelEndpoint;
    usage: StreamUsage;
    finishReason: string;
    startedAt: number;
  }): void {
    callbacks.onUsage?.(args.usage, args.target, args.finishReason, false);
    recordUsageEventOnly(args);
  }

  let usedIndex = startIdx;
  let activeMessages = messages;
  let aggregateUsage: StreamUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheWriteInputTokens: 0,
    toolCallCount: 0,
  };
  let aggregateToolCalls: StepToolCall[] = [];
  // 整条链（含所有续接批次）的起始时间，用于工具步数截断的总耗时红线。
  const chainStartedAt = Date.now();

  while (usedIndex < models.length) {
    const target = models[usedIndex]!;
    const modelStartedAt = Date.now();

    if (options.signal?.aborted) {
      return { usedModelId: target.modelId, switched: usedIndex !== 0 };
    }

    let continuationsForThisModel = 0;
    // 假收尾续接次数（见下面 stepBudgetTruncated），独立于 continuationsForThisModel，
    // 换模型时清零。
    let stepBudgetContinuations = 0;
    // 当前模型跨续接批次累积的工具调用历史，只喂给 doom-loop 判定用（见
    // chat-fallback-attempt.ts 的 priorToolCalls 参数），换模型时清零。
    let modelToolCallHistory: StepToolCall[] = [];
    while (true) {
      try {
        const attempt = await runModelAttempt(target, activeMessages, callbacks, options, modelToolCallHistory);
        modelToolCallHistory = [...modelToolCallHistory, ...attempt.toolCalls];
        aggregateUsage.inputTokens += attempt.streamUsage.inputTokens;
        aggregateUsage.outputTokens += attempt.streamUsage.outputTokens;
        aggregateUsage.cacheReadInputTokens =
          (aggregateUsage.cacheReadInputTokens ?? 0) + (attempt.streamUsage.cacheReadInputTokens ?? 0);
        aggregateUsage.cacheWriteInputTokens =
          (aggregateUsage.cacheWriteInputTokens ?? 0) + (attempt.streamUsage.cacheWriteInputTokens ?? 0);
        aggregateUsage.toolCallCount += attempt.streamUsage.toolCallCount;
        aggregateToolCalls.push(...attempt.toolCalls);

        if (attempt.wasAborted) {
          callbacks.onInvocationAudit?.(buildLlmInvocationAuditEvent({
            target,
            status: "aborted",
            startedAtMs: modelStartedAt,
            finishReason: attempt.finishReason,
            usage: aggregateUsage,
          }));
          return { usedModelId: target.modelId, switched: usedIndex !== 0 };
        }

        // C 档第1/3步（2026-07-12）：finishReason 只回答"流断了没"，不回答"有没有真正的
        // 正文"——MiniMax-M3 等模型会出现 finishReason=stop 但内容其实卡在未闭合 <think>
        // 块里、思考写一半就提前收尾的情况（用户实测复现：界面冻结在"进行中"，无任何提示，
        // 落库 success=1）。对齐 opencode/gemini-cli/OMO 的共同做法：把"结束了"和"有有效
        // 内容"拆成两条独立判据，reasoning/思考内容不计入"有效正文"（见 response-completeness.ts）。
        // "空/未闭合思考"和"length 等常规截断"复用同一条续跑通路，不新造机制。
        const contentIncomplete =
          isNormalFinishReason(attempt.finishReason) &&
          !hasEffectiveOutput(attempt.partialText, attempt.streamUsage.toolCallCount);

        // 假收尾判定（2026-07-13 真实故障，真人复核揪出前两版方案的漏洞后重做）：
        // AI SDK 的 stopWhen: stepCountIs(N) 只有边界那一步恰好还在调工具时，finishReason
        // 才会报成 "tool-calls"；如果边界步模型自己选择只写文字，finishReason 会正常报
        // "stop"，看起来跟真收尾一模一样——但其实是步数预算耗尽逼出来的中途假收尾（真实
        // 案例：19 次工具调用后模型写"我把剩下的段落读完再对账"就真的收尾，再无下文）。
        // 不能信 finishReason 字符串，只认 runModelAttempt 回传的真实 stepCount 是否
        // 把这次调用的 maxToolSteps 步数预算耗尽。
        const maxToolSteps = options.maxToolSteps ?? 20;
        const stepBudgetTruncated =
          !contentIncomplete &&
          isNormalFinishReason(attempt.finishReason) &&
          attempt.stepCount >= maxToolSteps;

        const truncationReason = contentIncomplete
          ? "empty_response"
          : stepBudgetTruncated
            ? "tool_step_budget_exhausted"
            : attempt.finishReason;

        if (
          contentIncomplete ||
          stepBudgetTruncated ||
          (!isNormalFinishReason(attempt.finishReason) && isRecoverableTruncation(attempt.finishReason))
        ) {
          // 工具步数截断（撞 stopWhen 上限，模型还想继续干活；含上面新增的"假收尾"场景）
          // 跟文字截断走不同的续接预算：前者按"总工具调用数 / 总耗时"这两条总量红线控制，
          // 不消耗 continuationsForThisModel；后者维持原有"续接 2 次"的批次数上限（模型
          // 在这句话上卡住了，续太多次没意义）。
          const isToolStep =
            !contentIncomplete && (isToolStepTruncation(attempt.finishReason) || stepBudgetTruncated);
          const elapsedMs = Date.now() - chainStartedAt;
          const toolStepWithinBudget =
            isToolStep &&
            aggregateUsage.toolCallCount < MAX_TOOL_STEP_TOTAL_CALLS &&
            elapsedMs < MAX_TOOL_STEP_TOTAL_DURATION_MS &&
            // 假收尾续接批次可能 0 工具调用，不会推高 aggregateUsage.toolCallCount，
            // 上面两条总量红线可能永远不触发——单独再加一道安全阀。
            (!stepBudgetTruncated || stepBudgetContinuations < MAX_STEP_BUDGET_CONTINUATIONS);

          if (toolStepWithinBudget || (!isToolStep && continuationsForThisModel < MAX_AUTO_CONTINUATIONS)) {
            callbacks.onRecovered?.("context_replay");
            activeMessages = buildRecoveryMessages(activeMessages, attempt.partialText, truncationReason);
            if (isToolStep) {
              if (stepBudgetTruncated) stepBudgetContinuations++;
            } else {
              continuationsForThisModel++;
            }
            continue;
          }

          markModelFailed(target.modelId, "abnormal_finish");
          recordUsageEventOnly({
            target,
            usage: aggregateUsage,
            finishReason: truncationReason,
            startedAt: modelStartedAt,
          });
          if (usedIndex >= models.length - 1) {
            // C 档第5步（2026-07-12）：把 truncationReason 带进错误信息里，让
            // error-classifier.ts 能区分"内容为空反复重试仍失败"和"length/步数截断反复
            // 重试仍失败"——这两种对用户该说的话不一样（前者提示"换个问法"，后者提示
            // "任务拆小"），之前两者共用同一句裸英文，词不达意。
            throw new Error(
              isToolStep
                ? `Task exceeded tool-call budget (${aggregateUsage.toolCallCount} calls / ${Math.round(elapsedMs / 1000)}s, reason: ${truncationReason})`
                : `Model output was truncated after ${MAX_AUTO_CONTINUATIONS} automatic continuations (reason: ${truncationReason})`,
            );
          }
          const next = models[usedIndex + 1]!;
          callbacks.onSwitched?.(target, next, { kind: "recovery", reason: truncationReason });
          callbacks.onRecovered?.("fallback_handoff");
          activeMessages = buildRecoveryMessages(activeMessages, attempt.partialText, truncationReason);
          aggregateUsage = {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadInputTokens: 0,
            cacheWriteInputTokens: 0,
            toolCallCount: 0,
          };
          aggregateToolCalls = [];
          usedIndex++;
          break;
        }

        if (!isNormalFinishReason(attempt.finishReason)) {
          markModelFailed(target.modelId, "abnormal_finish");
          recordUsageEventOnly({
            target,
            usage: aggregateUsage,
            finishReason: attempt.finishReason,
            startedAt: modelStartedAt,
          });
          if (usedIndex >= models.length - 1) {
            throw new Error(`Model call ended abnormally: ${attempt.finishReason}`);
          }
          const next = models[usedIndex + 1]!;
          callbacks.onSwitched?.(target, next, { kind: "recovery", reason: attempt.finishReason });
          callbacks.onRecovered?.("fallback_handoff");
          activeMessages = buildRecoveryMessages(activeMessages, attempt.partialText, attempt.finishReason);
          aggregateUsage = {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadInputTokens: 0,
            cacheWriteInputTokens: 0,
            toolCallCount: 0,
          };
          aggregateToolCalls = [];
          usedIndex++;
          break;
        }

        markModelSucceeded(target.modelId);
        callbacks.onInvocationAudit?.(buildLlmInvocationAuditEvent({
          target,
          status: "success",
          startedAtMs: modelStartedAt,
          finishReason: attempt.finishReason,
          usage: aggregateUsage,
        }));
        callbacks.onFinalToolCalls?.(
          aggregateToolCalls.map((tc) => ({ toolName: tc.toolName, input: tc.input })),
        );
        recordFinalUsage({
          target,
          usage: aggregateUsage,
          finishReason: attempt.finishReason,
          startedAt: modelStartedAt,
        });
        return { usedModelId: target.modelId, switched: usedIndex !== 0 };
      } catch (err) {
        if ((err as { name?: string })?.name === "AbortError" || options.signal?.aborted) {
          return { usedModelId: target.modelId, switched: usedIndex !== 0 };
        }
        // 1.2 修复：传 providerType 让 classifyLlmError 按国产 provider 专属规则匹配（中文错误体）
        const classified = classifyLlmError(err, undefined, target.providerType);
        callbacks.onInvocationAudit?.(buildLlmInvocationAuditEvent({
          target,
          status: "error",
          startedAtMs: modelStartedAt,
          finishReason: classified.category,
          errorCategory: classified.category,
          usage: aggregateUsage,
        }));

        recordUsageEventOnly({
          target,
          usage: aggregateUsage,
          finishReason: classified.category,
          startedAt: modelStartedAt,
        });

        // 是否尝试下一个模型？
        if (!classified.shouldFallback || usedIndex >= models.length - 1) {
          // 不可恢复 或 已是最后一个：标 failed，抛错
          markModelFailed(target.modelId, classified.category);
          throw err;
        }

        // 标记 failed（确认要切才标，避免不该切的也进 cooldown）
        markModelFailed(target.modelId, classified.category);

        // 触发 onSwitched（cooldown 跳过的已经在上面触发过）
        const next = models[usedIndex + 1]!;
        callbacks.onSwitched?.(target, next, { kind: "error", category: classified.category });
        callbacks.onRecovered?.("fallback_handoff");
        const partialText = getPartialTextFromError(err);
        if (partialText.trim()) {
          activeMessages = buildRecoveryMessages(activeMessages, partialText, classified.category);
        }

        aggregateUsage = {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheWriteInputTokens: 0,
          toolCallCount: 0,
        };
        aggregateToolCalls = [];
        usedIndex++;
        break;
      }
    }
  }

  // 理论上到不了（while 出口要么 return 要么 throw），TypeScript 需要兜底
  throw new Error("streamWithFallback: unknown state");
}
