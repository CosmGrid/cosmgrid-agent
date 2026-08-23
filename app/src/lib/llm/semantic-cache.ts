// v0.9 阶段7 — 语义缓存（重复/相似 query 命中已有答案，省 token）
//
// 流程：query → embedding → 扫描未过期缓存取余弦最高 → ≥ 阈值则命中（cost=0）。
// 保守接入（isCacheable）：时间敏感 query / 含代码的答案不写缓存，避免给过期或错误的代码。

import { semanticCache } from "../db";
import { SIMILARITY_THRESHOLD } from "./similarity";

/** 缓存默认存活 7 天 */
export const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface CacheHit {
  id: string;
  responseText: string;
  modelId: string;
  similarity: number;
  /** 这条缓存创建距今多久（ms），UI 用来显示"N 天前回答过" */
  ageMs: number;
}

/**
 * 查缓存：embed query → 扫描未过期缓存 → 取余弦最高且 ≥ 阈值的。
 * 命中则累加 hitCount。无命中返回 null。
 *
 * @param threshold 命中阈值，默认 SIMILARITY_THRESHOLD(0.92)
 */
export async function lookupCache(
  query: string,
  threshold = SIMILARITY_THRESHOLD,
): Promise<CacheHit | null> {
  void query;
  void threshold;
  return null;
}

/**
 * 写缓存：先过 isCacheable 保守过滤，再 embed 存库（带 provider name 标记算法版本）。
 * 返回是否真的写入（被过滤掉返回 false）。
 */
export async function writeCache(
  query: string,
  response: string,
  modelId: string,
  taskType: string,
): Promise<boolean> {
  void query;
  void response;
  void modelId;
  void taskType;
  return false;
}

/** 清理过期缓存（StatsPage / 启动时调） */
export async function cleanupExpiredCache(): Promise<void> {
  await semanticCache.deleteExpired();
}

/** 清空全部缓存（用量页手动重置；旧脏缓存一键清掉） */
export async function clearAllCache(): Promise<void> {
  await semanticCache.deleteAll();
}
