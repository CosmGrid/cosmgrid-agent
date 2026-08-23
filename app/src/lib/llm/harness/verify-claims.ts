// Harness 阶段1 — 比对「模型声称读过的路径」vs「tool_executions 里真有 read 记录的路径」。
//
// 真实性校验的核心：模型说看了 X，但 tool_executions 里没有对应 read X 的执行记录
// → 模型在编（没真读）。路径级比对，不做内容匹配（模型会 paraphrase）。
//
// read 记录从 tool_executions 表查：input 字段是 JSON.stringify({file_path, ...})。


export interface ReadRecord {
  /** tool_executions.input，JSON 字符串，read 工具的形如 {file_path,...} */
  input: string;
  /** status：success/denied/error，denied/error 也算「尝试过但没读到」→ 仍算 verified=false（没真读到内容） */
  status: string;
}

export interface ClaimVerification {
  claimed: string;
  verified: boolean;
  /** 没读到的原因（用于 UI 提示） */
  reason?: string;
}

/** 从一条 read 审计记录的 input 里解析出 file_path */
function extractReadPath(input: string): string | null {
  try {
    const obj = JSON.parse(input) as unknown;
    if (obj && typeof obj === "object" && "file_path" in obj) {
      const fp = (obj as { file_path: unknown }).file_path;
      if (typeof fp === "string" && fp) return fp;
    }
  } catch {
    // 坏 JSON 忽略
  }
  return null;
}

/** 路径匹配：处理相对/绝对、basename 同名等情形 */
function pathMatches(claimed: string, actual: string): boolean {
  const c = claimed.replace(/\/+$/, "");
  const a = actual.replace(/\/+$/, "");
  if (c === a) return true;
  // 一方是另一方的后缀（相对路径 vs 绝对路径）
  if (c.endsWith("/" + a) || a.endsWith("/" + c)) return true;
  if (c.endsWith(a) || a.endsWith(c)) return true;
  // basename 相同且是文件（含扩展名）—— 慎用，要求带扩展名避免目录误命中
  const cb = c.split("/").pop();
  const ab = a.split("/").pop();
  if (cb && ab && cb === ab && /\.\w+$/.test(cb)) return true;
  return false;
}

/**
 * 校验模型声称的路径列表。
 * @param claimedPaths 模型文本里提取的路径（extractFilePaths 的输出）
 * @param readRecords 本次对话 tool_executions 里所有 read 工具的审计记录
 * @returns 每条 claimed 是否被真实 read 过
 */
export function verifyFileClaims(
  claimedPaths: string[],
  readRecords: ReadRecord[],
): ClaimVerification[] {
  // 只认 status=success 的 read（denied/error 没真读到内容，不能算模型「看过」的依据）
  const readPaths = readRecords
    .filter((r) => r.status === "success")
    .map((r) => extractReadPath(r.input))
    .filter((p): p is string => p !== null);

  return claimedPaths.map((claimed) => {
    const matched = readPaths.some((rp) => pathMatches(claimed, rp));
    return matched
      ? { claimed, verified: true }
      : { claimed, verified: false, reason: "模型引用了此文件，但本次对话没有对应的 read 工具执行记录——内容可能是编造的" };
  });
}

/** 便捷：返回所有未通过校验的路径（UI 标红用） */
export function unverifiedClaims(claims: ClaimVerification[]): ClaimVerification[] {
  return claims.filter((c) => !c.verified);
}

// ============ web_fetch 版本（2026-07-07 补）============
//
// 上面这套只认 `read` 工具的本地文件路径。模型声称"抓取过某个网页"这类谎完全在覆盖范围外——
// tool_executions 里 web_fetch 记录的 input 是 {url,...} 不是 {file_path,...}，没有对应校验。
// 逻辑跟 verifyFileClaims 完全一份：路径级比对换成 URL 级比对，其余不变。

