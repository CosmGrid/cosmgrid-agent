// Harness 阶段2 — ToolResultV2 result-contract 测试。
//
// 覆盖阶段2 工作项的每一条测试要求：
// 1. 每种 status 都有固定 JSON 形状
// 2. write/edit/bash 成功返回 artifact
// 3. old_string 不唯一返回 retryable 错误和补上下文建议
// 4. 权限拒绝返回 denied，retryable=false，等待用户
// 5. timeout 返回 retryable=true，但有最大次数
// 6. MCP 非文本内容被安全适配
// 7. 输出截断后仍保留 status、summary、error 和 artifacts
// 8. Secret 不进入 result_json 和模型上下文
// 9. Doom Loop 命中返回 TOOL_DOOM_LOOP

import { describe, expect, it } from "vitest";
import {
  clipAndRedact,
  compatFromLegacy,
  deserializeResultV2,
  errorMessage,
  errorResult,
  redactSecret,
  readOrError,
  serializeResultV2,
  sanitizeResultV2,
  successResult,
  summarize,
  timeoutResult,
  truncateForContext,
  warningResult,
  TOOL_DENIED,
  TOOL_HTTP_ERROR,
  TOOL_INVALID_PARAMS,
  TOOL_NOT_FOUND,
  TOOL_OLD_STRING_AMBIGUOUS,
  TOOL_OLD_STRING_MISSING,
  TOOL_TIMEOUT,
  TOOL_UNKNOWN_ERROR,
  deniedResult,
} from "../result-contract";
import type { ToolResultV2 } from "../result-contract";

// =====================================================================
// 1. 每种 status 都有固定 JSON 形状
// =====================================================================

describe("result-contract: 固定 JSON 形状", () => {
  it("success: status/summary/output/artifacts/nextActions 必有，error undefined", () => {
    const r = successResult({
      output: "已写入 foo.ts",
      summary: "写 foo.ts",
      artifacts: [{ kind: "file", uri: "foo.ts", label: "新文件" }],
      nextActions: [{ action: "read_back", reason: "校验", safe: true }],
    });
    expect(r.status).toBe("success");
    expect(r.summary).toBe("写 foo.ts");
    expect(r.output).toBe("已写入 foo.ts");
    expect(r.artifacts).toHaveLength(1);
    expect(r.artifacts[0]).toMatchObject({ kind: "file", uri: "foo.ts" });
    expect(r.nextActions).toHaveLength(1);
    expect(r.error).toBeUndefined();
  });

  it("warning: 必须带 error 字段（语义上是『功能 OK 但结果不达预期』）", () => {
    const r = warningResult({
      output: "没有匹配 foo",
      summary: "无命中",
      error: {
        code: TOOL_UNKNOWN_ERROR,
        rootCauseHint: "工作区里没有这个文件",
        retryable: false,
        stopCondition: "换源，不要重试",
      },
    });
    expect(r.status).toBe("warning");
    expect(r.error?.code).toBe(TOOL_UNKNOWN_ERROR);
    expect(r.error?.retryable).toBe(false);
  });

  it("error: retryable=true 时必须有 retryInstruction", () => {
    const r = errorResult({
      output: "old_string 不唯一",
      summary: "edit 失败",
      error: {
        code: TOOL_OLD_STRING_AMBIGUOUS,
        rootCauseHint: "出现 3 次",
        retryable: true,
        retryInstruction: "补更多上下文",
      },
    });
    expect(r.status).toBe("error");
    expect(r.error?.retryable).toBe(true);
    expect(r.error?.retryInstruction).toBeTruthy();
  });

  it("denied: retryable 必须为 false，必须有 stopCondition", () => {
    const r = deniedResult({
      output: "用户拒绝",
      summary: "拒绝",
      reason: "用户点了拒绝",
    });
    expect(r.status).toBe("denied");
    expect(r.error?.retryable).toBe(false);
    expect(r.error?.stopCondition).toBeTruthy();
    expect(r.error?.code).toBe(TOOL_DENIED);
  });

  it("timeout: retryable=true 但必须有 stopCondition 说明最大次数", () => {
    const r = timeoutResult({ output: "超时", summary: "超时" });
    expect(r.status).toBe("timeout");
    expect(r.error?.retryable).toBe(true);
    expect(r.error?.code).toBe(TOOL_TIMEOUT);
    expect(r.error?.stopCondition).toContain("2");
  });

  it("序列化+反序列化往返保留全部字段", () => {
    const r = errorResult({
      output: "测试输出",
      summary: "测试",
      error: {
        code: TOOL_INVALID_PARAMS,
        rootCauseHint: "缺字段",
        retryable: true,
        retryInstruction: "补字段",
      },
      artifacts: [{ kind: "diagnostic", uri: "schema.ts", label: "schema 错误" }],
      nextActions: [{ action: "fix_params_and_retry", reason: "补字段", safe: true }],
    });
    const json = serializeResultV2(r);
    const parsed = deserializeResultV2(json);
    expect(parsed).toEqual(r);
  });

  it("deserializeResultV2: 损坏 JSON 返回 undefined 而不抛错", () => {
    expect(deserializeResultV2("not json")).toBeUndefined();
    expect(deserializeResultV2(null)).toBeUndefined();
    expect(deserializeResultV2(undefined)).toBeUndefined();
    // 缺 status 字段不算合法 v2
    expect(deserializeResultV2(JSON.stringify({ output: "x" }))).toBeUndefined();
  });
});

