// 判断"看似正常结束"的一次调用是否真的产出了有效结果。
//
// 背景：finishReason 只回答"流断了没"，不回答"有没有真正的正文"——MiniMax-M3 等国产
// 推理模型会出现 finishReason=stop 但内容其实卡在未闭合的 <think> 块里、没写完就提前
// 收尾的情况（2026-07-12 用户实测复现：思考写一半直接停，界面冻结在"进行中"，无任何
// 提示）。原来的判定逻辑只信 finishReason 字符串，这类"假成功"会被当正常结果直接落库。
//
// 对齐 opencode/gemini-cli/OMO 的共同做法：把"结束了"和"有有效内容"拆成两条独立判据，
// reasoning/思考内容永远不计入"有效正文"。这里复用 parse-thinking.ts 的切段逻辑（单一
// 事实源——它已经知道怎么识别 think/tool/debate 折叠块，包括流式未闭合的情况）。

import { parseThinking } from "../parse-thinking";

/** 从模型原始输出里提取"真正的可见正文"——剔除 think/tool/debate 折叠块（含未闭合的），
 *  只保留 text 段拼接后 trim。 */
export function extractVisibleAnswerText(rawText: string): string {
  const segments = parseThinking(rawText);
  return segments
    .filter((seg) => seg.type === "text")
    .map((seg) => seg.content)
    .join("")
    .trim();
}

/** 一次调用是否产出了有效结果：必须有可见正文。
 * 工具调用本身不是交付：模型可能在工具失败后只留下思考过程就提前结束。 */
export function hasEffectiveOutput(rawText: string, _toolCallCount: number): boolean {
  return extractVisibleAnswerText(rawText).length > 0;
}
