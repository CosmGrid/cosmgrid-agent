// Harness 阶段1 收尾——闭环的「反馈纠正」半步。
//
// 检测层（extract-claims / verify-claims / detect-pseudo-tools）只判定「模型编了」，
// 之前只事后标黄给用户看（违规→检测→提示用户）。本模块补上最后半步：
// 把违规组织成一条**回填给模型的纠正指令**，让它自查重答（违规→检测→反馈→纠正）。
//
// 设计取舍：
// - 纯函数，不碰 db / 不碰流式——只做「verdict → 纠正话术」与「verdict 是否干净」。
// - 重答封顶 1 次（调用方控制），避免模型反复造假烧 token。
// - 有工具 vs 没工具，纠正话术不同：没工具时不能叫它「去用真工具」（根本没有）。

import { extractFilePaths, extractUrlClaims, extractQuotedClaims } from "./extract-claims";
import { verifyFileClaims, verifyUrlClaims, verifyCommandClaims, unverifiedClaims, type ReadRecord, type FetchRecord, type ExecRecord } from "./verify-claims";
import { detectPseudoToolCalls } from "./detect-pseudo-tools";
import { detectFabricatedUsageCount } from "./detect-usage-narration";
import type { FabricationSuspicion } from "./fabrication-constants";

// 重新导出 FabricationSuspicion 给外部用
export type { FabricationSuspicion };

export interface HarnessVerdict {
  /** 模型声称读过、但 tool_executions 无对应 read 记录的文件路径 */
  unverifiedPaths: string[];
  /** 模型声称抓取过、但 tool_executions 无对应 web_fetch 成功记录的网页 URL */
  unverifiedUrls?: string[];
  /** 模型声称运行/搜索过、但 tool_executions 无对应 bash/grep/web_search 成功记录的命令/pattern/查询词 */
  unverifiedCommands?: string[];
  /** 模型在正文里吐的伪工具名（run_command 等），未真实执行 */
  pseudoToolNames: string[];
  /** 模型声称的工具/命令使用次数超过本轮真实 toolCallCount——数字化的编造信号，无此类声称则为 null */
  fabricatedUsageCount?: number | null;
  /** 语义裁判（fabrication-judge 命中后由接线方写入）。null=未裁判/未命中；非 null=verdict 不干净 */
  fabricationSuspected?: FabricationSuspicion | null;
}

/**
 * 评估一条 assistant 回答：声称读的文件/网页/命令有没有真执行、有没有吐伪工具调用、有没有编造使用次数。
 * 纯函数——readRecords/fetchRecords/execRecords 由调用方从 tool_executions 查好传进来；actualToolCallCount
 * 默认 0（不传时按"本轮没有真实工具调用"的最严格口径判定，向后兼容旧调用点）。fetchRecords/execRecords
 * 不传则不校验对应类型的 claim。
 *
 * fabricationSuspected 不在此函数内设置——它是 LLM 语义裁判的产物，由 useChatStream 接线方在阶段A
 * verdict 干净后调用 fabrication-judge，命中阈值时回填。
 */
export function evaluateHarness(
  content: string,
  readRecords: ReadRecord[],
  actualToolCallCount = 0,
  fetchRecords: FetchRecord[] = [],
  execRecords: ExecRecord[] = [],
): HarnessVerdict {
  const claimed = extractFilePaths(content);
  const unverifiedPaths = unverifiedClaims(verifyFileClaims(claimed, readRecords)).map((c) => c.claimed);
  const claimedUrls = extractUrlClaims(content);
  const unverifiedUrls = unverifiedClaims(verifyUrlClaims(claimedUrls, fetchRecords)).map((c) => c.claimed);
  const claimedCommands = extractQuotedClaims(content);
  const unverifiedCommands = unverifiedClaims(verifyCommandClaims(claimedCommands, execRecords)).map(
    (c) => c.claimed,
  );
  const pseudoToolNames = [
    ...new Set(detectPseudoToolCalls(content).map((p) => p.toolName).filter((n): n is string => !!n)),
  ];
  const fabricatedUsageCount = detectFabricatedUsageCount(content, actualToolCallCount);
  return { unverifiedPaths, unverifiedUrls, unverifiedCommands, pseudoToolNames, fabricatedUsageCount };
}

