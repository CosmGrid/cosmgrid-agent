import { describe, expect, it } from "vitest";
import {
  formatCooldownCountdownMessage,
  formatCooldownRemaining,
  parseCooldownCountdownMessage,
} from "../cooldown-error";

describe("cooldown error countdown", () => {
  it("解析分钟级全员冷却错误，并按 elapsed 生成倒计时文案", () => {
    const parsed = parseCooldownCountdownMessage(
      "所有可用模型目前都在冷却中：MiniMax-M3（还需 5 分钟）、Kimi（还需 1 分钟）。倒计时结束后可以继续发送",
    );

    expect(parsed).toEqual({
      entries: [
        { modelName: "MiniMax-M3", remainingMs: 300_000 },
        { modelName: "Kimi", remainingMs: 60_000 },
      ],
    });
    expect(formatCooldownCountdownMessage(parsed!, 61_000)).toBe(
      "所有可用模型目前都在冷却中：MiniMax-M3（还需 3 分 59 秒）。倒计时结束后可以继续发送",
    );
  });

  it("解析分钟加秒，倒计时结束后提示可重试", () => {
    const parsed = parseCooldownCountdownMessage("所有可用模型目前都在冷却中：MiniMax-M3（还需 1 分 5 秒）。");

    expect(parsed?.entries[0]).toEqual({ modelName: "MiniMax-M3", remainingMs: 65_000 });
    expect(formatCooldownCountdownMessage(parsed!, 65_000)).toBe("模型冷却已结束，可以重试了。");
  });

  it("普通错误不进入倒计时分支", () => {
    expect(parseCooldownCountdownMessage("网络连接失败，请检查网络或 Base URL 配置")).toBeNull();
  });

  // 2026-07-16 review 修复回归测试：chat-fallback.ts 现在会把 quota 耗尽（非 cooldown）的
  // 模型标成"套餐额度已用尽，等待无效"（不含"还需"字样），混在同一条错误消息里。这类条目
  // 不该被 COOLDOWN_ENTRY_RE 误抓进活的倒计时——它们没有真实倒计时可言，抓进去的话倒计时
  // 结束后会被 formatCooldownCountdownMessage 的"模型冷却已结束，可以重试了"误导成好像
  // 额度也恢复了。只有真正带"还需 N 秒/分"的条目才应该出现在 entries 里。
  it("quota 耗尽条目（无'还需'字样）不进入活的倒计时，只有真冷却条目会", () => {
    const parsed = parseCooldownCountdownMessage(
      "所有可用模型目前都在冷却中：MiniMax-M3（还需 2 分钟）、agnes-2.0-flash（套餐额度已用尽，等待无效）。倒计时结束后可以继续发送",
    );

    expect(parsed).toEqual({
      entries: [{ modelName: "MiniMax-M3", remainingMs: 120_000 }],
    });
  });

  it("剩余时间格式对齐中文显示", () => {
    expect(formatCooldownRemaining(121_000)).toBe("2 分 1 秒");
    expect(formatCooldownRemaining(60_000)).toBe("1 分钟");
    expect(formatCooldownRemaining(8_200)).toBe("9 秒");
  });
});
