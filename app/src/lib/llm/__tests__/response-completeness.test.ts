// C 档第1步（2026-07-12）：extractVisibleAnswerText / hasEffectiveOutput 单元测试。
// 覆盖用户实测复现的两个真实场景：思考写一半没闭合、正文后跟乱码碎片。
import { describe, it, expect } from "vitest";
import { extractVisibleAnswerText, hasEffectiveOutput } from "../response-completeness";

describe("extractVisibleAnswerText", () => {
  it("纯正文原样返回", () => {
    expect(extractVisibleAnswerText("星期日，2026 年 7 月 12 日。")).toBe(
      "星期日，2026 年 7 月 12 日。",
    );
  });

  it("剔除已闭合的 <think> 块，只留正文", () => {
    expect(extractVisibleAnswerText("<think>先想一下</think>这是正文")).toBe("这是正文");
  });

  it("思考写一半没闭合（用户实测复现场景）→ 可见正文为空", () => {
    const raw =
      "<think>用户在说我的回复里出现了 \"2026 年 7 月 12 日。\" 然后他问... 等等，回想一下 — 在内层 ";
    expect(extractVisibleAnswerText(raw)).toBe("");
  });

  it("只有空白字符 → trim 后为空", () => {
    expect(extractVisibleAnswerText("   \n\t  ")).toBe("");
  });

  it("空字符串 → 空", () => {
    expect(extractVisibleAnswerText("")).toBe("");
  });

  it("伪工具调用 JSON 也不算可见正文", () => {
    expect(extractVisibleAnswerText('{"name": "run_command", "arguments": {}}')).toBe("");
  });
});

describe("hasEffectiveOutput", () => {
  it("有可见正文 → true", () => {
    expect(hasEffectiveOutput("星期日，2026 年 7 月 12 日。", 0)).toBe(true);
  });

  it("正文只是未闭合思考块 → false", () => {
    expect(hasEffectiveOutput("<think>还没想完", 0)).toBe(false);
  });

  it("工具调用后仍只有思考、没有最终答复 → false", () => {
    expect(hasEffectiveOutput("<think>工具没找到，继续想办法</think>", 2)).toBe(false);
  });

  it("正文为空且无工具调用 → false", () => {
    expect(hasEffectiveOutput("", 0)).toBe(false);
  });

  it("结尾带乱码碎片、无实际正文（用户实测的 [e~[ 场景近似）→ 视具体内容而定", () => {
    // 乱码碎片本身不在任何折叠标签里，会被当成普通 text——这是预期行为：
    // 我们不对"看起来像乱码"做启发式黑名单，只对"完全没有可见内容"兜底。
    expect(hasEffectiveOutput("星期日，2026 年 7 月 12 日。[e~[", 0)).toBe(true);
  });
});