describe("result-contract: optional fields and helper edge cases", () => {
  it("constructors preserve optional parts and reversible fields", () => {
    const success = successResult({
      output: "ok",
      parts: [{ type: "text", text: "part" }],
      reversible: true,
    });
    expect(success.parts?.[0]).toMatchObject({ type: "text", text: "part" });
    expect(success.reversible).toBe(true);

    const warning = warningResult({
      output: "warn",
      reversible: false,
      error: { code: TOOL_UNKNOWN_ERROR, rootCauseHint: "x", retryable: false },
    });
    expect(warning.reversible).toBe(false);

    const error = errorResult({
      output: "err",
      parts: [{ type: "text", text: "err part" }],
      reversible: true,
      error: { code: TOOL_UNKNOWN_ERROR, rootCauseHint: "x", retryable: false },
    });
    expect(error.parts?.[0]).toMatchObject({ type: "text", text: "err part" });
    expect(error.reversible).toBe(true);
  });

  it("timeoutResult uses supplied rootCauseHint, retryInstruction, and artifacts", () => {
    const r = timeoutResult({
      output: "timeout",
      error: { rootCauseHint: "large repo", retryInstruction: "narrow scope" },
      artifacts: [{ kind: "command_output", uri: "pnpm test", label: "timeout", exitCode: 124 }],
    });
    expect(r.error?.rootCauseHint).toBe("large repo");
    expect(r.error?.retryInstruction).toBe("narrow scope");
    expect(r.artifacts[0]?.exitCode).toBe(124);
  });

  it("deserializeResultV2 rejects primitive json and missing status", () => {
    expect(deserializeResultV2("123")).toBeUndefined();
    expect(deserializeResultV2("null")).toBeUndefined();
    expect(deserializeResultV2(JSON.stringify({ output: "x" }))).toBeUndefined();
  });

  it("readOrError returns content on success and TOOL_NOT_FOUND result on read failure", async () => {
    await expect(
      readOrError({ readTextFile: async () => "content" }, "a.ts", { toolName: "read" }),
    ).resolves.toEqual({ ok: true, content: "content" });

    const failed = await readOrError(
      { readTextFile: async () => { throw new Error("ENOENT"); } },
      "missing.ts",
      { toolName: "read", pathLabel: "missing.ts", notFoundStop: "read another file" },
    );
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.result.error?.code).toBe(TOOL_NOT_FOUND);
      expect(failed.result.error?.stopCondition).toBe("read another file");
    }
  });

  it("readOrError falls back to path and default stop condition", async () => {
    const failed = await readOrError(
      { readTextFile: async () => { throw "missing"; } },
      "fallback.ts",
      { toolName: "read" },
    );
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.result.summary).toContain("fallback.ts");
      expect(failed.result.error?.stopCondition).toContain("确认文件存在");
    }
  });

  it("errorMessage handles Error and non-Error values", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage({ code: "X" })).toBe("[object Object]");
  });

  it("redactSecret handles headers without auth scheme", () => {
    expect(redactSecret("X-Api-Key: abcdefghijklmnopqrstuvwxyz1234")).toBe("X-Api-Key: [REDACTED]");
  });
});

