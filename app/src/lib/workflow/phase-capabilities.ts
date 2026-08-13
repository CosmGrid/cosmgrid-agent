import type { WorkflowPhase } from "./types";

/**
 * 工作流「阶段能力策略」：每个阶段允许模型碰哪类工具。
 *
 * 背景（2026-07-14 解耦第 0 步）：K7 能力门控原先从"被选中的 skill"的 requiredCapabilities
 * 取值。但那 3 个内置 "skill"（project_audit/plan_execution/verification_closure）本质是
 * 阶段行为策略，不是可复用 skill。把能力供给从 skill 迁到 phase：门控先跟 skill 系统脱钩，
 * 后续拆 skill 时写保护不会熄火。
 *
 * 背景（2026-07-18 写权限双层重构）：阶段能力表原先在 read_project/plan/verify 三个阶段
 * 不给 edit_files/update_docs，形成"写权限被工作流阶段没收"的硬闸——但写权限该由用户在
 * 权限档位（read/confirm/auto）里独立决定，阶段只应该做"软引导"（见 phase-guidance.ts 的
 * 文本纪律，经 execution-context.ts 注入 preamble），不该在能力层面强行没收写工具。
 * 现在 read_project / plan / verify 都追加了 edit_files + update_docs：
 *   - read_project / plan ← 读 + 只读命令 + 写文件能力都放行；写不写盘由用户权限档位把关
 *     （read 档不给写工具、confirm 档写盘前弹确认、auto 档直接写，见 tool-permission-policy.ts）
 *   - execute             ← 写 + 跑测试（不变）
 *   - verify              ← 跑命令 + 写文件能力都放行；实际是否写盘同样交给用户权限档位
 *   - review / debate     ← 原来无内置 skill 命中 → 空数组 → 不门控（与旧行为一致）
 *
 * 返回空数组 = 该阶段不做 K7 门控（executor 只在 caps.length > 0 时才卡）。
 * capability 词表见 lib/llm/capability-registry.ts ALL_CAPABILITIES；这里只用字符串，
 * 不反向依赖 lib/llm，保持 workflow 层干净。
 */
export function capabilitiesForPhase(phase: WorkflowPhase | null | undefined): string[] {
  switch (phase) {
    case "read_project":
    case "plan":
      return ["read_files", "inspect_git", "run_readonly_checks", "edit_files", "update_docs"];
    case "execute":
      return ["edit_files", "run_tests", "update_docs"];
    case "verify":
      return ["run_tests", "run_build", "inspect_failures", "edit_files", "update_docs"];
    case "review":
    case "debate":
    default:
      return [];
  }
}
