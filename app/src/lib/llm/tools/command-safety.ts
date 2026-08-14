// v0.7 阶段4b — 命令安全分类（bash 工具的安全核心）
//
// 这是整个产品最危险的入口：AI 想跑命令。三道闸：
//   1. 危险模式黑名单（rm -rf / sudo / chmod 777 / 重定向覆盖 / curl|sh 等）→ 直接 block
//   2. 命令分类与 grammar：仅严格 pure-read grammar 可 allow；dynamic-exec 仍需真人确认
//   3. 不在白名单 → block（默认拒绝，宁可少跑也不误伤）
//
// 纯函数、可红队测试。execute 时即便 allow 也强制走用户确认（双保险）。
//
// shell-quote 仅用于识别 token 与危险操作符；组合命令不会被拆开执行，而是统一 block。

import { parse as parseShellCommand } from "shell-quote";
import { BUILTIN_ALLOWED_PROGRAMS } from "@/lib/policy/command-allowlist";
import { DANGEROUS_COMMAND_PATTERNS } from "@/lib/security-invariants/dangerous-command-patterns";
import { getCommandClass, isKnownCommandProgram, type CommandClass } from "@/lib/policy/command-program-spec";

export type CommandVerdict = "allow" | "block";

export interface CommandCheck {
  verdict: CommandVerdict;
  reason: string;
  commandClass?: CommandClass;
  requiresHumanConfirmation?: boolean;
}

type ShellToken = string | { op: string; pattern?: string };

/**
 * 把命令串按真正的 shell 操作符（&& || ; |）切分成段，每段是 token 数组。
 * 用 shell-quote 解析，引号内容原样保留成一个 token，不会被内部的 && 等字符误判成分段点。
 * 重定向（> >> <）、子 shell（( )）等其他 operator 不当分段依据，也不当普通文本塞进段里——
 * 那些场景已经由上层的 $()／反引号／danger pattern 专项检查处理，这里只负责"这是几段、
 * 每段第一个程序是谁"。
 * 解析失败（极端畸形输入）时保守整条当一段，交给后面的白名单/黑名单兜底。
 */
function tokenizeSegments(cmd: string): string[][] {
  let tokens: ShellToken[];
  try {
    tokens = parseShellCommand(cmd) as ShellToken[];
  } catch {
    return [[cmd]];
  }
  const segments: string[][] = [];
  let current: string[] = [];
  for (const tok of tokens) {
    if (typeof tok === "string") {
      current.push(tok);
      continue;
    }
    if (tok.op === "&&" || tok.op === "||" || tok.op === ";" || tok.op === "|") {
      segments.push(current);
      current = [];
      continue;
    }
    if (tok.op === "glob" && typeof tok.pattern === "string") {
      current.push(tok.pattern);
      continue;
    }
    // 其余 operator（> >> < ( ) 等）：丢弃这个 token，不计入分段依据
  }
  segments.push(current);
  return segments.filter((seg) => seg.length > 0);
}

/** 一段 token 里去掉前导环境变量赋值（FOO=bar），取第一个真正的程序名 */
function firstProgramFromTokens(tokens: string[]): string {
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!)) i++;
  return tokens[i] ?? "";
}

// 环境变量读取包装器是不可覆盖的硬拒绝：它们能直接泄露进程凭据，不能由
// extraAllowed 或数据库 override 恢复。仅按首程序的精确身份匹配，避免误伤参数/文件名。
const HARD_DENIED_PROGRAMS = new Set(["env", "printenv"]);

function isHardDeniedProgram(program: string): boolean {
  const basename = program.split(/[\\/]/).pop() ?? program;
  const normalized = basename.toLowerCase();
  const identity = normalized.endsWith(".exe") ? normalized.slice(0, -4) : normalized;
  return HARD_DENIED_PROGRAMS.has(identity);
}

function pureReadGrammar(program: string, args: string[]): boolean {
  if (program === "pwd") return args.length === 0;
  if (program === "basename" || program === "dirname") {
    return args.length === 1 && !args[0]!.startsWith("-");
  }
  if (program === "echo") {
    // Minimal grammar: echo accepts values only; flags are intentionally not interpreted.
    return args.every((arg) => !arg.startsWith("-"));
  }
  return false;
}

const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "npx", "bun"]);
const SCOPED_PACKAGE_TOKEN = /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*(?:@[A-Za-z0-9._*+^~<>=|-]+)?$/;

function isResponseFileToken(program: string, arg: string): boolean {
  if (PACKAGE_MANAGERS.has(program) && SCOPED_PACKAGE_TOKEN.test(arg)) return false;
  return /(?:^|[=,])@/.test(arg);
}

