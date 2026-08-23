import { describe, it, expect } from "vitest";
import { evaluateHarness, isClean, buildCorrectionPrompt, detectIntentNoToolCall, buildIntentNudgePrompt } from "../feedback";
import type { ReadRecord, FetchRecord, ExecRecord } from "../verify-claims";

const readOf = (file_path: string): ReadRecord => ({ input: JSON.stringify({ file_path }), status: "success" });
const fetchOf = (url: string): FetchRecord => ({ input: JSON.stringify({ url }), status: "success" });
const bashOf = (command: string): ExecRecord => ({ input: JSON.stringify({ command }), status: "success" });

describe("evaluateHarness", () => {
  it("声称读了文件但无 read 记录 → 标为未验证", () => {
    const v = evaluateHarness("我读取了 app/src/lib/db.ts，里面有 19 张表", []);
    expect(v.unverifiedPaths).toContain("app/src/lib/db.ts");
    expect(isClean(v)).toBe(false);
  });

  it("声称读的文件有真实 read 记录 → 干净", () => {
    const v = evaluateHarness("我读取了 app/src/lib/db.ts，里面有 19 张表", [readOf("app/src/lib/db.ts")]);
    expect(v.unverifiedPaths).toEqual([]);
    expect(isClean(v)).toBe(true);
  });

  it("吐伪工具调用文本 → 抓到伪工具名", () => {
    const v = evaluateHarness('<run_command>{"command":"ls"}</run_command>', []);
    expect(v.pseudoToolNames).toContain("run_command");
    expect(isClean(v)).toBe(false);
  });

  it("纯闲聊无违规 → 干净", () => {
    expect(isClean(evaluateHarness("你好，今天天气不错", []))).toBe(true);
  });

  // 真实事故（2026-07-07）：模型编"我读到 https://... 说……"，实际 web_fetch 没成功——
  // 这类网页 claim 之前完全不在覆盖范围（filterReadRecordsSince 只认 read 工具）。
  it("声称抓取过网页但无 web_fetch 记录 → 标为未验证", () => {
    const v = evaluateHarness("我读到了 https://github.com/foo/bar 说这是个 MIT 项目", [], 0, []);
    expect(v.unverifiedUrls).toContain("https://github.com/foo/bar");
    expect(isClean(v)).toBe(false);
  });

  it("即使有 raw web_fetch 成功记录也 fail closed", () => {
    const v = evaluateHarness(
      "我读到了 https://github.com/foo/bar 说这是个 MIT 项目",
      [],
      0,
      [fetchOf("https://github.com/foo/bar")],
    );
    expect(v.unverifiedUrls).toEqual(["https://github.com/foo/bar"]);
    expect(isClean(v)).toBe(false);
  });

  it("不传 fetchRecords（旧调用点）→ 按最严格口径判定，跟不传 read 记录一样会被标未验证", () => {
    const v = evaluateHarness("我读到了 https://github.com/foo/bar 说这是个 MIT 项目", []);
    expect(v.unverifiedUrls).toContain("https://github.com/foo/bar");
  });

  // 真实事故（2026-07-07，系统性排查）：grep/bash/web_search 三个工具完全没接过校验——
  // 不管换哪个模型，"我跑了 `pnpm test` 都过了"这类谎都抓不到，这才是"换什么模型都会编"
  // 的真正原因（覆盖面问题，不是模型问题）。
  it("声称跑过命令但无 bash/grep/web_search 记录 → 标为未验证", () => {
    const v = evaluateHarness("我运行了 `pnpm test`，全部通过", [], 0, [], []);
    expect(v.unverifiedCommands).toContain("pnpm test");
    expect(isClean(v)).toBe(false);
  });

  it("声称跑过的命令有真实 bash 成功记录 → 干净", () => {
    const v = evaluateHarness("我运行了 `pnpm test`，全部通过", [], 0, [], [bashOf("pnpm test")]);
    expect(v.unverifiedCommands).toEqual([]);
    expect(isClean(v)).toBe(true);
  });

  it("不传 execRecords（旧调用点）→ 按最严格口径判定", () => {
    const v = evaluateHarness("我运行了 `pnpm test`，全部通过", []);
    expect(v.unverifiedCommands).toContain("pnpm test");
  });
});

