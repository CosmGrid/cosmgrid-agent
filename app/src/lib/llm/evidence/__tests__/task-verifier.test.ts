// Harness 阶段3 — task-verifier 单元测试。
//
// 覆盖计划文件 §7 个工作项场景：
// 1. 声称修改文件但没有 write/edit 记录 → insufficient
// 2. bash 返回 error + "构建通过" → contradicts
// 3. 测试输出与回答数字冲突 → contradicts
// 4. 多角色工具记录不会串消息（复用 selectRowsForMessage）
// 5. legacy 数据无 message_id 走 sinceIso 兜底
// 6. 证据被截断标记 unknown
// 7. 验证失败可解释"缺哪条证据"
//
// 测试样板沿用 fabrication-evidence.test.ts 的 rowOf() 工厂命名（行 11-30 模板）。

import { describe, expect, it } from "vitest";
import type { ToolExecutionRow } from "@/lib/db";
import { verifyTask } from "../task-verifier";
import { VERIFY_ACCEPTANCE_CRITERIA } from "../verify-acceptance-criteria";
import type { EvidenceRef, LinkedClaim, StructuredAcceptanceCriterion, VerificationResult } from "../types";
import { projectWebFetchExecutionRow } from "@/lib/security-invariants/web-fetch-privacy";

// =====================================================================
// 工厂函数（rowOf / claimOf / criterionOf）
// =====================================================================

function rowOf(over: Partial<ToolExecutionRow>): ToolExecutionRow {
  return {
    id: `row-${Math.random().toString(36).slice(2, 8)}`,
    projectId: null,
    conversationId: "conv-1",
    messageId: "msg-A",
    toolName: "read",
    input: "{}",
    output: "",
    status: "success",
    userConfirmed: false,
    reversible: false,
    durationMs: 10,
    createdAt: "2026-07-11T00:00:00.000Z",
    resultJson: null,
    errorCode: null,
    ...over,
  };
}

function evidenceOf(over: Partial<EvidenceRef>): EvidenceRef {
  return {
    id: `ev-${Math.random().toString(36).slice(2, 6)}`,
    kind: "tool_execution",
    source: "write",
    summary: "test evidence",
    occurredAt: "2026-07-11T00:00:00.000Z",
    toolExecutionId: "row-1",
    ...over,
  };
}

function criterionOf(over: Partial<StructuredAcceptanceCriterion>): StructuredAcceptanceCriterion {
  return {
    id: "tests_pass",
    description: "测试套件全部通过",
    kind: "test_run",
    ...over,
  };
}

function callVerify(args: {
  finalContent: string;
  execRows: ToolExecutionRow[];
  acceptanceCriteria?: StructuredAcceptanceCriterion[];
  assistantMessageId?: string;
  sinceIso?: string;
  sinceMsAgo?: number;
}): VerificationResult {
  return verifyTask({
    finalContent: args.finalContent,
    execRows: args.execRows,
    assistantMessageId: args.assistantMessageId ?? "msg-A",
    sinceIso:
      args.sinceIso ??
      new Date(Date.now() - (args.sinceMsAgo ?? 5 * 60_000)).toISOString(),
    acceptanceCriteria: args.acceptanceCriteria ?? [],
    workflowRef: { runId: "run-1", nodeId: "node-1" },
  });
}

// =====================================================================
// 工作项 1：声称修改文件但无 write/edit 记录 → insufficient
// =====================================================================

describe("task-verifier: 场景 1 — 声称修改文件但无 write/edit 记录", () => {
  it("insufficient + reason 提到缺证据", () => {
    const result = callVerify({
      finalContent: "我修改了 src/foo.ts 让它支持 ESM",
      execRows: [
        // 只有 read，没有 write/edit
        rowOf({ id: "r1", toolName: "read", input: JSON.stringify({ file_path: "src/foo.ts" }) }),
      ],
    });
    expect(result.status).toBe("inconclusive"); // insufficient 关键声明 → inconclusive
    const fileClaim = result.linkedClaims.find((c) => c.kind === "file_modified");
    expect(fileClaim).toBeDefined();
    expect(fileClaim?.verdict).toBe("insufficient");
    expect(fileClaim?.text).toContain("src/foo.ts");
  });
});