/** 命令是否含真正的重定向操作符（> >>），不是引号内字符串里出现的 ">"。 */
function hasRedirectOperator(cmd: string): boolean {
  let tokens: ShellToken[];
  try {
    tokens = parseShellCommand(cmd) as ShellToken[];
  } catch {
    return />/.test(cmd); // 解析失败保守退回原始子串判断
  }
  return tokens.some((tok) => typeof tok !== "string" && (tok.op === ">" || tok.op === ">>"));
}

/**
 * D2：把一条命令解析成 (program, args[])，仅当它是「简单命令」——
 * 即 shell-quote 解析后所有 token 都是字符串（不含 ; && || | > 等运算符、
 * 不含 $()/反引号命令替换、不含 ( ) 子 shell）。
 *
 * 返回 null 表示命令需要 shell 解释（组合命令 / 重定向 / 命令替换），
 * 调用方应拒绝（不回退到 sh -c）。这样 AI 工具调用统一走 program+args，
 * 参数里的 ; && | 等 shell 元字符绝不会被解释成第二条命令。
 *
 * 前导环境变量赋值 FOO=bar 会被剥离（runArgs 不走环境继承），剩余部分才当 argv。
 */
export function tryParseProgramArgs(command: string): { program: string; args: string[] } | null {
  const cmd = command.trim();
  if (!cmd) return null;
  // 命令替换 $() / 反引号：shell-quote 在某些版本把反引号当字面字符串 token 返回，
  // 这里显式拦截，与 checkCommand 的 `/\$\(|`/` 守卫保持一致，绝不回退到 sh -c。
  if (/\$\(|`/.test(cmd)) return null;
  let tokens: ShellToken[];
  try {
    tokens = parseShellCommand(cmd) as ShellToken[];
  } catch {
    return null; // 解析失败保守当组合命令，禁止经 sh -c
  }
  // 任何非字符串 token（operator / glob / 命令替换）都说明需要 shell 解释
  for (const tok of tokens) {
    if (typeof tok !== "string") return null;
  }
  const argv = tokens as string[];
  // 剥离前导环境变量赋值 FOO=bar
  let i = 0;
  while (i < argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[i]!)) i++;
  const rest = argv.slice(i);
  if (rest.length === 0) return null;
  const [program, ...args] = rest;
  if (!program) return null;
  if (args.some((arg) => isResponseFileToken(program, arg))) return null;
  return { program, args };
}

/** 取命令的第一个程序名（去掉前导环境变量赋值 FOO=bar cmd） */
export function firstProgram(command: string): string {
  const segments = tokenizeSegments(command.trim());
  return firstProgramFromTokens(segments[0] ?? []);
}

/**
 * 2026-07-15 review 修复：token 化判断"这条命令里是不是有 git push"，不依赖字符串相邻。
 * 逐段检查——只要某段第一个程序是 git，且该段任意位置出现独立的 "push" token 就命中。
 * 接受的代价：极端情况下 `git branch push`（建一个真的叫 push 的分支）会被误拦，需要用户
 * 手动改名或走确认之外的路径——比误放行 `git -C /repo push` 这类绕过安全，符合本文件
 * 顶部"默认拒绝，宁可少跑也不误伤"的既定姿态。
 */
function isGitPushCommand(cmd: string): boolean {
  const segments = tokenizeSegments(cmd);
  return segments.some((seg) => {
    if (firstProgramFromTokens(seg) !== "git") return false;
    // 2026-07-15 review 复检提的小瑕疵：跟旧的 /\bgit\s+push\b/i 保持一致统一转小写比较
    // （git 子命令本身大小写敏感，"git PUSH" 在真实 shell 里根本不是合法命令，不构成可
    // 利用绕过，这里只是消除逻辑不对称，不是修安全洞）。
    return seg.slice(1).some((tok) => tok.toLowerCase() === "push");
  });
}

/**
 * 分类一条命令。block 优先于 allow。
 * 仅接受单一 program+argv；组合、重定向、glob、response-file 和解析失败一律 block。
 * 只有 pwd/echo/basename/dirname 的严格 pure-read grammar 可进入真人确认；dynamic-exec 也需真人确认，
 * 其余分类等待 C2-C4 grammar 工作包开放。
 *
 * 引擎化改造方案阶段 1a：第三参数 `extraAllowed` 接 PolicyStore 已解析的允许程序集合。
 * 默认值仍是 builtin（BUILTIN_ALLOWED_PROGRAMS，含 pip3 等）；调用方按需用
 * `resolveAllowedPrograms(ctx.projectId)` 拿到 builtin ∪ 项目级 / 全局 override 后传入。
 *
 * 安全姿态不变：黑名单（DANGEROUS_PATTERNS / extraBlocked）优先级仍高于白名单。
 */
export function checkCommand(
  command: string,
  extraBlocked: string[] = [],
  extraAllowed: ReadonlySet<string> = BUILTIN_ALLOWED_PROGRAMS,
): CommandCheck {
  const cmd = command.trim();
  if (!cmd) return { verdict: "block", reason: "空命令" };

  // 自定义黑名单前缀（来自 WorkspaceConfig.blockedCommands）
  for (const b of extraBlocked) {
    if (b && cmd.toLowerCase().includes(b.toLowerCase())) {
      return { verdict: "block", reason: `命中项目黑名单：${b}` };
    }
  }

  // 危险模式
  for (const { re, reason } of DANGEROUS_COMMAND_PATTERNS) {
    if (re.test(cmd)) return { verdict: "block", reason: `危险命令：${reason}` };
  }

  // 2026-07-15 review 修复：DANGEROUS_COMMAND_PATTERNS 里 git push 那条是 /\bgit\s+push\b/，
  // 要求 "git" 和 "push" 相邻——`git -C /repo push`、`git -c x=y push` 这类中间插了全局参数
  // 的写法会绕过硬阻断，只降级成普通确认。改用 token 化判断：git 段里任何位置出现独立的
  // "push" token 就拦，不管前面插了多少参数。
  if (isGitPushCommand(cmd)) {
    return { verdict: "block", reason: "危险命令：git push 推远端（需人工，禁止自动）" };
  }

  // Only a single program+argv is accepted. The executor never falls back to sh -c.
  const parsed = tryParseProgramArgs(cmd);
  if (!parsed) return { verdict: "block", reason: "仅允许简单 program+argv，组合/重定向/glob/解析失败均拒绝" };

  // 命令替换 $() / 反引号 → 无法静态判断内部，保守 block
  if (/\$\(|`/.test(cmd)) {
    return { verdict: "block", reason: "含命令替换 $() / 反引号，无法静态审查" };
  }

  const prog = parsed.program;
  if (isHardDeniedProgram(prog)) {
    return { verdict: "block", reason: `程序 "${prog}" 被安全策略禁止` };
  }
  // Overrides can add names to the allowlist, but cannot create an unclassified
  // execution path. A new program must first be classified in the canonical registry.
  if (!isKnownCommandProgram(prog) || !extraAllowed.has(prog)) {
    return { verdict: "block", reason: `程序 "${prog}" 未分类或不在白名单` };
  }
  const commandClass = getCommandClass(prog) as CommandClass;
  if (commandClass === "dynamic-exec") return { verdict: "allow", reason: "动态命令，必须真人确认", commandClass, requiresHumanConfirmation: true };
  if (commandClass === "pure-read" && pureReadGrammar(prog, parsed.args)) {
    return {
      verdict: "allow",
      reason: "可执行文件身份尚未绑定可信系统程序，暂需真人确认",
      commandClass,
      requiresHumanConfirmation: true,
    };
  }
  return { verdict: "block", reason: `${commandClass} 命令当前未开放 grammar`, commandClass, requiresHumanConfirmation: true };
}

/**
 * 兼容包装：命令安全分类仍由 checkCommand 返回；此旧布尔接口不再表示免确认。
 * 为避免调用方把 PATH 可冒充的同名程序当作可信只读程序，所有命令均返回 false。
 */
export function isReadOnlyCommand(command: string): boolean {
  const cmd = command.trim();
  if (!cmd) return false;
  if (/\$\(|`/.test(cmd)) return false; // 命令替换无法静态判断 → 保守当非只读
  // 2026-07-04 修复：改用 token 化后的真操作符判断重定向，不再是裸 />/ 子串匹配——
  // 后者会把 `echo "a > b"` 这种引号内的 ">" 也误判成重定向，导致只读命令被错误要求确认。
  if (hasRedirectOperator(cmd)) return false;

  return isPureReadCommand(command);
}

/** Compatibility/test helper; production authorization uses structured executor precheck data. */
export function isPureReadCommand(command: string): boolean {
  const cmd = command.trim();
  if (!cmd || /\$\(|`/.test(cmd) || hasRedirectOperator(cmd)) return false;
  const parsed = tryParseProgramArgs(cmd);
  if (!parsed || !isKnownCommandProgram(parsed.program)) return false;
  if (parsed.args.some((arg) => isResponseFileToken(parsed.program, arg))) return false;
  // 保留上述解析/grammar 校验，防止该兼容接口被误用于任意命令；但不再提供免确认信号。
  return false;
}