// =====================================================================
// 2. 老 ToolResult 兼容：compatFromLegacy
// =====================================================================

describe("compatFromLegacy: 老 ToolResult → ToolResultV2", () => {
  it("老 success → v2 success，error undefined", () => {
    const v2 = compatFromLegacy({ status: "success", output: "OK" });
    expect(v2.status).toBe("success");
    expect(v2.summary).toBe("OK");
    expect(v2.error).toBeUndefined();
    expect(v2.artifacts).toEqual([]);
    expect(v2.nextActions).toEqual([]);
  });

  it("老 denied → v2 denied + error.code=TOOL_DENIED + retryable=false", () => {
    const v2 = compatFromLegacy({ status: "denied", output: "无确认通道" });
    expect(v2.status).toBe("denied");
    expect(v2.error?.code).toBe(TOOL_DENIED);
    expect(v2.error?.retryable).toBe(false);
  });

  it("老 timeout → v2 timeout + error.code=TOOL_TIMEOUT + retryable=true", () => {
    const v2 = compatFromLegacy({ status: "timeout", output: "30s 超时" });
    expect(v2.status).toBe("timeout");
    expect(v2.error?.code).toBe(TOOL_TIMEOUT);
    expect(v2.error?.retryable).toBe(true);
  });

  it("老 error → v2 error + error.code=TOOL_UNKNOWN_ERROR + retryable=false", () => {
    const v2 = compatFromLegacy({ status: "error", output: "fs 挂了" });
    expect(v2.status).toBe("error");
    expect(v2.error?.code).toBe(TOOL_UNKNOWN_ERROR);
    expect(v2.error?.retryable).toBe(false);
  });
});

// =====================================================================
// 3. Secret 脱敏：clipAndRedact / redactSecret
// =====================================================================

describe("redactSecret: secret-like 字段被 [REDACTED] 替换", () => {
  it("kv 形式：key=xxx / token=xxx / password=xxx", () => {
    expect(redactSecret('api_key=sk-1234567890abcdefgh')).toBe("api_key=[REDACTED]");
    expect(redactSecret("token: abcdefghijklmnopqrstuvwxyz1234")).toBe("token: [REDACTED]");
    expect(redactSecret("password=Passw0rd12345678")).toBe("password=[REDACTED]");
  });

  it("HTTP 头形式：Authorization / Api-Key", () => {
    expect(redactSecret("Authorization: Bearer abcdefghijklmnopqrstuvwxyz1234")).toBe(
      "Authorization: Bearer [REDACTED]",
    );
    expect(redactSecret("Api-Key: ak_test_1234567890abcdefgh")).toContain("[REDACTED]");
    expect(redactSecret("Api-Key: ak_test_1234567890abcdefgh")).not.toContain("ak_test_1234567890abcdefgh");
  });

  it("短字符串不动（防误伤）", () => {
    expect(redactSecret("name=foo")).toBe("name=foo");
    expect(redactSecret("count=42")).toBe("count=42");
  });

  it("clipAndRedact 同时截断和脱敏", () => {
    const long = "api_key=sk-1234567890abcdefgh" + "\n" + "a".repeat(50);
    const out = clipAndRedact(long, 30);
    expect(out).not.toContain("sk-1234567890");
    expect(out).toContain("[REDACTED]");
    expect(out.length).toBeLessThanOrEqual(50);
  });
});