describe("buildCorrectionPrompt", () => {
  it("干净 verdict → 空串", () => {
    expect(buildCorrectionPrompt({ unverifiedPaths: [], pseudoToolNames: [] }, { hasTools: true })).toBe("");
  });

  it("有工具 + 未验证路径 → 叫模型去真调 read", () => {
    const p = buildCorrectionPrompt({ unverifiedPaths: ["a/b.ts"], pseudoToolNames: [] }, { hasTools: true });
    expect(p).toContain("a/b.ts");
    expect(p).toContain("read");
    expect(p).toContain("真正调用");
  });

  it("无工具 + 未验证路径 → 叫模型别编、让用户贴内容", () => {
    const p = buildCorrectionPrompt({ unverifiedPaths: ["a/b.ts"], pseudoToolNames: [] }, { hasTools: false });
    expect(p).toContain("没有可用的文件工具");
    expect(p).toContain("贴过来");
    expect(p).not.toContain("真正调用 read");
  });

  it("无工具 + 伪工具调用 → 叫模型别再吐工具格式", () => {
    const p = buildCorrectionPrompt({ unverifiedPaths: [], pseudoToolNames: ["run_command"] }, { hasTools: false });
    expect(p).toContain("run_command");
    expect(p).toContain("不要再输出任何工具调用格式");
  });

  it("有工具 + 伪工具调用 → 叫模型改用结构化 tool_call", () => {
    const p = buildCorrectionPrompt({ unverifiedPaths: [], pseudoToolNames: ["view_file"] }, { hasTools: true });
    expect(p).toContain("结构化 tool_call");
  });

  it("有工具 + 未验证 URL → 仍只允许依据可见来源作答", () => {
    const p = buildCorrectionPrompt(
      { unverifiedPaths: [], unverifiedUrls: ["https://example.com/a"], pseudoToolNames: [] },
      { hasTools: true },
    );
    expect(p).toContain("https://example.com/a");
    expect(p).toContain("正文、截图或其他可见来源");
    expect(p).not.toContain("有可用的 web_fetch 工具");
  });

  it("无工具 + 未验证 URL → 叫模型别编、让用户贴内容", () => {
    const p = buildCorrectionPrompt(
      { unverifiedPaths: [], unverifiedUrls: ["https://example.com/a"], pseudoToolNames: [] },
      { hasTools: false },
    );
    expect(p).toContain("正文、截图或其他可见来源");
    expect(p).not.toContain("有可用的 web_fetch 工具");
  });

  it("有工具 + 未验证命令 → 叫模型去真调 bash/grep/web_search", () => {
    const p = buildCorrectionPrompt(
      { unverifiedPaths: [], unverifiedCommands: ["pnpm test"], pseudoToolNames: [] },
      { hasTools: true },
    );
    expect(p).toContain("pnpm test");
    expect(p).toContain("bash/grep/web_search");
    expect(p).toContain("真正调用");
  });

  it("无工具 + 未验证命令 → 叫模型别编、让用户贴结果", () => {
    const p = buildCorrectionPrompt(
      { unverifiedPaths: [], unverifiedCommands: ["pnpm test"], pseudoToolNames: [] },
      { hasTools: false },
    );
    expect(p).toContain("没有可用的命令/搜索工具");
    expect(p).toContain("贴过来");
  });

  it("没有 unverifiedUrls/unverifiedCommands 字段（旧调用点字面量）→ isClean 不受影响", () => {
    expect(isClean({ unverifiedPaths: [], pseudoToolNames: [] })).toBe(true);
  });
});

