import type { AnyToolDefinition, ToolContext, ToolResult } from "./types";
import { checkCommand, type CommandCheck } from "./command-safety";
import { checkPath, checkWritePath } from "./path-safety";
import { resolveAllowedPrograms } from "@/lib/policy/command-allowlist";
import { checkSkillToolAccess } from "@/lib/llm/capability-registry";

export type SecurityPrecheck =
  | { denied: ToolResult; reasonCode?: "PATH_BLOCKED" | "COMMAND_BLOCKED" | "SKILL_CAPABILITY_DENIED" }
  | { security: ToolContext["security"] };

export type TrustedLsAuthorizationResult =
  | { ok: true; workspacePath: string; operands: readonly string[] }
  | { ok: false; reason: string };

/**
 * Validate the structured candidate and its turn authorization without
 * re-parsing the original command.  This is deliberately exported as a
 * small pure boundary so forged runtime values are covered independently of
 * the command parser.
 */
export function validateTrustedLsCandidate(
  check: CommandCheck,
  ctx: ToolContext,
): TrustedLsAuthorizationResult {
  if (check.verdict !== "needs-path-validation" || check.commandClass !== "path-read") {
    return { ok: false, reason: "trusted ls candidate verdict/class mismatch" };
  }
  const candidate = check.candidate as unknown;
  if (
    !candidate
    || typeof candidate !== "object"
    || (candidate as { kind?: unknown }).kind !== "ls"
    || !Array.isArray((candidate as { operands?: unknown }).operands)
    || !(candidate as { operands: unknown[] }).operands.every((operand) => typeof operand === "string")
  ) {
    return { ok: false, reason: "trusted ls candidate missing or malformed" };
  }

  const authorization = ctx.commandAuthorization;
  if (
    !authorization
    || (authorization.permissionMode !== "read"
      && authorization.permissionMode !== "confirm"
      && authorization.permissionMode !== "auto")
    || typeof authorization.requestHumanConfirm !== "function"
    || typeof authorization.isExecutionActive !== "function"
    || typeof ctx.workspacePath !== "string"
    || ctx.workspacePath.length === 0
    || !Array.isArray(authorization.authorizedReadRoots)
    || authorization.authorizedReadRoots.length !== 1
    || authorization.authorizedReadRoots[0] !== ctx.workspacePath
  ) {
    return { ok: false, reason: "trusted ls authorization context missing or mismatched" };
  }
  try {
    if (authorization.isExecutionActive() !== true) {
      return { ok: false, reason: "trusted ls execution turn inactive" };
    }
  } catch {
    return { ok: false, reason: "trusted ls execution state threw" };
  }
  return {
    ok: true,
    workspacePath: ctx.workspacePath,
    operands: (candidate as { operands: readonly string[] }).operands,
  };
}

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
    if (check.verdict === "needs-path-validation") {
      const authorization = validateTrustedLsCandidate(check, ctx);
      if (!authorization.ok) {
        return {
          denied: { status: "denied", output: `已拒绝：${authorization.reason}` },
          reasonCode: "COMMAND_BLOCKED",
        };
      }
      return {
        security: {
          kind: "command",
          verdict: "allow",
          reason: check.reason,
          commandClass: "path-read",
          requiresHumanConfirmation: false,
          execution: {
            kind: "trusted-ls",
            workspacePath: authorization.workspacePath,
            operands: authorization.operands,
          },
        },
      };
    }
    if (check.verdict === "allow") {
      return {
        security: {
          kind: "command",
          verdict: "allow",
          reason: check.reason,
          commandClass: check.commandClass,
          requiresHumanConfirmation: true,
        },
      };
    }
    // The discriminated union is exhaustive; this fallback only protects
    // against malformed runtime values from an untyped boundary.
    return { denied: { status: "denied", output: "已拒绝：命令安全判定状态无效" }, reasonCode: "COMMAND_BLOCKED" };
  }

  return { security: undefined };
}