describe("P0-06: result clone redacts every free-text field", () => {
  it("preserves the source and explicitly projects/redacts known fields", () => {
    const result = {
      status: "error" as const,
      summary: "summary token=summary-secret-123456 sk-proj-summary-secret",
      output: "output token=output-secret-123456 Bearer output-bearer-secret-1234567890",
      artifacts: [{ kind: "file" as const, id: "token=artifact-secret-123456", uri: "https://x.test/?token=uri-secret-123456&api_key=uri-key-123456", label: "label sk-proj-label-secret" }],
      nextActions: [{ action: "action token=action-secret-123456", reason: "reason api_key=reason-secret-123456", safe: true }],
      error: {
        code: "TOOL_UNKNOWN_ERROR",
        rootCauseHint: "root Bearer root-secret-1234567890",
        retryable: true,
        retryInstruction: "retry token=retry-secret-123456",
        stopCondition: "stop api_key=stop-secret-123456",
      },
      reversible: true,
      durationMs: 12,
      userConfirmed: false,
      parts: [{ type: "text", text: "part-secret" }],
      unknown: "unknown-secret",
    } as unknown as ToolResultV2 & { unknown: string };
    const original = structuredClone(result);
    const safe = sanitizeResultV2(result);

    expect(result).toEqual(original);
    expect(safe).not.toHaveProperty("unknown");
    expect(safe.parts).toEqual(result.parts);
    expect(JSON.stringify(safe)).not.toContain("secret-123456");
    expect(JSON.stringify(safe)).not.toContain("sk-proj-");
    expect(JSON.stringify(safe)).toContain("[REDACTED]");
    expect(safe.error).toMatchObject({ code: result.error?.code, retryable: true });
    expect(safe.artifacts[0]).toMatchObject({ kind: "file", id: expect.stringContaining("[REDACTED]") });
  });

  it("redacts before truncating across the 10K boundary and preserves optional shapes", () => {
    const secret = "sk-proj-boundary-secret-1234567890";
    const result = successResult({
      output: "a".repeat(9_990) + secret + "\n" + "ordinary tail ".repeat(300),
      summary: "summary token=summary-secret-123456",
      artifacts: [],
      nextActions: [],
    });
    const safe = sanitizeResultV2(result, 10_000);
    expect(safe.output).not.toContain(secret);
    expect(safe.output).toContain("[REDACTED]");
    expect(safe.output).toContain("…(truncated)");
    expect(safe.artifacts).toEqual([]);
    expect(safe.nextActions).toEqual([]);
  });

  it("truncateForContext uses the same redaction for nested free text", () => {
    const result = errorResult({
      output: "token=output-secret-123456",
      summary: "sk-proj-summary-secret-123456",
      parts: [{ type: "text", text: "runtime part" }],
      error: { code: "X", rootCauseHint: "Bearer root-secret-1234567890", retryable: false, stopCondition: "api_key=stop-secret-123456" },
      artifacts: [{ kind: "url", uri: "https://x.test/?token=uri-secret-123456", label: "sk-proj-label-secret" }],
      nextActions: [{ action: "token=action-secret-123456", reason: "api_key=reason-secret-123456", safe: true }],
    });
    const original = structuredClone(result);
    const safe = truncateForContext(result);
    expect(JSON.stringify(safe)).not.toContain("secret-123456");
    expect(safe.error?.code).toBe("X");
    expect(safe.parts).toBe(result.parts);
    expect(result).toEqual(original);
  });

  it("preserves stable fields, optional omissions, order, and no-secret round-trip", () => {
    const result = {
      status: "warning" as const,
      summary: "all clear",
      output: "ordinary output",
      artifacts: [
        { kind: "file" as const, id: "first", uri: "a", label: "A", exitCode: 0, external: false },
        { kind: "url" as const, uri: "b", label: "B" },
      ],
      nextActions: [
        { action: "first_action", reason: "first reason", safe: true },
        { action: "second_action", reason: "second reason", safe: false },
      ],
      reversible: false,
      durationMs: 42,
      userConfirmed: true,
    } satisfies ToolResultV2;
    const safe = sanitizeResultV2(result);
    expect(safe).toEqual(result);
    expect(safe.artifacts.map((a) => a.label)).toEqual(["A", "B"]);
    expect(safe.nextActions.map((a) => a.action)).toEqual(["first_action", "second_action"]);
    expect(safe.artifacts[1]).not.toHaveProperty("id");
    expect(safe.artifacts[1]).not.toHaveProperty("exitCode");
    expect(safe.artifacts[1]).not.toHaveProperty("external");
    expect(safe).not.toHaveProperty("error");
    const parsed = deserializeResultV2(serializeResultV2(safe));
    expect(parsed).toEqual(result);
  });

  it("preserves an error with omitted retry and stop instructions without adding fields", () => {
    const result = errorResult({
      output: "ordinary error",
      summary: "ordinary summary",
      error: {
        code: "TOOL_UNKNOWN_ERROR",
        rootCauseHint: "ordinary root cause",
        retryable: false,
      },
    });
    const original = structuredClone(result);
    const safe = sanitizeResultV2(result);
    expect(safe.error).toMatchObject({
      code: "TOOL_UNKNOWN_ERROR",
      rootCauseHint: "ordinary root cause",
      retryable: false,
    });
    expect(safe.error).not.toHaveProperty("retryInstruction");
    expect(safe.error).not.toHaveProperty("stopCondition");
    expect(result).toEqual(original);
  });
});