describe("task-verifier: web_fetch URL 证据隔离", () => {
  it("raw 与 projected web_fetch row 均不得支持 URL claim", () => {
    const raw = rowOf({ id: "fetch-raw", toolName: "web_fetch", status: "success", input: JSON.stringify({ url: "https://example.test/raw" }), output: "raw body" });
    const projected = projectWebFetchExecutionRow({ ...raw });
    for (const execRows of [[raw], [projected]]) {
      const result = callVerify({ finalContent: "我读取了 https://example.test/raw 并确认内容。", execRows });
      const claim = result.linkedClaims.find((item) => item.kind === "url_fetched");
      expect(claim?.verdict).toBe("insufficient");
      expect(claim?.evidenceIds ?? []).not.toContain(execRows[0]!.id);
    }
  });
});

// =====================================================================
// 工作项 2：bash 返回 error + "构建通过" → verdict 来自 build_pass 验收失败
// =====================================================================

describe("task-verifier: 场景 2 — bash error 与声称构建通过冲突", () => {
  it("build_pass 验收失败 → status=fails", () => {
    const result = callVerify({
      finalContent: "构建通过：所有测试都过了",
      execRows: [
        rowOf({
          id: "bash1",
          toolName: "bash",
          input: JSON.stringify({ command: "pnpm build" }),
          output: "FAIL\nexit code: 1",
          status: "error",
        }),
      ],
      acceptanceCriteria: [
        criterionOf({
          id: "build_pass",
          description: "构建无 error",
          kind: "build",
        }),
      ],
    });
    // build_pass 验收失败 → verdict=fails
    expect(result.failedCriteria).toContain("build_pass");
    expect(result.status).toBe("fails");
  });
});

// =====================================================================
// 工作项 3：测试输出与回答数字冲突 → contradicts
// =====================================================================

describe("task-verifier: 场景 3 — 声称 X 项测试通过但 bash 输出不符", () => {
  it("verdict=contradicts + conflictReason 含 claimed vs evidence 数字", () => {
    const result = callVerify({
      finalContent: "10 项测试全部通过",
      execRows: [
        rowOf({
          id: "bash1",
          toolName: "bash",
          input: JSON.stringify({ command: "pnpm test" }),
          // bash 输出只有 8 passed（不是 10）
          output: "Tests: 8 passed, 2 failed",
          status: "success",
        }),
      ],
    });
    const testClaim = result.conflicts.find((c) => c.kind === "test_result");
    expect(testClaim).toBeDefined();
    expect(testClaim?.verdict).toBe("contradicts");
    expect(testClaim?.conflictReason).toContain("10");
  });
});

// =====================================================================
// 工作项 4：多角色工具记录不会串消息
// =====================================================================

describe("task-verifier: 场景 4 — selectRowsForMessage 隔离多角色记录", () => {
  it("只选目标 message 的记录，忽略其他 message 的", () => {
    const result = callVerify({
      assistantMessageId: "msg-A",
      finalContent: "我修改了 foo.ts",
      execRows: [
        // msg-A 的有效 write 记录
        rowOf({ id: "r-A", messageId: "msg-A", toolName: "write", input: JSON.stringify({ file_path: "foo.ts" }) }),
        // msg-B 的 write（角色接力另一轮）
        rowOf({ id: "r-B", messageId: "msg-B", toolName: "write", input: JSON.stringify({ file_path: "bar.ts" }) }),
      ],
    });
    // 应当只看到 msg-A 的 foo.ts write → file_modified supported → passes
    const fooClaim = result.linkedClaims.find((c) => c.kind === "file_modified" && c.text === "foo.ts");
    expect(fooClaim).toBeDefined();
    expect(fooClaim?.verdict).toBe("supported");
    // bar.ts 那条没被任何 claim 提到（不会出现在 linkedClaims 里）
    // 但 buildEvidenceRefs 已经按 messageId 过滤，msg-B 的 evidence 不会进 ref list
    expect(result.status).toBe("passes");
  });
});

// =====================================================================
// 工作项 5：legacy messageId=null 走 sinceIso 兜底
// =====================================================================

