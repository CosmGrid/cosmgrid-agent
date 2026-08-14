// v0.7 阶段4 — 工具执行层：工具抽象
//
// 让 AI 能读用户项目文件、按确认写文件、执行白名单命令。这是把产品从"聊天壳"升级成
// "真能干活的工作台"的关键。本文件只定义抽象，不绑定具体后端（fs/shell 由各 tool 实现）。
//
// 设计借鉴 OpenCode tool 抽象 + Claude Code 5 个核心 tool（read/edit/bash/glob/grep）+
// Vercel AI SDK tool()。每个 tool = name + description + zod 参数 schema + execute。

import type { z } from "zod";
import type { CommandClass } from "@/lib/policy/command-program-spec";

/** 工具执行上下文（工作区边界 + 关联实体） */
export interface ToolContext {
  /** 工作区根目录（所有路径必须在此之下，越界拒绝） */
  workspacePath: string;
  projectId?: string;
  conversationId?: string;
  /** 2026-07-04 修复：这次工具调用归属的 assistant 消息 id（调用方在生成该消息时创建，
   *  贯穿整个模型调用透传下来）。有它就不用再靠时间戳窗口猜"这次工具调用是哪条消息做的"——
   *  编排/多角色接力场景下，不同节点的工具调用时间可能穿插，纯时间戳窗口会张冠李戴。 */
  messageId?: string;
  /** 写操作的用户确认回调；返回 false 表示用户拒绝 */
  confirm?: (preview: ToolConfirmRequest) => Promise<boolean>;
  /** 命令执行专用的人类授权通道；故意与文件写入 confirm 分离，auto 也不能静默放行命令。 */
  commandAuthorization?: {
    permissionMode: "read" | "confirm" | "auto";
    requestHumanConfirm?: (request: ToolConfirmRequest) => Promise<boolean>;
  };
  /** 项目自定义的命令黑名单前缀（bash 工具用，叠加在内置危险拦截之上） */
  blockedCommands?: string[];
  /** K7 能力门控：本轮允许的 capability 集（允许集）。来源 = 当前工作流阶段策略
   *  （capabilitiesForPhase），后续真 skill 被 invoke 时再并入其 allowed-tools。
   *  runSecurityPrecheck 用 checkSkillToolAccess(this, tool.security.kind) 判定：
   *  read-path/none 恒放行，write-path/command 需被授予，否则 denied。
   *  不传 / 空数组 = 不做 K7 enforcement（保持老调用方行为不变）。 */
  activeCaps?: string[];
  /** ask_user_question 工具用：向用户提问；null 表示任务已停止、用户没有作答。 */
  askUser?: (request: AskUserRequest) => Promise<string | null>;
  /**
   * executor 按 tool.security 声明跑完前置检查后的结果，工具从这里取，不用自己再调
   * checkPath/checkWritePath/checkCommand。tool.security.kind 为 "read-path"/"write-path"
   * 时若目标字段值为空（如 git_read 的可选 path 未传），executor 会跳过检查，此时该字段
   * 保持 undefined——工具自己判断是否需要处理"没有路径可查"的分支。
   */
  security?:
    | { kind: "read-path"; resolved: string }
    | { kind: "write-path"; resolved: string; external: boolean }
    | { kind: "command"; verdict: "allow" | "block"; reason?: string; commandClass?: CommandClass; requiresHumanConfirmation?: boolean };
}

/** 结构化追问用户时的一个候选选项 */
export interface AskUserOption {
  label: string;
  description?: string;
}

/** ask_user_question 工具的提问请求 */
export interface AskUserRequest {
  question: string;
  options: AskUserOption[];
}

/** 写操作请求用户确认时的展示信息 */
export interface ToolConfirmRequest {
  toolName: string;
  /** 人类可读的操作描述（如 "写入 src/auth.ts（+12 −3 行）"） */
  summary: string;
  /** 可选的 diff 文本（红绿对比） */
  diff?: string;
}

export type ToolStatus = "success" | "warning" | "error" | "denied" | "timeout";

