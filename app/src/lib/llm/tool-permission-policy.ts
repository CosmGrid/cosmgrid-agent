import type { TurnIntentDecision } from "@/lib/workflow/types";

// 2026-07-04 修复：原正则只认"新建文件""创建文件"这种书面词，用户口语化说"做一个文件""弄个文件"
// 就漏检——加一批口语动词（做/弄/建/生成）+ 文件（中间允许插字，如"做一个 .md 文件"）。
const WRITE_OR_EXECUTE_RE =
  /(改代码|修改代码|修复|实现|落地|新建文件|创建文件|做.{0,6}文件|弄.{0,6}文件|建.{0,6}文件|生成.{0,6}文件|写入文件|保存到|导出到|编辑文件|运行命令|执行命令|跑测试|运行测试|跑构建|构建|编译|安装依赖|npm install|pnpm install|yarn install|build|test|typecheck|lint)/i;

const ARTICLE_WRITING_RE = /(软文|公众号|推广文|文章|文案|帖子|推文|营销文案|宣传文案)/i;

/**
 * V2 修复（2026-07-02）：判断这轮消息本身"是不是想干写类的活"，不考虑权限档位。
 * 从 shouldExposeWriteTools 里拆出来，供 ChatPage 在"没给写工具"时区分两种情况：
 * ①消息本来就不需要写（正常，什么都不用提示）②消息明明想写，但权限档/没绑文件夹把它挡住了
 * （这种要显式告诉用户，不能让 AI 自己装傻或被 harness 抓到"编了工具调用"）。
 */
export function impliesWriteIntent(args: { text: string; decision: TurnIntentDecision }): boolean {
  const text = args.text.trim();
  if (ARTICLE_WRITING_RE.test(text) && !WRITE_OR_EXECUTE_RE.test(text)) return false;

  if (WRITE_OR_EXECUTE_RE.test(text)) return true;
  if (args.decision.action === "approve_node") return true;
  if (args.decision.patch?.executionMode === "execute_directly") return true;
  if (args.decision.patch?.verificationRequired) return true;

  return false;
}

/**
 * 2026-07-04 修复：原来在 confirm/auto 档位下，还要求 impliesWriteIntent(关键词/意图判断)
 * 也命中才给写工具——但关键词覆盖不了所有口语表达（比如"保存成一份文件"没命中"保存到"），
 * 导致用户权限明明开了「确认写」，工具却没给，AI 只能如实说自己没有写工具。
 *
 * 改成只看权限档位本身，不再用意图判断二次把关，原因：
 * - "confirm" 档位：真正执行写/命令前，useChatStream 里已经有 requestConfirm 弹窗兜底
 *   （见 workspace-runtime.ts 的 `confirm: permissionMode === "auto" ? ... : requestConfirm`），
 *   这里的意图判断只是徒增摩擦，没有额外安全价值。
 * - "auto" 档位：虽然没有逐次人工确认，但命令黑名单 + 工作区路径边界检查这两道独立防线
 *   （跟意图判断无关，永远生效）已经拦住真正危险的操作；用户选择"自动"就是要免摩擦执行，
 *   继续用猜不准的关键词卡它，价值也不大——2026-07-04 与用户确认后一并去掉。
 */
export function shouldExposeWriteTools(permissionMode: "read" | "confirm" | "auto"): boolean {
  return permissionMode !== "read";
}
