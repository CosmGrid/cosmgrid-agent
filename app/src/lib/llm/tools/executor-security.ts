import type { AnyToolDefinition, ToolContext, ToolResult } from "./types";
import { checkCommand } from "./command-safety";
import { checkPath, checkWritePath } from "./path-safety";
import { resolveAllowedPrograms } from "@/lib/policy/command-allowlist";
import { checkSkillToolAccess } from "@/lib/llm/capability-registry";

export type SecurityPrecheck =
  | { denied: ToolResult; reasonCode?: "PATH_BLOCKED" | "COMMAND_BLOCKED" | "SKILL_CAPABILITY_DENIED" }
  | { security: ToolContext["security"] };

/**
 * 按 tool.security 声明统一跑路径 / 命令安全检查。
 * 工具本体只声明安全类型，不再各自复制 checkPath/checkCommand。
 *
 * 引擎化阶段 1b（K7）：在 path/command 之外追加第 4 个判定——capability。
 * 本轮允许集（如果 ctx.activeCaps 有声明）必须授予本工具 kind，否则直接 denied。
 * 语义见 capability-registry.checkSkillToolAccess：read-path/none 恒放行，write-path/command
 * 需被授予。允许集来源 = 当前工作流阶段策略（+ 后续真 skill 的 allowed-tools）。
 */
export async function runSecurityPrecheck(
  tool: AnyToolDefinition,
  parsed: any, // eslint-disable-line @typescript-eslint/no-explicit-any
  ctx: ToolContext,
): Promise<SecurityPrecheck> {
  // K7 enforcement 入口：capability mismatch 也是硬阻断，与 path/command 同级。
  // 注意：本检查放在 path/command 之前——capability 缺失意味着"这个 skill 不该调这类工具"，
  // 是结构性错误，没必要再跑昂贵的 path/command 检查。
  if (ctx.activeCaps && ctx.activeCaps.length > 0) {
    const access = checkSkillToolAccess(ctx.activeCaps, tool.security.kind);
    if (!access.ok) {
      return {
        denied: {
          status: "denied",
          output: `已拦截：${access.reason}（工具 kind=${tool.security.kind}）`,
        },
        reasonCode: "SKILL_CAPABILITY_DENIED",
      };
    }
  }

  const sec = tool.security;

  if (sec.kind === "read-path") {
    const raw = typeof parsed[sec.pathField] === "string" ? (parsed[sec.pathField] as string).trim() : parsed[sec.pathField];
    if (typeof raw !== "string" || raw === "") return { security: undefined };
    const check = await checkPath(ctx.workspacePath, raw);
    if (!check.ok) return { denied: { status: "denied", output: check.reason ?? "路径不允许" } };
    return { security: { kind: "read-path", resolved: check.resolved } };
  }

  if (sec.kind === "write-path") {
    const raw = typeof parsed[sec.pathField] === "string" ? (parsed[sec.pathField] as string).trim() : parsed[sec.pathField];
    if (typeof raw !== "string" || raw === "") return { security: undefined };
    const check = await checkWritePath(ctx.workspacePath, raw);
    if (!check.ok) return { denied: { status: "denied", output: check.reason ?? "路径不允许" } };
    return { security: { kind: "write-path", resolved: check.resolved, external: check.external } };
  }

  if (sec.kind === "command") {
    const raw = parsed[sec.commandField];
    if (typeof raw !== "string") return { security: undefined };
    // 阶段 1a：用 PolicyStore 解析 builtin ∪ 项目级 / 全局 override。
    // 拿不到项目上下文或 DB 异常时回退到 builtin（resolveAllowedPrograms 内部已经兜底）。
    const allowedPrograms = await resolveAllowedPrograms(ctx.projectId);
    const check = checkCommand(raw, ctx.blockedCommands ?? [], allowedPrograms);
    if (check.verdict === "block") return { denied: { status: "denied", output: `已拦截：${check.reason}` }, reasonCode: "COMMAND_BLOCKED" };
    return {
      security: {
        kind: "command",
        verdict: check.verdict,
        reason: check.reason,
        ...(check.commandClass ? { commandClass: check.commandClass } : {}),
        ...(check.requiresHumanConfirmation !== undefined
          ? { requiresHumanConfirmation: check.requiresHumanConfirmation }
          : {}),
      },
    };
  }

  return { security: undefined };
}