/** verdict 是否干净（没检测到任何违规）。干净 = 不需要标黄、不需要重答。 */
export function isClean(v: HarnessVerdict): boolean {
  if (v.fabricationSuspected) return false;
  return (
    v.unverifiedPaths.length === 0 &&
    (v.unverifiedUrls?.length ?? 0) === 0 &&
    (v.unverifiedCommands?.length ?? 0) === 0 &&
    v.pseudoToolNames.length === 0 &&
    !v.fabricatedUsageCount
  );
}

// ============ 纠正话术拼装：每个违规类型独立成函数，主函数只做 dispatch ============

function correctionForUnverifiedPaths(v: HarnessVerdict, hasTools: boolean): string[] {
  if (v.unverifiedPaths.length === 0) return [];
  return [
    `- 你声称读取过这些文件，但本次对话没有任何真实的 read 工具执行记录：${v.unverifiedPaths.join("、")}。`,
    hasTools
      ? "  你有可用的 read 工具——请**真正调用 read 读取这些文件后**，根据真实内容重新回答；如果不需要读，就别声称读过。"
      : "  本次你没有可用的文件工具，无法真读文件。请**不要再编造文件内容**——直说你读不了，请用户把文件内容贴过来，或基于已知信息谨慎回答。",
  ];
}

function correctionForUnverifiedUrls(v: HarnessVerdict, _hasTools: boolean): string[] {
  if (!(v.unverifiedUrls && v.unverifiedUrls.length > 0)) return [];
  return [
    `- 你声称抓取过这些网页，但本次对话没有任何真实的 web_fetch 成功记录：${v.unverifiedUrls.join("、")}。`,
    "  请仅依据对话中已经提供的正文、截图或其他可见来源作答；不要声称已访问网页。",
  ];
}

function correctionForUnverifiedCommands(v: HarnessVerdict, hasTools: boolean): string[] {
  if (!(v.unverifiedCommands && v.unverifiedCommands.length > 0)) return [];
  return [
    `- 你声称运行/搜索过这些内容，但本次对话没有任何真实的 bash/grep/web_search 成功记录：${v.unverifiedCommands.join("、")}。`,
    hasTools
      ? "  你有可用的 bash/grep/web_search 工具——请**真正调用对应工具执行后**，根据真实结果重新回答；如果不需要执行，就别声称跑过。"
      : "  本次你没有可用的命令/搜索工具，无法真跑这些内容。请**不要再编造执行结果**——直说你做不到，请用户把结果贴过来，或基于已知信息谨慎回答。",
  ];
}

function correctionForPseudoTools(v: HarnessVerdict, hasTools: boolean): string[] {
  if (v.pseudoToolNames.length === 0) return [];
  return [
    `- 你在正文里输出了伪工具调用文本（${v.pseudoToolNames.join("、")}），这些不是本应用的真工具，系统不会执行、其"返回结果"全是你脑补的。`,
    hasTools
      ? "  请改用系统提供的标准工具调用（结构化 tool_call），不要在正文里写工具调用格式的文本。"
      : "  本次你没有任何可用工具。请**不要再输出任何工具调用格式的文本**，用纯文字回答，或直说这件事你做不了。",
  ];
}

function correctionForFabricatedUsageCount(v: HarnessVerdict): string[] {
  if (!v.fabricatedUsageCount) return [];
  return [
    `- 你在正文里声称跑了/用了 ${v.fabricatedUsageCount} 次工具或命令，但本轮真实的工具调用次数没有这么多——这段"执行过程"是编造的。`,
    "  请如实说明本轮实际做了什么：没有真实执行就不要报具体次数、编号、结果；如果这件事本来就做不到，直接说做不到。",
  ];
}