/** 多模态工具结果的内容片段（与 Vercel AI SDK v6 ToolResultContent 对齐）。
 *  - text：纯文本，按 MAX_OUTPUT_CHARS 截断
 *  - image：base64 dataURL（image/png | image/jpeg | image/webp | image/gif），不参与字符截断
 *
 *  设计动机：view_image 工具要让模型真的看到图片（不是 base64 字符串塞进 output 让模型自己解码）。
 *  Anthropic 协议层 tool_result 原生支持嵌 image content block（参见 Claude API docs），
 *  AI SDK 6 的 `@ai-sdk/anthropic` provider 透传给该通道；OpenAI / Google 兼容性需落地验证，
 *  见 model-capabilities view_image 字段。 */
export type TextPart = { type: "text"; text: string };
export type ImagePart = { type: "image"; image: string; mediaType: string };
export type ContentPart = TextPart | ImagePart;

/** 工具执行结果 */
export interface ToolResult {
  status: ToolStatus;
  /** 给模型看的输出（成功是内容，失败是错误信息）。
   *  简单工具（read/glob/grep 等）只用这一字段；多模态工具可同时填 parts 让模型看到图片。 */
  output: string;
  /** 多模态内容片段（可选）。存在时 buildAiSdkTools 把它转成 AI SDK v6 的
   *  { content: ContentPart[] } 形态透传给 provider；不存在时仍走旧 output 字符串路径，
   *  向后兼容所有老工具。 */
  parts?: ContentPart[];
  /** 这次执行是否可回滚（写操作有 git commit 则 true） */
  reversible?: boolean;
}

/** 工具定义 */
export interface ToolDefinition<TInput = unknown> {
  name: string;
  description: string;
  /** zod 参数 schema（同时用于 LLM tool schema 与运行时校验） */
  parameters: z.ZodType<TInput>;
  /** 只读工具（read/glob/grep/git_status）无需用户确认；写/执行工具为 false */
  readOnly: boolean;
  /**
   * 声明这个工具需要执行器做哪种前置安全检查（L6 安全网收拢，2026-07-09）：
   * - "read-path"：从 input 里按 pathField 取路径，跑 checkPath（只读边界）
   * - "write-path"：跑 checkWritePath（写路径，工作区外标记 external 而非直接拒）
   * - "command"：从 input 里按 commandField 取命令，跑 checkCommand
   * - "none"：不需要（memory/todo/ask-user/web-search/web-fetch 这类不碰文件系统/
   *   shell 命令的工具；web-fetch 的 SSRF 校验对象是 URL 不是路径/命令，不属于这三道
   *   安全网中的任何一道，继续在工具内部自己调用 assertSafeUrl）
   */
  security:
    | { kind: "read-path"; pathField: keyof TInput }
    | { kind: "write-path"; pathField: keyof TInput }
    | { kind: "command"; commandField: keyof TInput }
    | { kind: "none" };
  /**
   * 执行函数。
   * 阶段2（2026-07-11）起推荐返回 ToolResultV2（结构化）；老 ToolResult 仍然兼容，
   * executor 会通过 compatFromLegacy 兜底归一化。这样老工具零改动也能享受到 v2 的
   * 落库 / 渲染路径，但模型看不到 error.code / nextActions / artifacts。
   *
   * 注意：返回类型用 ToolResultV2Like 而非 ToolResult | ToolResultV2Like 的 union——
   * union 让消费者 TS 推断时拿不到 .error 等 v2 字段（ToolResult 没这些字段），
   * 工具代码基本都已经在写 v2 形态，兼容兜底由 executor 处理。
   */
  execute: (input: TInput, ctx: ToolContext) => Promise<ToolResultV2Like>;
}

/**
 * ToolResultV2 鸭子类型：ToolDefinition.execute 不直接依赖 result-contract.ts（避免循环 import），
 * 实际返回时 executor 内部做 union 校验。
 */
export interface ToolResultV2Like {
  status: ToolStatus;
  summary: string;
  output: string;
  artifacts?: unknown[];
  nextActions?: unknown[];
  error?: {
    code: string;
    rootCauseHint: string;
    retryable: boolean;
    retryInstruction?: string;
    stopCondition?: string;
  };
  parts?: ContentPart[];
  reversible?: boolean;
  durationMs?: number;
}

/** 把任意 ToolDefinition 擦除输入类型，便于放进 Registry/列表 */
export type AnyToolDefinition = ToolDefinition<any>;
