/**
 * 引擎化改造方案 §7.2 K7 真强制 —— capability 的中立注册表。
 *
 * 这是 K7 enforcement 的"中立事实表"：tools 层（L6）和 skills 层（L7）都需要读，
 * 但都不能让另一方依赖。所以放在 lib/llm 下，跟 tools 平级，skills 通过 import 这个
 * （skills → lib/llm 当前规则允许）反向安全。
 *
 * 模块构成：
 *   - ALL_CAPABILITIES：capability 字符串常量表（registration 校验用）
 *   - checkSkillToolAccess：核心 check —— active skill 是否允许调用某 kind 的工具
 *
 * 语义（2026-07-14 修正）：skill 的 requiredCapabilities 是"允许集"。
 *   - read-path / none 类工具恒放行（读文件、ask_user、web_fetch 无写副作用，不门控）
 *   - write-path / command 类工具：必须由 skill 的某条 capability 授予，否则拒绝
 * 旧实现 enforceCapabilities 判定的是 skillCaps ⊆ toolCaps，方向反了 —— skill 声明多个
 * 细粒度 cap 时（如 project_audit 的 3 个），每个工具都会被判成"缺能力"而全拒。已废弃。
 *
 * 故意不放：content blocklist（SKILL_CONTENT_BLOCKLIST_PATTERNS）——这是 Skill 域专属
 * 治理词（防注入 prompt 注入退化诱导），跟 capability guard 解耦，留在 skills/capabilities.ts。
 */

export const ALL_CAPABILITIES = Object.freeze([
  "read_files",
  "edit_files",
  "inspect_git",
  "run_readonly_checks",
  "run_tests",
  "run_build",
  "inspect_failures",
  "update_docs",
  "run_commands",
  "ask_user",
  "web_fetch",
  "memory_store",
] as const);

export type Capability = (typeof ALL_CAPABILITIES)[number];

/** 受能力门控的工具 kind（read-path / none 恒放行，不在此列）。 */
export type GatedToolKind = "write-path" | "command";

export type ToolSecurityKind = "read-path" | "write-path" | "command" | "none";

/**
 * 每个 capability 授予对哪些受控 tool kind 的访问。
 * 只要 skill 的 requiredCapabilities 里有任一 cap 授予了该 kind，就放行。
 *
 * read_files / ask_user / web_fetch / memory_store 不在表里 —— 它们对应的工具
 * （read-path / none）本就恒放行，无需授予。
 */
const CAP_TOOL_KIND_GRANTS: Readonly<Record<string, ReadonlyArray<GatedToolKind>>> = Object.freeze({
  edit_files: ["write-path"],
  update_docs: ["write-path"],
  run_commands: ["command"],
  run_tests: ["command"],
  run_build: ["command"],
  run_readonly_checks: ["command"],
  inspect_git: ["command"],
  inspect_failures: ["command"],
});

/**
 * 工作流"实际动作可视化"阶段1（2026-07-18）：TOOL_NAME → ToolSecurityKind 静态映射表。
 *
 * 用途：deriveObservedActivity（lib/workflow/observed-activity.ts）需要按"本轮真实调过
 * 哪些工具"反推"这轮主要在读/写/跑命令"，但 workflow 层不该反向依赖 lib/llm/tools（L6，
 * depcruise l6-tools-no-upstack-runtime 就是反过来禁止 tools 依赖 workflow，同理 workflow
 * 也不该依赖 tools 制造循环）。这张表把"工具名 → security.kind"这份中立事实抄一份放在
 * capability-registry.ts 这个中立层，workflow 层只 import 这张纯数据表，不 import tools 模块。
 *
 * 值来源：逐一抄自 lib/llm/tools/*.ts 每个工具定义的 `security.kind` 字段。新增/删除工具时
 * 必须同步这张表——守卫测试（capability-registry.test.ts）会遍历
 * createDefaultToolRegistry({ includeWrite: true }).list()，断言每个工具的 name 都在这张表
 * 里且 kind 与工具自身声明一致，漏更新会让测试变红（防止静默漂移）。
 */
export const TOOL_NAME_SECURITY_KIND: Readonly<Record<string, ToolSecurityKind>> = Object.freeze({
  read: "read-path",
  glob: "read-path",
  grep: "read-path",
  git_read: "read-path",
  lsp_diagnostics: "read-path",
  lsp_definition: "read-path",
  lsp_hover: "read-path",
  view_image: "read-path",
  write: "write-path",
  edit: "write-path",
  hashline_edit: "write-path",
  bash: "command",
  remember: "none",
  web_fetch: "none",
  web_search: "none",
  todo_write: "none",
  ask_user_question: "none",
  report_no_changes_needed: "none",
  skill: "none",
});

export interface SkillToolAccessCheck {
  ok: boolean;
  /** 拒绝原因（给 UI/日志）；ok=true 时为空串。 */
  reason: string;
}

/**
 * K7 真强制：判断 active skill 是否允许调用某 kind 的工具。
 *
 * @param skillCaps active skill 的 requiredCapabilities（允许集）
 * @param kind      工具的 security.kind
 */
export function checkSkillToolAccess(
  skillCaps: ReadonlyArray<string>,
  kind: ToolSecurityKind,
): SkillToolAccessCheck {
  // read-path / none：读与无副作用工具不受 skill 能力门控。
  if (kind === "read-path" || kind === "none") return { ok: true, reason: "" };

  const granted = skillCaps.some((c) => (CAP_TOOL_KIND_GRANTS[c] ?? []).includes(kind));
  if (granted) return { ok: true, reason: "" };

  const need = kind === "write-path" ? "写文件" : "执行命令";
  return {
    ok: false,
    reason: `active skill 未声明${need}能力（requiredCapabilities 缺少授予 ${kind} 类工具的项）`,
  };
}