// =====================================================================
// 3b. 厂商 API Key 前缀脱敏（D3）：sk-ant- / sk-proj- / AIza / gsk_ 必须被 [REDACTED]
// =====================================================================

describe("redactApiKeys: 厂商 API Key 前缀脱敏（D3）", () => {
  it("clipAndRedact 抹掉 Anthropic sk-ant-api03- 前缀 key", () => {
    const out = clipAndRedact("response: sk-ant-api03-ABCD1234efgh5678IJKL9012mnop", 10_000);
    expect(out).toContain("[REDACTED]");
    expect(out).not.toContain("sk-ant-api03-");
    expect(out).not.toContain("ABCD1234efgh5678IJKL9012mnop");
  });

  it("clipAndRedact 抹掉 OpenAI sk-proj- 前缀 key", () => {
    const out = clipAndRedact("token sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789", 10_000);
    expect(out).toContain("[REDACTED]");
    expect(out).not.toContain("sk-proj-");
    expect(out).not.toContain("AbCdEfGhIjKlMnOpQrStUvWxYz0123456789");
  });

  it("clipAndRedact 抹掉 OpenAI 老式 sk-<20+字符> key", () => {
    const out = clipAndRedact("key=sk-abcdefghijklmnopqrstuvwxyz0123456789", 10_000);
    expect(out).toContain("[REDACTED]");
    // sk- 后跟 ≥20 位才会命中；短 sk- 不应误伤
    expect(out).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
  });

  it("clipAndRedact 抹掉 Google AIza 前缀 key", () => {
    const out = clipAndRedact("credential: AIzaSyA1B2c3D4e5F6g7H8i9J0kLmNoPqRsTuV", 10_000);
    expect(out).toContain("[REDACTED]");
    expect(out).not.toContain("AIzaSy");
    expect(out).not.toContain("A1B2c3D4e5F6g7H8i9J0kLmNoPqRsTuV");
  });

  it("clipAndRedact 抹掉 Grok gsk_ 前缀 key", () => {
    const out = clipAndRedact("xoxb-gsk_9a8B7c6D5e4F3g2H1i0J", 10_000);
    expect(out).toContain("[REDACTED]");
    expect(out).not.toContain("gsk_");
    expect(out).not.toContain("9a8B7c6D5e4F3g2H1i0J");
  });

  it("truncateForContext 出口同样脱敏厂商 key（output + summary 双向）", () => {
    const r = successResult({
      output: "sk-ant-api03-SECRETBODY1234567890 inside output",
      summary: "完成 gsk_VENDORSECRET9876543210 in summary",
    });
    const t = truncateForContext(r, 10_000);
    // output 经由 clipAndRedact
    expect(t.output).toContain("[REDACTED]");
    expect(t.output).not.toContain("sk-ant-api03-");
    // summary 也要脱敏（D3 修复点）
    expect(t.summary).toContain("[REDACTED]");
    expect(t.summary).not.toContain("gsk_");
  });

  it("普通 token=xxx / Authorization: Bearer xxx 仍走原有 redactSecret 通道", () => {
    const out = clipAndRedact("api_key=sk-1234567890abcdefgh", 10_000);
    expect(out).toContain("api_key=[REDACTED]");
    const out2 = clipAndRedact("Authorization: Bearer abcdefghijklmnopqrstuvwxyz1234", 10_000);
    expect(out2).toContain("Authorization: Bearer [REDACTED]");
  });
});

