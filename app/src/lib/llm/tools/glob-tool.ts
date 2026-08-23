// v0.7 阶段4 — glob 工具（US-4.2 配套：按模式找文件）
//
// Harness 阶段2（2026-07-11）：返回 ToolResultV2。
// - 空匹配 → warningResult（status=warning），让模型知道"模式没问题，是真的没匹配到"，
//   而不是把"没匹配"当成 success 以为已经有结果了。模型据此换模式而不是重试同样 pattern。
// - 命中超 GLOB_MAX_RESULTS → successResult + nextActions["narrow_pattern"]。

import { z } from "zod";
import type { ToolDefinition } from "./types";
import { globToRegExp, walkSafeFiles } from "./walk";
import {
  errorResult,
  successResult,
  warningResult,
  TOOL_UNKNOWN_ERROR,
  type ToolResultV2,
} from "./result-contract";

const paramsSchema = z.object({
  pattern: z.string().describe("glob 模式，如 src/**/*.ts"),
  // .default(".") 而非 execute 内部 `input.path ?? "."`：executor 的声明式 read-path 检查
  // 直接读 zod parse 后的字段值，默认值必须在 schema 层面就落地，否则 executor 会把
  // "字段未传" 误判成 git_read 那种"跳过检查"的可选路径语义。
  path: z.string().default(".").describe("搜索起点（相对工作区），默认整个工作区"),
});

type GlobParams = z.infer<typeof paramsSchema>;

/** 单次最多返回的匹配文件数 */
const GLOB_MAX_RESULTS = 200;

export const globTool: ToolDefinition<GlobParams> = {
  name: "glob",
  description: "按 glob 模式（如 src/**/*.ts）在工作区里查找文件，返回匹配的相对路径列表。",
  parameters: paramsSchema,
  readOnly: true,
  security: { kind: "read-path", pathField: "path" },
  async execute(input, ctx): Promise<ToolResultV2> {
    if (ctx.security?.kind !== "read-path") throw new Error("glob 工具必须经 executeTool 调用（缺 ctx.security）");
    const resolved = ctx.security.resolved;

    const re = globToRegExp(input.pattern);
    let files: string[];
    try {
      const walked = await walkSafeFiles(ctx.workspacePath, resolved);
      files = walked.map((file) => file.relativePath);
    } catch {
      return errorResult({
        output: "遍历失败：搜索根目录无法完成安全校验",
        summary: "glob 遍历失败",
        error: {
          code: TOOL_UNKNOWN_ERROR,
          rootCauseHint: "搜索根目录无法完成安全校验",
          retryable: false,
          stopCondition: "确认工作区根目录存在且有读权限",
        },
      });
    }

    const matchedAll = files.filter((f) => re.test(f));
    const matched = matchedAll.slice(0, GLOB_MAX_RESULTS);
    const truncated = matchedAll.length > GLOB_MAX_RESULTS;

    if (matched.length === 0) {
      return warningResult({
        output: `没有匹配 "${input.pattern}" 的文件。`,
        summary: `glob 无命中 ${input.pattern}`,
        error: {
          code: TOOL_UNKNOWN_ERROR,
          rootCauseHint: "模式本身合法，但工作区里没有任何文件匹配",
          retryable: false,
          stopCondition: "不要重试同一模式；要么换更宽松的 pattern，要么确认文件确实不存在",
        },
        nextActions: [
          { action: "broaden_pattern", reason: "把模式放宽（如 **/*.ts 替代 src/**/*.ts）", safe: true },
          { action: "verify_pattern_syntax", reason: "确认 glob 语法是否正确（/** vs /*/* 的区别）", safe: true },
        ],
      });
    }

    const output = truncated
      ? `${matched.join("\n")}\n…（共 ${matchedAll.length} 个匹配，已截断到前 ${GLOB_MAX_RESULTS} 个）`
      : matched.join("\n");

    return successResult({
      output,
      summary: truncated
        ? `glob ${input.pattern} → ${matched.length} / ${matchedAll.length} 个`
        : `glob ${input.pattern} → ${matched.length} 个`,
      artifacts: matched.slice(0, 10).map((p) => ({ kind: "file", uri: p, label: "匹配文件" })),
      nextActions: truncated
        ? [
            {
              action: "narrow_pattern",
              reason: `还有 ${matchedAll.length - matched.length} 个未列出，加更具体的限定（path/include）再 glob 一次`,
              safe: true,
            },
          ]
        : [],
    });
  },
};
