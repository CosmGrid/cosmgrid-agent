/**
 * 引擎化改造方案 §5.3 / 阶段 3 R7：敏感路径黑名单集中点。
 *
 * 原位置：src/lib/llm/tools/path-safety.ts:68-76
 * 安全底线，已通过 RESERVED_POLICY_KEYS['security.sensitive_paths'] 锁定。
 */

// 2026-07-15 review 修复：原来只有 secrets? 那条带 i 标志，其余五条大小写敏感——macOS
// 默认 APFS 大小写不敏感（但保留大小写），`.ENV`/`.Ssh` 这类大小写变体在文件系统层面
// 解析到的是同一份文件，但这五条正则匹配不上，会绕过黑名单读到真正的敏感文件。
// 统一补上 i 标志，跟 secrets? 那条保持一致。
export const SENSITIVE_PATH_PATTERNS: ReadonlyArray<RegExp> = Object.freeze([
  /(^|\/)\.ssh(\/|$)/i,
  /(^|\/)\.aws(\/|$)/i,
  /(^|\/)\.gnupg(\/|$)/i,
  /(^|\/)\.env(\.|$|\/)/i,
  /(^|\/)secrets?\.[^/]+$/i,
  /(^|\/)keystore\.json$/i,
  /(^|\/)id_rsa[^/]*(\/|$)/i,
]);

/** 命中任一 pattern → true。保留具名函数让原模块继续高内聚。 */
export function isSensitivePath(absPath: string): boolean {
  for (const re of SENSITIVE_PATH_PATTERNS) {
    if (re.test(absPath)) return true;
  }
  return false;
}