export interface FetchRecord {
  /** tool_executions.input，JSON 字符串，web_fetch 工具的形如 {url,...} */
  input: string;
  /** status：success/denied/error，非 success 都算「没真抓到内容」 */
  status: string;
}

/** 从一条 web_fetch 审计记录的 input 里解析出 url */
/**
 * 校验模型声称抓取过的 URL 列表。
 * @param claimedUrls 模型文本里提取的 URL（extractUrlClaims 的输出）
 * @param fetchRecords 本次对话 tool_executions 里所有 web_fetch 工具的审计记录
 */
export function verifyUrlClaims(
  claimedUrls: string[],
  fetchRecords: FetchRecord[],
): ClaimVerification[] {
  return claimedUrls.map((claimed) => {
    void fetchRecords;
    return {
      claimed,
      verified: false,
      reason: "web_fetch 历史证据被隔离，无法验证网页内容，不能据此排除编造",
    };
  });
}

// ============ bash/grep/web_search 版本（2026-07-07 补，系统性排查）============
//
// read/web_fetch 都补完之后，`grep`（pattern）、`bash`（command）、`web_search`（query）
// 三个工具的调用参数还是裸的——不接就意味着"我 grep 出来 X"/"我跑了 `pnpm test` 都过了"这类
// 谎，不管换哪个模型都抓不到。三个工具的字面目标字段名不同（pattern/command/query），
// 但校验逻辑一样，合并成一套：只要跟其中任意一个工具的成功记录对得上就算验证通过——
// 模型说"运行了 X"时我们没法单靠这句话判断它指的是 bash 命令还是 grep pattern，
// 干脆在三者的并集里找，找不到才算编。

export interface ExecRecord {
  /** tool_executions.input，JSON 字符串，bash 工具是 {command,...}、grep 是 {pattern,...}、
   *  web_search 是 {query,...} */
  input: string;
  /** status：success/denied/error，非 success 都算「没真跑到结果」 */
  status: string;
}

const EXEC_TARGET_FIELDS = ["command", "pattern", "query"] as const;

/** 从一条执行记录的 input 里按已知字段名（command/pattern/query）取值，取第一个命中的 */
function extractExecTarget(input: string): string | null {
  try {
    const obj = JSON.parse(input) as unknown;
    if (obj && typeof obj === "object") {
      for (const field of EXEC_TARGET_FIELDS) {
        const v = (obj as Record<string, unknown>)[field];
        if (typeof v === "string" && v) return v;
      }
    }
  } catch {
    // 坏 JSON 忽略
  }
  return null;
}

/** 宽松匹配：命令/pattern/查询词允许模型转述时有细微出入（比如加了参数），只要互相包含就算对上 */
function looseMatches(claimed: string, actual: string): boolean {
  const c = claimed.trim().toLowerCase();
  const a = actual.trim().toLowerCase();
  if (!c || !a) return false;
  return c === a || a.includes(c) || c.includes(a);
}

/**
 * 校验模型声称运行/搜索过的字面值列表（bash 命令、grep pattern、web_search 查询词的并集）。
 * @param claimedValues 模型文本里提取的字面值（extractQuotedClaims 的输出）
 * @param execRecords 本次对话 tool_executions 里 bash/grep/web_search 三个工具的审计记录
 */
export function verifyCommandClaims(
  claimedValues: string[],
  execRecords: ExecRecord[],
): ClaimVerification[] {
  const actualValues = execRecords
    .filter((r) => r.status === "success")
    .map((r) => extractExecTarget(r.input))
    .filter((v): v is string => v !== null);

  return claimedValues.map((claimed) => {
    const matched = actualValues.some((a) => looseMatches(claimed, a));
    return matched
      ? { claimed, verified: true }
      : {
          claimed,
          verified: false,
          reason: "模型声称运行/搜索过此内容，但本次对话没有对应的 bash/grep/web_search 成功记录——内容可能是编造的",
        };
  });
}
