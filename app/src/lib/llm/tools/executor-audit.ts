import { toolExecutions } from "../../db";
import {
  sanitizeResultV2,
  serializeResultV2,
  type ToolResultV2,
} from "./result-contract";
import { safeStringify } from "./executor-serialization";
import type { AnyToolDefinition, ToolContext } from "./types";
import { projectToolExecutionForAudit, projectWebFetchInput } from "@/lib/security-invariants/web-fetch-privacy";

export async function persistToolExecution(
  tool: AnyToolDefinition,
  rawInput: unknown,
  result: ToolResultV2,
  ctx: ToolContext,
  durationMs: number,
  maxOutputChars: number,
): Promise<void> {
  try {
    const isWebFetch = tool.name === "web_fetch";
    const base = {
      projectId: ctx.projectId ?? null,
      conversationId: ctx.conversationId ?? null,
      messageId: ctx.messageId ?? null,
      toolName: tool.name,
      durationMs,
    };
    if (isWebFetch) {
      const projected = projectToolExecutionForAudit(result, durationMs);
      await toolExecutions.create({
        ...base,
        input: projectWebFetchInput(rawInput),
        output: "[web_fetch output withheld]",
        status: projected.status,
        userConfirmed: projected.userConfirmed,
        reversible: projected.reversible,
        resultJson: JSON.stringify(projected),
        errorCode: projected.errorCode,
      });
      return;
    }
    const persistResult = sanitizeResultV2(result, maxOutputChars, { includeParts: false });
    await toolExecutions.create({
      ...base,
      input: safeStringify(rawInput),
      output: persistResult.output,
      status: persistResult.status,
      // 2026-07-15 review 修复：优先信工具自己报的真实确认状态（比如 bash 工具内部
      // pure-read grammar 免确认时会显式报 userConfirmed:false，不能让下面这条"从
      // status/readOnly 反推"的兜底把它盖成 true）。大多数工具（write/edit/hashline_edit/
      // memory）无条件走 requireApprovalAsV2，没有主动报这个字段，走兜底推导仍然准确。
      userConfirmed: persistResult.userConfirmed ?? (persistResult.status !== "denied" && !tool.readOnly),
      reversible: persistResult.reversible ?? false,
      resultJson: serializeResultV2(persistResult),
      errorCode: persistResult.error?.code ?? null,
    });
  } catch (auditErr) {
    console.error("[tools] 写 ToolExecution 审计失败:", auditErr);
  }
}