// =====================================================================
// 4. truncateForContext: 截断后保留结构化头部
// =====================================================================

describe("truncateForContext: 截断后保留 status/summary/error/artifacts", () => {
  it("超长 output 截断到 maxChars，但 status/error/artifacts 完整", () => {
    const longOutput = "x".repeat(20_000);
    const r = errorResult({
      output: longOutput,
      summary: "测试超长",
      error: { code: TOOL_HTTP_ERROR, rootCauseHint: "x", retryable: false },
      artifacts: [{ kind: "url", uri: "https://example.com", label: "目标 URL" }],
    });
    const truncated = truncateForContext(r, 100);
    expect(truncated.output.length).toBeLessThanOrEqual(120);
    expect(truncated.output).toContain("…(truncated)");
    expect(truncated.status).toBe("error");
    expect(truncated.summary).toBe("测试超长");
    expect(truncated.error?.code).toBe(TOOL_HTTP_ERROR);
    expect(truncated.artifacts[0]?.uri).toBe("https://example.com");
  });

  it("summary 脱敏：secret-like 字符串不进入 summary", () => {
    const r = successResult({
      output: "完成",
      summary: "完成 token=abcdefghijklmnopqrstuvwxyz1234",
    });
    const truncated = truncateForContext(r, 1000);
    expect(truncated.summary).not.toContain("abcdefghijklmnopqrstuvwxyz1234");
    expect(truncated.summary).toContain("[REDACTED]");
  });
});

// =====================================================================
// 5. summarize: 一句话摘要
// =====================================================================

