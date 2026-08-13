import { describe, it, expect } from "vitest";
import { capabilitiesForPhase } from "../phase-capabilities";
// 集成用例（下方"K7 门控联动"describe 块）故意越过 workflow 层，直接引用 lib/llm 的
// capability-registry——纯测试文件不受 .dependency-cruiser.cjs 的层间依赖检查约束
// （见该文件 exclude: "^src/.*/__tests__"），用来验证 B1 的改动在 K7 真实门控点生效。
import { checkSkillToolAccess } from "@/lib/llm/capability-registry";

describe("capabilitiesForPhase（阶段能力策略，K7 供数源）", () => {
  // 2026-07-18 写权限双层重构：阶段不再没收写能力，写权限归用户权限档位（read/confirm/auto）
  // 独立把关（见 tool-permission-policy.ts + write-guard-runtime.ts）。
  it("read_project / plan：读 + 只读命令 + 写文件能力都放行（阶段不再没收写，写权限归用户档位）", () => {
    for (const phase of ["read_project", "plan"] as const) {
      const caps = capabilitiesForPhase(phase);
      expect(caps).toContain("read_files");
      expect(caps).toContain("inspect_git");
      expect(caps).toContain("edit_files");
      expect(caps).toContain("update_docs");
    }
  });

  it("execute：给写 + 跑测试", () => {
    const caps = capabilitiesForPhase("execute");
    expect(caps).toContain("edit_files");
    expect(caps).toContain("run_tests");
    expect(caps).toContain("update_docs");
  });

  it("verify：给跑命令 + 写文件能力都放行（阶段不再没收写）", () => {
    const caps = capabilitiesForPhase("verify");
    expect(caps).toContain("run_tests");
    expect(caps).toContain("run_build");
    expect(caps).toContain("edit_files");
    expect(caps).toContain("update_docs");
  });

  it("review / debate / null / undefined：空数组（不门控，与旧行为一致）", () => {
    expect(capabilitiesForPhase("review")).toEqual([]);
    expect(capabilitiesForPhase("debate")).toEqual([]);
    expect(capabilitiesForPhase(null)).toEqual([]);
    expect(capabilitiesForPhase(undefined)).toEqual([]);
  });
});

// 写权限双层重构（2026-07-18）：验证 B1 的改动在 K7 真实门控点（executor-security.ts 的
// runSecurityPrecheck → capability-registry.checkSkillToolAccess）确实生效——活跃工作流
// 停在 plan / read_project / verify 阶段时，write-path 类工具不再被 K7 能力门控拒绝
// （实际写不写盘、要不要弹确认，由用户权限档位 read/confirm/auto 独立把关，见
// tool-permission-policy.ts + write-guard-runtime.ts，K7 这一层只管"阶段允不允许"）。
describe("K7 门控联动：阶段能力表 × checkSkillToolAccess（模块 B 生效验证）", () => {
  it("活跃工作流停在 plan 阶段时，write-path 工具不再被拒", () => {
    const caps = capabilitiesForPhase("plan");
    expect(checkSkillToolAccess(caps, "write-path").ok).toBe(true);
  });

  it("活跃工作流停在 read_project 阶段时，write-path 工具不再被拒", () => {
    const caps = capabilitiesForPhase("read_project");
    expect(checkSkillToolAccess(caps, "write-path").ok).toBe(true);
  });

  it("活跃工作流停在 verify 阶段时，write-path 工具不再被拒", () => {
    const caps = capabilitiesForPhase("verify");
    expect(checkSkillToolAccess(caps, "write-path").ok).toBe(true);
  });

  it("execute 阶段本来就放行 write-path，改动前后行为不变", () => {
    const caps = capabilitiesForPhase("execute");
    expect(checkSkillToolAccess(caps, "write-path").ok).toBe(true);
  });

  it("review/debate（空能力数组）不门控——checkSkillToolAccess 对空数组的语义由 ctx.activeCaps.length > 0 短路，这里只验证数组本身仍是空", () => {
    expect(capabilitiesForPhase("review")).toEqual([]);
    expect(capabilitiesForPhase("debate")).toEqual([]);
  });
});