function correctionForFabricationSuspected(v: HarnessVerdict, hasTools: boolean): string[] {
  if (!v.fabricationSuspected) return [];
  const fs = v.fabricationSuspected;
  const actions = fs.claimedActions.join("、");
  return [
    `- 你的回答里给出了只有真实执行才能得到的结果（${actions || "具体执行结果"}），但本轮工具审计无法对账——裁判判定理由：${fs.reason}`,
    hasTools
      ? "  你有可用的工具——请**真正调用对应工具**（不要凭记忆补数字/命中/文件内容/测试结果/百分比），等真实输出回来后再基于证据重新回答。如果之前确实调用过工具但输出里没有你需要的信息，明确说出来，不要伪造数字。"
      : "  本次你没有可用的工具，无法获取任何新的执行证据。请**不要再编造具体结果**——直接承认无法验证，告诉用户你需要他提供哪些信息（例如文件路径、命令、测试日志）才能给出有依据的回答。不要夹在事实里陈述未经核实的推测。",
  ];
}

/**
 * 把违规组织成一条回填给模型的纠正指令（user 角色，作为下一轮输入）。
 * @param hasTools 本次对话模型是否挂了真工具——决定纠正方向（去用真工具 vs 纯文字/承认做不到）。
 * @returns 纠正话术；verdict 干净时返回空串（调用方应先判 isClean）。
 */
export function buildCorrectionPrompt(v: HarnessVerdict, opts: { hasTools: boolean }): string {
  if (isClean(v)) return "";
  const hasTools = opts.hasTools;
  const lines: string[] = ["⚠️ 系统自查发现你上一条回答可能在编造，未真实执行就声称做了。请纠正后重答："];
  lines.push(
    ...correctionForUnverifiedPaths(v, hasTools),
    ...correctionForUnverifiedUrls(v, hasTools),
    ...correctionForUnverifiedCommands(v, hasTools),
    ...correctionForPseudoTools(v, hasTools),
    ...correctionForFabricatedUsageCount(v),
    ...correctionForFabricationSuspected(v, hasTools),
  );
  lines.push("现在请重新回答用户最初的问题，遵守以上要求。");
  return lines.join("\n");
}

// ============ 阶段 H：Harness 兜底「说了要做却停下→自动催一次」 ============
//
// 病根：模型在正文里写"我先去看一下 foo.ts" / "让我打开 src 看看" / "我来处理这个 bug"，
// 但本轮 0 个真 tool_call——嘴上说要做，实际啥也没做。属于"懒人模式"。
//
// 跟现有 harness 违规（伪工具调用、未验证文件路径）的区别：
// - 现有违规：模型**假装**调了（吐伪工具 / 声称读过文件）
// - 本兜底：模型**承认**没调（明确说"我先去做"，但工具调用计数=0）
//
// 触发条件（调用方控制）：
//   finishReason="stop" + 绑了 tools + toolCallCount === 0 + detectIntentNoToolCall(content) === true
//
// 动作：回填 user 提示让同模型重答一次。封顶 1 次，**复用现有 MAX_HARNESS_RETRY 守门**（ChatPage 端 attempt 循环），
// 不叠加。
//
// 设计取舍：
// - 纯函数，不碰 db / 不碰流式
// - "漏报优于误报"（同 harness 总原则）：只匹配强信号（"我先/让我/我来/我们" + 明确动作动词），
//   不去模糊匹配 "我看看" / "我帮你看一下"（漏报没关系，触发多了会催烦）

/**
 * 检测"说了要做但没真做"：触发词 + 紧跟动作动词。
 * 命中 → true（建议触发 nudge 重答）。
 *
 * 触发的强信号（必须同时满足）：
 *   触发词：我先 | 让我(们)? | 我来 | 我们
 *   动作动词（紧跟在触发词后，可选"去"过渡）：看/读/处理/查/打开/改/写/跑/执行/做/弄/调/修复/删/添加/创建/新建
 *
 * 不触发的（漏报 OK，不误报）：
 *   "我先回答你的问题"（"回答"不是动作动词）
 *   "我建议你这样做"（无触发词）
 *   "答案是 X"（纯文字）
 *   "我看看"（无完整触发词）
 */
