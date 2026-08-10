// v0.7 阶段4b — 命令安全分类（bash 工具的安全核心）
//
// 这是整个产品最危险的入口：AI 想跑命令。三道闸：
//   1. 危险模式黑名单（rm -rf / sudo / chmod 777 / 重定向覆盖 / curl|sh 等）→ 直接 block
//   2. 程序白名单（pnpm/npm/yarn/node/git/ls/cat 等只读或开发命令）→ allow（仍需用户确认）
//   3. 不在白名单 → block（默认拒绝，宁可少跑也不误伤）
//
// 纯函数、可红队测试。execute 时即便 allow 也强制走用户确认（双保险）。
//
// 2026-07-04 修复（技术债，坑.md 2.3）：逐段切分复合命令(; && || |)以前是裸正则
// split(/&&|\|\||;|\|/)，不理解引号——`git commit -m "a && b"` 这类合法命令里，引号内的
// "&&" 会被错误当成真操作符切开，导致误判（把 `b"` 当成一个新程序名，白名单查不到就
// 误 block）。改用 `shell-quote` 做真正的 token 化：字符串/操作符分开产出，引号内容原样
// 保留为一个 token，不会被内部的 shell 元字符污染分段结果。

import { parse as parseShellCommand } from "shell-quote";
import { BUILTIN_ALLOWED_PROGRAMS } from "@/lib/policy/command-allowlist";
import { DANGEROUS_COMMAND_PATTERNS } from "@/lib/security-invariants/dangerous-command-patterns";

export type CommandVerdict = "allow" | "block";

export interface CommandCheck {
  verdict: CommandVerdict;
  reason: string;
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
 * 注意：含 shell 串联（; && || | ` $()）时，逐段都要过白名单，任一段不允许即 block。
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

  // 命令替换 $() / 反引号 → 无法静态判断内部，保守 block
  if (/\$\(|`/.test(cmd)) {
    return { verdict: "block", reason: "含命令替换 $() / 反引号，无法静态审查" };
  }

  // 逐段（; && || |）检查白名单——用 shell-quote 真正 token 化，引号内的 && 等字符不会被误判成分段点
  const segments = tokenizeSegments(cmd);
  for (const seg of segments) {
    const prog = firstProgramFromTokens(seg);
    if (!extraAllowed.has(prog)) {
      return { verdict: "block", reason: `程序 "${prog || seg.join(" ")}" 不在白名单` };
    }
  }

  return { verdict: "allow", reason: "白名单命令" };
}

// 100% 只读的程序（只看不改，跑了不产生副作用）
const READONLY_PROGRAMS = new Set([
  "ls", "cat", "head", "tail", "wc", "pwd", "echo", "grep", "rg",
  // 只看不改的 shell 工具（cd 只切目录、其余纯输出）→ 免确认。
  // sed/awk/mkdir/touch/cp/mv/jq 能写文件，不在此列（仍走确认）。
  // 2026-07-15 review 修复：find 也从这里移除——isReadOnlyCommand 只看程序名不看参数，
  // `find . -delete` / `find /path -exec rm {} +` 会被当"纯只读"直接跳过确认，
  // 真的删文件/跑任意程序。find 本身能写，跟 sed/awk 这批一样应该走确认。
  // 2026-07-16 review 修复：env 也从这里移除——env 已经从 command-allowlist.ts 的白名单
  // 里整个删掉了（通用进程启动器，靠它能绕过整套白名单），这里留着是死代码，一并清掉避免
  // 以后有人误以为 env 还是允许的程序。
  "cd", "which", "type", "date", "printenv",
  "sort", "uniq", "cut", "tr", "column", "comm", "paste", "seq", "nl",
  "diff", "cmp", "file", "stat", "tree", "du", "basename", "dirname", "realpath", "readlink",
]);

// git 的只读子命令（其余 add/commit/checkout/reset/push/pull/merge/stash/clean 等都算写）
const GIT_READONLY_SUBCOMMANDS = new Set([
  "log", "status", "diff", "show", "branch", "remote", "ls-files", "rev-parse",
  "describe", "blame", "shortlog",
]);

/**
 * 命令是否「纯只读」——只看不改、跑了没副作用，可免用户确认。
 * 保守：含命令替换 $()/反引号一律当非只读；逐段都必须只读才算只读。
 * git 看子命令（log/status/diff 只读，commit/add/checkout 算写）。
 */
export function isReadOnlyCommand(command: string): boolean {
  const cmd = command.trim();
  if (!cmd) return false;
  if (/\$\(|`/.test(cmd)) return false; // 命令替换无法静态判断 → 保守当非只读
  // 2026-07-04 修复：改用 token 化后的真操作符判断重定向，不再是裸 />/ 子串匹配——
  // 后者会把 `echo "a > b"` 这种引号内的 ">" 也误判成重定向，导致只读命令被错误要求确认。
  if (hasRedirectOperator(cmd)) return false;

  const segments = tokenizeSegments(cmd);
  if (segments.length === 0) return false;

  return segments.every((tokens) => {
    const stripped = tokens.slice();
    let i = 0;
    while (i < stripped.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(stripped[i]!)) i++;
    const rest = stripped.slice(i);
    const prog = rest[0] ?? "";
    if (READONLY_PROGRAMS.has(prog)) return true;
    if (prog === "git") {
      const sub = rest.slice(1).find((tk) => tk && !tk.startsWith("-"));
      return sub ? GIT_READONLY_SUBCOMMANDS.has(sub) : false;
    }
    return false;
  });
}
