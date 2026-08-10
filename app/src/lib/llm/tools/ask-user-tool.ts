// ask_user_question 工具（2026-07-05 新增）——对齐 gemini-cli(ask-user)/opencode(question.ts)/
// Claude Code(AskUserQuestion)：任务中卡在只有用户知道答案的决策点时，结构化地停下来问，
// 而不是自己瞎猜、也不是把问题混在正文里指望用户注意到。
//
// 没有 ctx.askUser（当前环境不支持，比如没有对应 UI 通道）时直接 denied，明确告诉模型
// "别等了，直接给最佳判断"——不能让它以为问题已经问出去、傻等一个不会来的回答。
//
// Harness 阶段2（2026-07-11）：返回 ToolResultV2。
// - 通道缺失 → errorResult{TOOL_DENIED, retryable=false, stopCondition:"直接给最佳判断"}。
//   注意：这里用 errorResult 而不是 deniedResult 是因为这不是用户主动拒绝，是"环境不支持"。
//   模型看到 errorCode=TOOL_DENIED 也能正确识别"等不到回答"。
// - 成功 → successResult

import { z } from "zod";
import type { ToolDefinition } from "./types";
import {
  errorResult,
  successResult,
  TOOL_DENIED,
  type ToolResultV2,
} from "./result-contract";

const optionSchema = z.object({
  label: z.string().min(1).describe("选项的简短文本"),
  description: z.string().optional().describe("可选：这个选项意味着什么/权衡是什么"),
});

const paramsSchema = z.object({
  question: z.string().min(1).describe("要问用户的问题，清楚说明你卡在哪个决策点"),
  options: z.array(optionSchema).min(2).max(4).describe("2-4 个互斥的候选选项"),
});

type AskUserParams = z.infer<typeof paramsSchema>;

export const askUserTool: ToolDefinition<AskUserParams> = {
  name: "ask_user_question",
  description:
    "当任务存在只有用户能拍板、你自己判断不了的关键决策点时，暂停并向用户提问，给出 2-4 个互斥选项。" +
    "用户选择后你会收到选中项的 label 文本。只在真正卡住的决策点用，不要用来问琐碎问题或替代正常对话。",
  parameters: paramsSchema,
  readOnly: true,
  security: { kind: "none" },
  async execute(input, ctx): Promise<ToolResultV2> {
    if (!ctx.askUser) {
      return errorResult({
        output:
          "当前环境不支持向用户提问（没有可用的追问通道）。请基于已知信息直接给出你的最佳判断，不要停下等待不会到来的回答。",
        summary: "ask_user 通道缺失",
        error: {
          code: TOOL_DENIED,
          rootCauseHint: "当前执行环境没有 askUser 通道（CLI 模式 / headless 模式 / 无 UI）",
          retryable: false,
          stopCondition: "直接给最佳判断，不要傻等用户回答",
        },
        nextActions: [
          {
            action: "make_a_decision",
            reason: "等不到用户回答时，基于已知信息给出最佳判断 + 说明判断依据",
            safe: true,
          },
        ],
      });
    }
    const answer = await ctx.askUser({ question: input.question, options: input.options });
    if (answer === null) {
      return errorResult({
        output: "用户已取消当前任务，没有回答这个问题。不要把空答案当成用户选择。",
        summary: "用户取消了追问",
        error: {
          code: TOOL_DENIED,
          rootCauseHint: "当前任务已被用户停止，追问没有答案",
          retryable: false,
          stopCondition: "停止当前任务，不要继续等待或猜测答案",
        },
      });
    }
    return successResult({
      output: `用户选择：${answer}`,
      summary: `用户选择「${answer}」`,
    });
  },
};
