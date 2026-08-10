/**
 * 引擎化改造方案 §5.3 / 阶段 3 R7：API Key 脱敏正则集中点。
 *
 * 原位置：src/lib/llm/error-classifier.ts:76-82
 * 安全底线，已通过 RESERVED_POLICY_KEYS['security.api_key_patterns'] 锁定。
 *
 * 新增 provider key 格式应随代码走审查 + 跑 lib/llm/error-classifier.ts 的 sanitizeError 测。
 */

export const API_KEY_PATTERNS: ReadonlyArray<RegExp> = Object.freeze([
  /sk-ant-(?:api03-)?[A-Za-z0-9_-]+/g, // Anthropic
  /sk-proj-[A-Za-z0-9_-]+/g, // OpenAI project
  /sk-[A-Za-z0-9]{20,}/g, // OpenAI legacy
  /AIza[A-Za-z0-9_-]+/g, // Google
  /gsk_[A-Za-z0-9_-]+/g, // Grok
]);

/** 统一的脱敏占位符（不暴露"被脱敏了"的事实，避免反向探测）。 */
export const REDACTED_PLACEHOLDER = "[REDACTED]";

/**
 * 从任意错误信息里剥离 API Key 前缀（防御性）。
 * 设计保持原 sanitizeError 形态，让现有调用方零改动。
 */
export function redactApiKeys(raw: unknown): string {
  if (raw == null) return "";
  let text = String(raw);
  for (const pattern of API_KEY_PATTERNS) {
    text = text.replace(pattern, REDACTED_PLACEHOLDER);
  }
  return text;
}
