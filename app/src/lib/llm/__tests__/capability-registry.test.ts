import { describe, it, expect } from "vitest";
import { TOOL_NAME_SECURITY_KIND, checkSkillToolAccess } from "../capability-registry";
import { createDefaultToolRegistry } from "../tools";

// 工作流"实际动作可视化"阶段1（2026-07-18）：守卫测试——防止以后加/删工具时
// TOOL_NAME_SECURITY_KIND 这张静态表悄悄漂移（漏更新、kind 抄错）。
describe("TOOL_NAME_SECURITY_KIND 守卫", () => {
  it("createDefaultToolRegistry({ includeWrite: true }) 里的每个工具都在表里，且 kind 与工具自身声明一致", () => {
    const registry = createDefaultToolRegistry({ includeWrite: true });
    const tools = registry.list();
    expect(tools.length).toBeGreaterThan(0);

    for (const tool of tools) {
      const mapped = TOOL_NAME_SECURITY_KIND[tool.name];
      expect(mapped, `工具 "${tool.name}" 缺失于 TOOL_NAME_SECURITY_KIND，请同步补充`).toBeDefined();
      expect(mapped, `工具 "${tool.name}" 的 kind 记录（${mapped}）与实际声明（${tool.security.kind}）不一致`).toBe(
        tool.security.kind,
      );
    }
  });

  it("只读注册表（不含 write）的工具同样全部覆盖", () => {
    const registry = createDefaultToolRegistry({ includeWrite: false });
    for (const tool of registry.list()) {
      expect(TOOL_NAME_SECURITY_KIND[tool.name]).toBe(tool.security.kind);
    }
  });
});

// 现有 checkSkillToolAccess 单测保留在其它文件？没有——顺手补一份最小回归，
// 确认本次改动没有动到这个函数的行为（本任务硬性纪律：不碰 K7 门控判定逻辑）。
describe("checkSkillToolAccess（回归，未改动）", () => {
  it("read-path/none 恒放行", () => {
    expect(checkSkillToolAccess([], "read-path").ok).toBe(true);
    expect(checkSkillToolAccess([], "none").ok).toBe(true);
  });

  it("write-path 需要被授予对应 capability", () => {
    expect(checkSkillToolAccess([], "write-path").ok).toBe(false);
    expect(checkSkillToolAccess(["edit_files"], "write-path").ok).toBe(true);
  });

  it("command 需要被授予对应 capability", () => {
    expect(checkSkillToolAccess([], "command").ok).toBe(false);
    expect(checkSkillToolAccess(["run_commands"], "command").ok).toBe(true);
  });
});