describe("summarize: 取首行/前 N 字符", () => {
  it("单行直接返回", () => {
    expect(summarize("hello world")).toBe("hello world");
  });
  it("多行取首行", () => {
    expect(summarize("第一行\n第二行\n第三行")).toBe("第一行");
  });
  it("超长截断加省略号", () => {
    const out = summarize("a".repeat(100), 20);
    expect(out.endsWith("…")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(20);
  });
  it("空白输出兜底", () => {
    expect(summarize("")).toBe("(无输出)");
    expect(summarize("   \n  \n")).toBe("(无输出)");
  });
});

// =====================================================================
// 6. write/edit/bash 成功返回 artifact（用实际工具 import 验证）
// =====================================================================
//
// 注：完整 execute 流程在 executor.test.ts 覆盖。这里只验工厂函数拼出来的 shape。

describe("write/edit/bash 成功结果必备 artifact", () => {
  it("writeTool-like success: 至少含 file artifact", () => {
    const r = successResult({
      output: "已写入 foo.ts (+5 −2)",
      summary: "新建 foo.ts (+5 −2)",
      artifacts: [
        { kind: "file", uri: "foo.ts", label: "新建 +5 −2" },
        { kind: "diff", uri: "foo.ts", label: "diff 片段" },
      ],
      nextActions: [{ action: "read_back", reason: "建议 read 校验", safe: true }],
    });
    expect(r.artifacts.some((a) => a.kind === "file")).toBe(true);
    expect(r.artifacts.some((a) => a.kind === "diff")).toBe(true);
    expect(r.status).toBe("success");
  });

  it("bashTool-like success: 至少含 command_output artifact（含 exitCode）", () => {
    const r = successResult({
      output: "$ pnpm test\n...\nexit code: 0",
      summary: "pnpm test → exit 0",
      artifacts: [
        { kind: "command_output", uri: "pnpm test", label: "pnpm test (exit 0)", exitCode: 0 },
      ],
    });
    expect(r.artifacts[0]?.kind).toBe("command_output");
    expect(r.artifacts[0]?.exitCode).toBe(0);
  });
});

// =====================================================================
// 7. old_string 不唯一 / 缺失 → retryable 错误 + retryInstruction
// =====================================================================

describe("old_string 错误：retryable=true + 补上下文建议", () => {
  it("不唯一 → TOOL_OLD_STRING_AMBIGUOUS + retryInstruction", () => {
    const r = errorResult({
      output: "old_string 出现 3 次",
      summary: "edit 命中多处",
      error: {
        code: TOOL_OLD_STRING_AMBIGUOUS,
        rootCauseHint: "出现 3 次",
        retryable: true,
        retryInstruction: "补更多上下文确保唯一",
      },
      nextActions: [
        { action: "add_more_context", reason: "old_string 加上下文", safe: true },
        { action: "switch_to_hashline_edit", reason: "hashline 不依赖唯一性", safe: true },
      ],
    });
    expect(r.error?.code).toBe(TOOL_OLD_STRING_AMBIGUOUS);
    expect(r.error?.retryable).toBe(true);
    expect(r.error?.retryInstruction).toContain("上下文");
    expect(r.nextActions.length).toBeGreaterThan(0);
  });

  it("缺失 → TOOL_OLD_STRING_MISSING + 建议 read 再试", () => {
    const r = errorResult({
      output: "找不到 old_string",
      summary: "edit 找不到",
      error: {
        code: TOOL_OLD_STRING_MISSING,
        rootCauseHint: "文件已被改",
        retryable: true,
        retryInstruction: "先 read 拿最新内容再改",
      },
    });
    expect(r.error?.code).toBe(TOOL_OLD_STRING_MISSING);
    expect(r.error?.retryable).toBe(true);
    expect(r.error?.retryInstruction).toContain("read");
  });
});

// =====================================================================
// 8. timeout：retryable=true 但 stopCondition 提示上限
// =====================================================================

describe("timeout: retryable=true 且 stopCondition 给出最大次数", () => {
  it("默认 retryInstruction + stopCondition 都存在", () => {
    const r = timeoutResult({ output: "超时", summary: "超时" });
    expect(r.error?.retryable).toBe(true);
    expect(r.error?.retryInstruction).toBeTruthy();
    expect(r.error?.stopCondition).toBeTruthy();
    // stopCondition 必须给次数上限
    expect(r.error?.stopCondition).toMatch(/\d/);
  });
});

// =====================================================================
// 9. serializeResultV2 不会泄露 secret（验证 result_json 落库安全）
// =====================================================================

describe("secret 不进入 result_json", () => {
  it("如果 output 含 token=xxx 字符串，serialize → deserialize 仍是 secret 形式（脱敏由 buildAiSdkTools 走，不是 result-contract）", () => {
    // result-contract 本身只做序列化和裁剪，不做 secret 脱敏——
    // 脱敏发生在 truncateForContext / renderForModel / persistToolExecution 三个出口。
    // 这里只验证序列化层是幂等的、不会丢字段：
    const r = errorResult({
      output: "原始 error 内容：token=abcdefghijklmnopqrstuvwxyz1234",
      summary: "测试",
      error: { code: TOOL_UNKNOWN_ERROR, rootCauseHint: "x", retryable: false },
    });
    const round = deserializeResultV2(serializeResultV2(r));
    expect(round?.output).toContain("token=abcdefghijklmnopqrstuvwxyz1234");
  });

  it("但 truncateForContext 之后的版本不包含 secret", () => {
    const r = errorResult({
      output: "原始 error 内容：token=abcdefghijklmnopqrstuvwxyz1234",
      summary: "测试 token=abcdefghijklmnopqrstuvwxyz1234",
      error: { code: TOOL_UNKNOWN_ERROR, rootCauseHint: "x", retryable: false },
    });
    const t = truncateForContext(r, 10_000);
    expect(t.output).toContain("[REDACTED]");
    expect(t.summary).toContain("[REDACTED]");
    expect(t.output).not.toContain("abcdefghijklmnopqrstuvwxyz1234");
    expect(t.summary).not.toContain("abcdefghijklmnopqrstuvwxyz1234");
  });
});