// 补（2026-07-07，真实事故）：动作动词表原来没有「保存」这类**文件产出动词**——用户任务
// 恰恰是"保存到桌面"，模型说"让我保存一下"也漏检。补齐 保存/存/写入/导出/生成/下载/落盘。
const INTENT_NO_TOOL_RE = /(我先|让我(?:们)?|我来|我们)\s*(?:去)?\s*(?:看|看看|读取?|处理|查(?:看)?|打开|改(?:写|变|一下)?|写(?:下|入)?|保存|存(?:到|下)?|导出|生成|下载|落盘|跑(?:一下)?|执行|做(?:一下)?|弄|调(?:整|试)?|修复|删(?:除)?|添加|创建|新建)/;

// 补（2026-07-04）：真实事故——模型说"好，再试一次。"/"再发一次"，不带"我先/让我"这类
// 前缀词，INTENT_NO_TOOL_RE 完全漏检，导致这句空手套白狼的话直接放行给用户，
// 下一轮模型还会照着这句瞎话去脑补"上一轮做了什么"（编出根本没发生过的错误细节）。
// 单独补一条"重试语气但没提到具体新动作"的信号——「再/重新」+「试/发/跑/请求/执行/来」+「一次/一遍」。
const RETRY_NO_TOOL_RE = /(再|重新)\s*(试|发|跑|请求|执行|来)\s*(一次|一遍)?/;

// 补（2026-07-07，真实事故——Haiku 4.5 说"现在真正保存。等待权限提示。"却 0 工具调用）：
// 上面两条要求"我先/让我/再/重新"这类前缀，覆盖不了"**假装正在做 / 即将做 / 在等外部流程**"
// 这类将来进行时的画饼。这类话术在"本轮 0 工具调用"前提下几乎必假（真调了工具就会有记录、
// 真等确认就会停在 awaiting_approval 而不是 finishReason=stop）：
//   ① 假装正在进行："正在保存/写入/创建/生成/导出/下载/处理/执行"
//   ② 假装在等外部流程："等待权限/确认/授权/批准"、"等你确认/授权"——它假装有个审批在等，
//      实际根本没发起工具调用（真发起了 write 会立刻弹确认框，不会走到这里）
//   ③ 将来时承诺："现在/这就/马上/立刻(真正)? + 保存/写入/创建/生成/导出/下载/执行/开始"
const FAKE_PROGRESS_RE =
  /(正在\s*(?:保存|写入|创建|生成|导出|下载|处理|执行))|(等待\s*(?:权限|确认|授权|批准))|(等你\s*(?:确认|授权|批准))|((?:现在|这就|马上|立刻)\s*(?:真正)?\s*(?:保存|写入|创建|生成|导出|下载|执行|开始))/;

export function detectIntentNoToolCall(content: string): boolean {
  if (!content) return false;
  return INTENT_NO_TOOL_RE.test(content) || RETRY_NO_TOOL_RE.test(content) || FAKE_PROGRESS_RE.test(content);
}

/**
 * 构造 nudge user 提示（让同模型重答一次，**不复用 buildCorrectionPrompt**，话术不同：
 * buildCorrectionPrompt 是"你编了"的口径；nudge 是"你嘴上说要做但没做"的口径）。
 */
export function buildIntentNudgePrompt(): string {
  return [
    "⚠️ 你上一条回答说要去做某事（用了「我先 / 让我 / 我来」之类的措辞），但本轮没有任何真实的工具调用记录。",
    "请直接调用系统提供的工具完成你说的操作——别再只描述意图。",
    "如果你说的事情本来就不需要工具（例如纯文字解释），请改用完成时态直接陈述结果，不要用「我先去看看 / 让我打开 / 我来处理」这类未执行的措辞。",
  ].join("\n");
}