describe("detectIntentNoToolCall（阶段 H：有意图无工具调用）", () => {
  it("【触发】我先去看一下 foo.ts", () => {
    expect(detectIntentNoToolCall("我先去看一下 foo.ts")).toBe(true);
  });
  it("【触发】让我打开 src 看看", () => {
    expect(detectIntentNoToolCall("让我打开 src 看看")).toBe(true);
  });
  it("【触发】我来处理这个 bug", () => {
    expect(detectIntentNoToolCall("我来处理这个 bug")).toBe(true);
  });
  it("【触发】让我们跑一下 build", () => {
    expect(detectIntentNoToolCall("让我们跑一下 build")).toBe(true);
  });
  it("【触发】让我先查一下 src/lib/db.ts", () => {
    expect(detectIntentNoToolCall("让我先查一下 src/lib/db.ts")).toBe(true);
  });
  it("【不触发】我先回答你的问题（'回答'不是动作动词）", () => {
    expect(detectIntentNoToolCall("我先回答你的问题")).toBe(false);
  });
  it("【不触发】我建议你这样做（无触发词）", () => {
    expect(detectIntentNoToolCall("我建议你这样做")).toBe(false);
  });
  it("【不触发】答案是 42（纯文字）", () => {
    expect(detectIntentNoToolCall("答案是 42")).toBe(false);
  });
  it("【不触发】空字符串", () => {
    expect(detectIntentNoToolCall("")).toBe(false);
  });
  it("【边界】'我看看' 无完整触发词 → 不触发（漏报 OK，漏报优于误报）", () => {
    expect(detectIntentNoToolCall("我看看")).toBe(false);
  });

  // 真实事故补测（2026-07-04）：模型说"再试一次"/"再发一次"完全不带"我先/让我"前缀，
  // 原正则漏检，导致这句空手套白狼直接放行——见 feedback.ts 里 RETRY_NO_TOOL_RE 的注释。
  it("【触发】好，再试一次。（无'我先/让我'前缀的重试语气）", () => {
    expect(detectIntentNoToolCall("好，再试一次。")).toBe(true);
  });
  it("【触发】我这边上一轮发请求好像没返回，再发一次。", () => {
    expect(detectIntentNoToolCall("我这边上一轮发请求好像没返回，再发一次。")).toBe(true);
  });
  it("【触发】重新试一下", () => {
    expect(detectIntentNoToolCall("重新试一下")).toBe(true);
  });

  // 真实事故补测（2026-07-07）：Haiku 4.5 说"抱歉，我说了没做。现在真正保存。等待权限提示。"
  // 却 0 工具调用。原正则动词表没有"保存"、也不认"现在/正在/等待权限"这类将来进行时话术，
  // 完全漏检——见 feedback.ts 里 FAKE_PROGRESS_RE 和 INTENT_NO_TOOL_RE 动词表扩充的注释。
  it("【触发】现在真正保存。等待权限提示。（本次事故原句）", () => {
    expect(detectIntentNoToolCall("抱歉，我说了没做。现在真正保存。等待权限提示。")).toBe(true);
  });
  it("【触发】让我保存一下（文件产出动词'保存'补进动词表）", () => {
    expect(detectIntentNoToolCall("让我保存一下到桌面")).toBe(true);
  });
  it("【触发】正在写入文件（假装正在进行）", () => {
    expect(detectIntentNoToolCall("好的，正在写入文件，请稍候。")).toBe(true);
  });
  it("【触发】等待权限确认（假装在等外部审批流程）", () => {
    expect(detectIntentNoToolCall("我这就导出，等待权限确认。")).toBe(true);
  });
  it("【触发】马上保存到桌面（将来时承诺）", () => {
    expect(detectIntentNoToolCall("好，马上保存到桌面。")).toBe(true);
  });
  it("【边界】'你可以自己保存到桌面'（建议用户做，非将来进行时自述）→ 不触发", () => {
    expect(detectIntentNoToolCall("你可以自己把内容保存到桌面。")).toBe(false);
  });
});

