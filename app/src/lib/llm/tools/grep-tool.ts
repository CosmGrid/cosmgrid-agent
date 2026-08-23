// v0.7 阶段4 — grep 工具（US-4.2：在项目里搜内容）
//
// Harness 阶段2（2026-07-11）：返回 ToolResultV2。
// - 非法正则 → errorResult{TOOL_INVALID_PARAMS, retryable=true}
// - 空匹配 → warningResult（status=warning），模型据此换 pattern 而不是重试同正则
// - 超 GREP_MAX_MATCHES → successResult + nextActions["narrow_search"]
// - 成功命中 → successResult

import { z } from "zod";
import type { ToolDefinition } from "./types";
import { getFsAdapter } from "./fs-adapter";
import { globToRegExp, walkSafeFiles, type SafeWalkFile } from "./walk";
import {
  errorResult,
  successResult,
  warningResult,
  TOOL_INVALID_PARAMS,
  TOOL_UNKNOWN_ERROR,
  type ToolResultV2,
} from "./result-contract";

const paramsSchema = z.object({
  pattern: z.string().describe("要搜索的正则表达式"),
  // .default(".")：理由同 glob-tool，executor 的声明式检查要在 schema 层拿到落地默认值。
  path: z.string().default(".").describe("搜索起点（相对工作区），默认整个工作区"),
  include: z.string().optional().describe("只搜匹配此 glob 的文件，如 *.ts"),
});

type GrepParams = z.infer<typeof paramsSchema>;

/** 单次最多返回的匹配行数 */
const GREP_MAX_MATCHES = 200;

export const grepTool: ToolDefinition<GrepParams> = {
  name: "grep",
  description: "在工作区文件里用正则搜索，返回匹配的 文件:行号: 内容。可用 include 限定文件类型。",
  parameters: paramsSchema,
  readOnly: true,
  security: { kind: "read-path", pathField: "path" },
  async execute(input, ctx): Promise<ToolResultV2> {
    if (ctx.security?.kind !== "read-path") throw new Error("grep 工具必须经 executeTool 调用（缺 ctx.security）");
    const resolved = ctx.security.resolved;

    let re: RegExp;
    try {
      re = new RegExp(input.pattern);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return errorResult({
        output: `非法正则：${input.pattern}（${msg}）`,
        summary: "grep 正则非法",
        error: {
          code: TOOL_INVALID_PARAMS,
          rootCauseHint: msg,
          retryable: true,
          retryInstruction: "修正正则语法（常见的：未闭合的括号、未转义的特殊字符）后重试",
        },
      });
    }
    const includeRe = input.include ? globToRegExp(input.include) : null;

    const fs = getFsAdapter();
    let walked: SafeWalkFile[];
    try {
      walked = await walkSafeFiles(ctx.workspacePath, resolved);
    } catch {
      return errorResult({
        output: "遍历失败：搜索根目录无法完成安全校验",
        summary: "grep 遍历失败",
        error: {
          code: TOOL_UNKNOWN_ERROR,
          rootCauseHint: "搜索根目录无法完成安全校验",
          retryable: false,
        },
      });
    }

    const matches: string[] = [];
    let scannedFiles = 0;
    for (const file of walked) {
      const rel = file.relativePath;
      if (matches.length >= GREP_MAX_MATCHES) break;
      const name = rel.split("/").pop() ?? rel;
      if (includeRe && !includeRe.test(rel) && !includeRe.test(name)) continue;
      let text: string;
      try {
        text = await fs.readTextFile(file.resolvedPath);
        scannedFiles++;
      } catch {
        continue; // 二进制/读不了的跳过
      }
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line !== undefined && re.test(line)) {
          matches.push(`${rel}:${i + 1}: ${line.trim()}`);
          if (matches.length >= GREP_MAX_MATCHES) break;
        }
      }
    }

    if (matches.length === 0) {
      return warningResult({
        output: `没有匹配 "${input.pattern}" 的内容（已扫描 ${scannedFiles} 个文件）。`,
        summary: `grep 无命中 ${input.pattern}`,
        error: {
          code: TOOL_UNKNOWN_ERROR,
          rootCauseHint: "正则合法，工作区里没找到匹配项（已扫描 " + scannedFiles + " 个文件）",
          retryable: false,
          stopCondition: "不要重试同一正则；放宽 pattern / 加 include / 确认确实没有相关代码",
        },
        nextActions: [
          { action: "broaden_pattern", reason: "放宽正则（如去 word boundary、增 * 量词）", safe: true },
          { action: "add_include", reason: "用 include=*.ts / *.tsx 等限定文件类型（避免二进制/资源误扫）", safe: true },
        ],
      });
    }

    const truncated = matches.length >= GREP_MAX_MATCHES;
    const output = truncated
      ? `${matches.join("\n")}\n…（已截断到前 ${GREP_MAX_MATCHES} 行）`
      : matches.join("\n");

    return successResult({
      output,
      summary: truncated
        ? `grep ${input.pattern} → ${matches.length}+ 行（已截断）`
        : `grep ${input.pattern} → ${matches.length} 行`,
      nextActions: truncated
        ? [
            {
              action: "narrow_search",
              reason: `命中超过 ${GREP_MAX_MATCHES} 行，加 include=*.xxx 或换更精确的正则`,
              safe: true,
            },
          ]
        : [],
    });
  },
};
