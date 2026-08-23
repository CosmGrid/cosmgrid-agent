import { describe, it, expect } from "vitest";
import {
  selectRowsForMessage,
  buildFabricationEvidenceSummary,
} from "../fabrication-evidence";
import type { ToolExecutionRow } from "@/lib/db";

const rowOf = (overrides: Partial<ToolExecutionRow>): ToolExecutionRow => ({
  id: `row-${Math.random().toString(36).slice(2, 8)}`,
  projectId: null,
  conversationId: "conv-1",
  messageId: null,
  toolName: "read",
  input: "{}",
  output: "",
  status: "ok",
  userConfirmed: false,
  reversible: true,
  durationMs: 0,
  createdAt: new Date().toISOString(),
  resultJson: null,
  errorCode: null,
  ...overrides,
});

describe("selectRowsForMessage 证据归属（红蓝对抗攻击 3：证据串轮）", () => {
  it("当前消息只读取自己 messageId 的记录", () => {
    const rows: ToolExecutionRow[] = [
      rowOf({ id: "r1", messageId: "msg-A", toolName: "read", input: '{"file_path":"a.ts"}' }),
      rowOf({ id: "r2", messageId: "msg-B", toolName: "read", input: '{"file_path":"b.ts"}' }),
      rowOf({ id: "r3", messageId: "msg-A", toolName: "bash", input: '{"command":"ls"}' }),
    ];
    const out = selectRowsForMessage(rows, {
      assistantMessageId: "msg-A",
      sinceIso: "2020-01-01T00:00:00Z",
    });
    expect(out.map((r) => r.id).sort()).toEqual(["r1", "r3"]);
  });

  it("相邻消息即使时间接近也不能互相借用证据（messageId 优先，不走时间兜底）", () => {
    const rows: ToolExecutionRow[] = [
      rowOf({ id: "r1", messageId: "msg-prev", createdAt: "2026-01-01T00:00:00.000Z" }),
      rowOf({ id: "r2", messageId: "msg-current", createdAt: "2026-01-01T00:00:00.001Z" }),
      rowOf({ id: "r3", messageId: "msg-next", createdAt: "2026-01-01T00:00:00.002Z" }),
    ];
    const out = selectRowsForMessage(rows, {
      assistantMessageId: "msg-current",
      sinceIso: "2020-01-01T00:00:00Z",
    });
    expect(out.map((r) => r.id)).toEqual(["r2"]);
  });

  it("messageId 缺失的旧记录走 sinceIso 时间兜底（不会污染已有真实归属的新行）", () => {
    const rows: ToolExecutionRow[] = [
      rowOf({ id: "r-legacy-old", messageId: null, createdAt: "2025-01-01T00:00:00Z" }),
      rowOf({ id: "r-legacy-new", messageId: null, createdAt: "2026-06-01T00:00:00Z" }),
      rowOf({ id: "r-new", messageId: "msg-other", createdAt: "2026-06-01T00:00:00Z" }),
    ];
    // 当前消息 messageId 没匹配上任何带 messageId 的行 → 走 legacyRows 池 + 时间兜底
    const out = selectRowsForMessage(rows, {
      assistantMessageId: "msg-not-exist",
      sinceIso: "2026-01-01T00:00:00Z",
    });
    expect(out.map((r) => r.id).sort()).toEqual(["r-legacy-new"]); // 只收新的 legacy，旧 legacy 被时间窗口排除
  });

  it("没传 messageId 也没 sinceIso → 返回空（防御性，宁漏勿串）", () => {
    const rows: ToolExecutionRow[] = [
      rowOf({ id: "r1", messageId: "msg-A" }),
      rowOf({ id: "r2", messageId: null }),
    ];
    expect(selectRowsForMessage(rows, { assistantMessageId: null, sinceIso: null })).toEqual([]);
  });

  it("sinceIso 无效（NaN）→ 返回空", () => {
    const rows: ToolExecutionRow[] = [
      rowOf({ id: "r1", messageId: null, createdAt: "2026-01-01T00:00:00Z" }),
    ];
    expect(
      selectRowsForMessage(rows, { assistantMessageId: "missing", sinceIso: "not-a-date" }),
    ).toEqual([]);
  });

  it("messageId 匹配为空 → 检查 legacyRows（不会因为没匹配就直接返空）", () => {
    const rows: ToolExecutionRow[] = [
      rowOf({ id: "r-legacy", messageId: null, createdAt: "2026-06-01T00:00:00Z" }),
    ];
    const out = selectRowsForMessage(rows, {
      assistantMessageId: "msg-not-in-rows",
      sinceIso: "2026-01-01T00:00:00Z",
    });
    expect(out.map((r) => r.id)).toEqual(["r-legacy"]);
  });
});