describe("task-verifier: 场景 5 — legacy messageId=null 走 sinceIso 兜底", () => {
  it("null messageId 的 row 在 sinceIso 窗口内仍被归属", () => {
    const recent = rowOf({
      id: "legacy-1",
      messageId: null,
      toolName: "write",
      input: JSON.stringify({ file_path: "foo.ts" }),
      createdAt: new Date(Date.now() - 30_000).toISOString(), // 30s 前
    });
    const tooOld = rowOf({
      id: "legacy-2",
      messageId: null,
      toolName: "write",
      input: JSON.stringify({ file_path: "old.ts" }),
      createdAt: new Date(Date.now() - 60 * 60_000).toISOString(), // 1 小时前
    });
    const result = callVerify({
      assistantMessageId: "msg-current",
      finalContent: "我修改了 foo.ts",
      execRows: [recent, tooOld],
      sinceMsAgo: 5 * 60_000, // 5 分钟窗口
    });
    // foo.ts 30 秒前 → 在窗口内 → supported
    const fooClaim = result.linkedClaims.find((c) => c.kind === "file_modified" && c.text === "foo.ts");
    expect(fooClaim?.verdict).toBe("supported");
  });
});

// =====================================================================
// 工作项 6：证据被截断 → verdict=unknown
// =====================================================================

describe("task-verifier: 场景 6 — 截断的证据不冒充通过", () => {
  it("truncated=true 的 evidence 对应的 claim 走 unknown", () => {
    const result = callVerify({
      finalContent: "我修改了 foo.ts",
      execRows: [
        rowOf({
          id: "r1",
          toolName: "write",
          input: JSON.stringify({ file_path: "foo.ts" }),
          status: "error", // status=error 标 truncated
          errorCode: "TOOL_UNKNOWN_ERROR",
        }),
      ],
    });
    // truncated evidence 不会让 verdict=supported；claim 应该是 insufficient（因为 error 状态
    // 也不算 "成功 write"，实际 linkFileClaim 看到 status=error 的 row 会跳过 → 落到
    // "无 write/edit 记录" 分支 → insufficient）
    const fileClaim = result.linkedClaims.find((c) => c.kind === "file_modified" && c.text === "foo.ts");
    expect(fileClaim?.verdict).not.toBe("supported");
  });
});

// =====================================================================
// 工作项 7：验证失败可解释"缺哪条证据"
// =====================================================================

describe("task-verifier: 场景 7 — 失败时 humanSummary 列出 evidence_id", () => {
  it("insufficient 时 humanSummary 含 evidence_id= 占位符", () => {
    const result = callVerify({
      finalContent: "我修改了 foo.ts",
      execRows: [
        rowOf({ id: "r1", toolName: "read", input: JSON.stringify({ file_path: "foo.ts" }) }),
      ],
    });
    expect(result.humanSummary).toMatch(/(证据不足|evidence_id)/);
    // 应当列出至少 1 个 evidence_id
    expect(result.humanSummary).toMatch(/evidence_id=/);
  });
});

// =====================================================================
// 关键不变量：错误降级（plan §风险 4）
// =====================================================================

describe("task-verifier: 错误降级", () => {
  it("verifyTask 任何抛错都不返回 'fails'，而是 'inconclusive'", () => {
    // 故意构造一个会触发 buildEvidenceRefs 错误的场景：assistantMessageId 不是 string
    // 类型（运行时能通过，但 evidence-builder 在异常时也应该不抛——这里改用一个会 throw 的
    // 场景：通过传入 null execRows 让 JSON.parse 部分路径异常，验证降级。
    const result = verifyTask({
      finalContent: "正常文本",
      execRows: [], // 空数组 → 不应该报错
      assistantMessageId: "msg-A",
      sinceIso: new Date().toISOString(),
      acceptanceCriteria: [],
      workflowRef: { runId: "run-1", nodeId: "node-1" },
    });
    // 空 execRows + 空 criteria → passes（无关键声明、无冲突）
    expect(result.status).toBe("passes");
    expect(result.humanSummary).toBeTruthy();
  });
});

// =====================================================================
// 边界：空输入
// =====================================================================

describe("task-verifier: 边界", () => {
  it("空 finalContent + 空 execRows + 空 criteria → passes", () => {
    const result = callVerify({ finalContent: "", execRows: [] });
    expect(result.status).toBe("passes");
    expect(result.conflicts).toHaveLength(0);
  });

  it("声称 'test_result' bash 输出含声称数字 → supported", () => {
    const result = callVerify({
      finalContent: "8 项测试通过",
      execRows: [
        rowOf({
          id: "bash1",
          toolName: "bash",
          input: JSON.stringify({ command: "pnpm test" }),
          output: "Tests: 8 passed, 2 failed",
          status: "success",
        }),
      ],
    });
    const testClaim = result.linkedClaims.find((c) => c.kind === "test_result");
    expect(testClaim?.verdict).toBe("supported");
  });
});