describe("buildIntentNudgePrompt（阶段 H：nudge 重答话术）", () => {
  it("非空字符串，含'直接调用'工具 + 解释意图", () => {
    const p = buildIntentNudgePrompt();
    expect(p.length).toBeGreaterThan(0);
    expect(p).toContain("直接调用");
    expect(p).toContain("意图");
  });
  it("跟 buildCorrectionPrompt 话术不同（nudge 是'嘴上说要做'口径，不是'你编了'口径）", () => {
    const nudge = buildIntentNudgePrompt();
    const correction = buildCorrectionPrompt({ unverifiedPaths: ["x.ts"], pseudoToolNames: [] }, { hasTools: true });
    expect(nudge).not.toBe(correction);
    expect(nudge).not.toContain("编造"); // nudge 不说编造
    expect(correction).toContain("编造"); // correction 说编造
  });
});

// ===== 防编造（fabrication-judge）字段 =====
describe("fabricationSuspected 字段（防编造阶段 B 闭环）", () => {
  it("fabricationSuspected 非空 → isClean 返回 false", () => {
    const v = {
      unverifiedPaths: [],
      pseudoToolNames: [],
      fabricationSuspected: { claimedActions: ["查询了 example.db"], reason: "无工具来源的具体命中" },
    };
    expect(isClean(v)).toBe(false);
  });

  it("fabricationSuspected 为 null/undefined → 不影响 isClean（其他字段干净时仍 true）", () => {
    expect(isClean({ unverifiedPaths: [], pseudoToolNames: [], fabricationSuspected: null })).toBe(true);
    expect(isClean({ unverifiedPaths: [], pseudoToolNames: [] })).toBe(true);
  });

  it("fabricationSuspected 与 unverifiedPaths 同存 → isClean 仍返 false（多源不互相抵消）", () => {
    expect(
      isClean({
        unverifiedPaths: ["x.ts"],
        pseudoToolNames: [],
        fabricationSuspected: { claimedActions: [], reason: "x" },
      }),
    ).toBe(false);
  });

  it("有工具 + fabricationSuspected → 纠正话术要求真正调用工具重答（不要凭记忆补数字/命中）", () => {
    const p = buildCorrectionPrompt(
      {
        unverifiedPaths: [],
        pseudoToolNames: [],
        fabricationSuspected: {
          claimedActions: ["查询了 example.db", "person 表 3 条记录"],
          reason: "无工具来源的具体命中",
        },
      },
      { hasTools: true },
    );
    expect(p).toContain("真正调用对应工具");
    expect(p).toContain("不要凭记忆补数字");
    expect(p).toContain("查询了 example.db");
    expect(p).toContain("person 表 3 条记录");
    expect(p).toContain("无工具来源的具体命中");
  });

  it("无工具 + fabricationSuspected → 纠正话术承认无法验证、不再编造具体结果", () => {
    const p = buildCorrectionPrompt(
      {
        unverifiedPaths: [],
        pseudoToolNames: [],
        fabricationSuspected: { claimedActions: ["x"], reason: "y" },
      },
      { hasTools: false },
    );
    expect(p).toContain("无法验证");
    expect(p).not.toContain("真正调用对应工具"); // 无工具时不该要求调用
    expect(p).not.toContain("不要凭记忆补数字"); // 这条是有工具时的口径
  });

  it("fabricationSuspected 单独存在（其他字段干净）→ buildCorrectionPrompt 仍返回非空串（不漏 fabrication 分支）", () => {
    const p = buildCorrectionPrompt(
      {
        unverifiedPaths: [],
        pseudoToolNames: [],
        fabricationSuspected: { claimedActions: ["x"], reason: "y" },
      },
      { hasTools: true },
    );
    expect(p.length).toBeGreaterThan(0);
    expect(p).toContain("⚠️"); // 跟其他分支一致的开头
  });

  it("fabricationSuspected 字段为可空（向后兼容旧调用点）", () => {
    // evaluateHarness 返回值不含 fabricationSuspected，旧调用点也不会传
    const oldVerdict = evaluateHarness("纯闲聊", []);
    expect(oldVerdict.fabricationSuspected).toBeUndefined();
    expect(isClean(oldVerdict)).toBe(true);
  });
});