describe("buildFabricationEvidenceSummary 摘要构造", () => {
  it("空数组 → 空字符串", () => {
    expect(buildFabricationEvidenceSummary([])).toBe("");
  });

  it("单条记录 → 单行文本，含 toolName/status/messageId/input/output", () => {
    const rows: ToolExecutionRow[] = [
      rowOf({
        toolName: "read",
        status: "ok",
        messageId: "msg-A",
        input: '{"file_path":"a.ts"}',
        output: "export const x = 1;",
      }),
    ];
    const out = buildFabricationEvidenceSummary(rows);
    expect(out).toContain("toolName=read");
    expect(out).toContain("status=ok");
    expect(out).toContain("messageId=msg-A");
    expect(out).toContain("a.ts");
    expect(out).toContain("export const x = 1;");
  });

  it("error/denied 记录保留 status=error/denied（让裁判看到不能算成功）", () => {
    const rows: ToolExecutionRow[] = [
      rowOf({ id: "r1", toolName: "bash", status: "error", messageId: "msg-A", output: "Permission denied" }),
      rowOf({ id: "r2", toolName: "bash", status: "denied", messageId: "msg-A", output: "user rejected" }),
    ];
    const out = buildFabricationEvidenceSummary(rows);
    expect(out).toContain("status=error");
    expect(out).toContain("status=denied");
  });

  it("input/output 里的密钥/api_key 被脱敏成 <redacted>", () => {
    const rows: ToolExecutionRow[] = [
      rowOf({
        toolName: "bash",
        messageId: "msg-A",
        input: '{"command":"curl -H Authorization: Bearer sk-abc123def456"}',
        output: 'api_key=sk-secret999\n{"token":"jwt-xxx"}',
      }),
    ];
    const out = buildFabricationEvidenceSummary(rows);
    expect(out).toContain("<redacted>");
    expect(out).not.toContain("sk-abc123def456");
    expect(out).not.toContain("sk-secret999");
    expect(out).not.toContain("jwt-xxx");
  });

  it("单条 output 超过 PER_OUTPUT_MAX（600 字符）→ 截断", () => {
    const longOutput = "x".repeat(1000);
    const rows: ToolExecutionRow[] = [
      rowOf({ toolName: "read", messageId: "msg-A", output: longOutput }),
    ];
    const out = buildFabricationEvidenceSummary(rows);
    expect(out).toContain("truncated");
    expect(out.length).toBeLessThan(1000);
  });

  it("总长度超过 TOTAL_MAX（4000 字符）→ 末尾追加『还有 N 条记录省略』", () => {
    const rows: ToolExecutionRow[] = Array.from({ length: 50 }, (_, i) =>
      rowOf({
        id: `r${i}`,
        toolName: "read",
        messageId: "msg-A",
        input: `{"file_path":"/some/file/with/a/longer/path/to/blow/space/${i}.ts"}`,
        output: "y".repeat(200),
      }),
    );
    const out = buildFabricationEvidenceSummary(rows);
    expect(out).toContain("还有");
    expect(out).toContain("条记录省略");
    expect(out.length).toBeLessThanOrEqual(4100); // 留点余量
  });

  it("messageId 为 null 的旧记录 → 在摘要里显示 <legacy>", () => {
    const rows: ToolExecutionRow[] = [
      rowOf({ toolName: "read", messageId: null, input: '{"file_path":"old.ts"}', output: "x" }),
    ];
    const out = buildFabricationEvidenceSummary(rows);
    expect(out).toContain("messageId=<legacy>");
  });

  it("raw web_fetch 经精确与 legacy 归属后，selected/summary 均不含 URL/body sentinel", () => {
    const sentinels = ["FAB_USERINFO_SENTINEL", "FAB_QUERY_SENTINEL", "FAB_FRAGMENT_SENTINEL", "FAB_FINAL_URL_SENTINEL", "FAB_BODY_SENTINEL"];
    const raw = rowOf({ toolName: "web_fetch", status: "success", messageId: "msg-fab", input: JSON.stringify({ url: `https://u:${sentinels[0]}@example.test/?q=${sentinels[1]}#${sentinels[2]}` }), output: `${sentinels[3]} ${sentinels[4]}`, resultJson: JSON.stringify({ finalUrl: sentinels[3], body: sentinels[4] }) });
    const selected = selectRowsForMessage([raw], { assistantMessageId: "msg-fab", sinceIso: null });
    expect(JSON.stringify(selected)).not.toContain("SENTINEL");
    expect(selected[0]).toMatchObject({ input: JSON.stringify({ version: 1, toolName: "web_fetch", redacted: true }), output: "[web_fetch output withheld]" });
    expect(buildFabricationEvidenceSummary(selected)).not.toContain("SENTINEL");

    const legacy = selectRowsForMessage([{ ...raw, messageId: null, createdAt: "2026-08-01T00:00:00Z" }], { assistantMessageId: "missing", sinceIso: "2026-01-01T00:00:00Z" });
    expect(JSON.stringify(legacy)).not.toContain("SENTINEL");
  });
});