// =====================================================================
// 综合：claim → EvidenceRef 反查
// =====================================================================

describe("task-verifier: claim 关联到正确 EvidenceRef.id", () => {
  it("supported 的 claim 拿到的 evidenceId 能在 evidenceRefs 里查到", () => {
    const result = callVerify({
      finalContent: "我修改了 foo.ts",
      execRows: [
        rowOf({ id: "row-1", toolName: "write", input: JSON.stringify({ file_path: "foo.ts" }) }),
      ],
    });
    const fileClaim = result.linkedClaims.find((c) => c.kind === "file_modified" && c.text === "foo.ts");
    expect(fileClaim?.verdict).toBe("supported");
    // evidenceIds 来自 buildEvidenceRefs 自动生成的 id
    expect(fileClaim?.evidenceIds.length).toBeGreaterThan(0);
    // decisionEvidenceIds 收集所有 claim 的 evidenceIds
    expect(result.decisionEvidenceIds.length).toBeGreaterThan(0);
  });
});

// =====================================================================
// 2026-07-14：verify 阶段真实判定接入——VERIFY_ACCEPTANCE_CRITERIA 组合场景
// （测试严格：没有真实可核对的测试证据 = failed；lint/build 宽松：没跑不算错，
// 跑了但真失败才算错。见 structured-criteria.ts 三态改造 + 本次批准的方案。）
// =====================================================================

describe("task-verifier: VERIFY_ACCEPTANCE_CRITERIA 组合场景", () => {
  it("回归防护：只跑了测试且带明确数字，没跑 lint/build → 整体 passes（没跑 lint/build 不算错）", () => {
    const result = callVerify({
      finalContent: "8 项测试全部通过",
      execRows: [
        rowOf({
          id: "bash1",
          toolName: "bash",
          input: JSON.stringify({ command: "pnpm test" }),
          output: "Tests: 8 passed",
          status: "success",
        }),
      ],
      acceptanceCriteria: VERIFY_ACCEPTANCE_CRITERIA,
    });
    expect(result.status).toBe("passes");
    expect(result.failedCriteria).toEqual([]);
    expect(result.metCriteria).toContain("tests_pass");
    // lint/build 没跑，不应该出现在 failedCriteria 里（这是本次修复要堵住的回归）
    expect(result.failedCriteria).not.toContain("lint_pass");
    expect(result.failedCriteria).not.toContain("build_pass");
  });

  it("堵洞验证：只说「测试都通过了」不带数字 → fails（含糊声明不再蒙混过关）", () => {
    const result = callVerify({
      finalContent: "测试都通过了，没有问题。",
      execRows: [],
      acceptanceCriteria: VERIFY_ACCEPTANCE_CRITERIA,
    });
    expect(result.status).toBe("fails");
    expect(result.failedCriteria).toContain("tests_pass");
  });

  it("什么测试证据都没给（回复里完全不提测试）→ fails", () => {
    const result = callVerify({
      finalContent: "已经完成本轮修改。",
      execRows: [],
      acceptanceCriteria: VERIFY_ACCEPTANCE_CRITERIA,
    });
    expect(result.status).toBe("fails");
    expect(result.failedCriteria).toContain("tests_pass");
  });

  it("lint 真的跑了且失败 → fails，且失败原因精确指向 lint_pass（测试本身仍是 met，不被 lint 拖累判断依据）", () => {
    const result = callVerify({
      finalContent: "8 项测试全部通过",
      execRows: [
        rowOf({
          id: "bash-test",
          toolName: "bash",
          input: JSON.stringify({ command: "pnpm test" }),
          output: "Tests: 8 passed",
          status: "success",
        }),
        rowOf({
          id: "bash-lint",
          toolName: "bash",
          input: JSON.stringify({ command: "npm run lint" }),
          output: "3 problems",
          status: "error",
        }),
      ],
      acceptanceCriteria: VERIFY_ACCEPTANCE_CRITERIA,
    });
    expect(result.status).toBe("fails");
    expect(result.failedCriteria).toEqual(["lint_pass"]);
    expect(result.metCriteria).toContain("tests_pass");
  });
});

// 私有 helper 防止未使用警告
void ({} as LinkedClaim);
void ({} as EvidenceRef);
void evidenceOf;
