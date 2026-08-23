// semantic-cache 单测（v0.9 阶段7：写入过滤 + 余弦命中 + 命中计数）
import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  listValid: vi.fn(),
  recordHit: vi.fn(),
  deleteExpired: vi.fn(),
  embed: vi.fn(),
}));

vi.mock("../../db", () => ({
  semanticCache: {
    create: mocks.create,
    listValid: mocks.listValid,
    recordHit: mocks.recordHit,
    deleteExpired: mocks.deleteExpired,
  },
}));
vi.mock("../embedding", () => ({
  getEmbeddingProvider: () => ({ name: "test-provider", embed: mocks.embed }),
}));

import { lookupCache, writeCache, cleanupExpiredCache } from "../semantic-cache";

function row(query: string, response: string, over: Record<string, unknown> = {}) {
  return {
    id: `c-${query}`,
    queryText: query,
    queryEmbedding: [1, 0, 0],
    responseText: response,
    modelId: "m-1",
    taskType: "standard",
    providerName: "keyword-hash-v2", // 匹配当前 keywordEmbeddingProvider.name
    hitCount: 0,
    lastHitAt: null,
    expiresAt: new Date(Date.now() + 1000).toISOString(),
    createdAt: new Date().toISOString(),
    ...over,
  };
}

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.create.mockResolvedValue(undefined);
  mocks.recordHit.mockResolvedValue(undefined);
  mocks.deleteExpired.mockResolvedValue(undefined);
  mocks.embed.mockResolvedValue([1, 0, 0]);
});

describe("lookupCache", () => {
  it("无缓存时返回 null", async () => {
    mocks.listValid.mockResolvedValue([]);
    expect(await lookupCache("任意")).toBeNull();
  });

  it("A2a 永久旁路：命中相同 query 也返回 null 且不访问缓存", async () => {
    mocks.listValid.mockResolvedValue([row("什么是闭包", "闭包是函数加词法环境")]);
    const hit = await lookupCache("什么是闭包");
    expect(hit).toBeNull();
    expect(mocks.listValid).not.toHaveBeenCalled();
    expect(mocks.recordHit).not.toHaveBeenCalled();
    expect(mocks.embed).not.toHaveBeenCalled();
  });

  it("无关 query 不命中（相似度低于阈值）", async () => {
    mocks.listValid.mockResolvedValue([row("数据库索引优化", "建索引加速查询")]);
    const hit = await lookupCache("今天天气怎么样啊朋友");
    expect(hit).toBeNull();
    expect(mocks.recordHit).not.toHaveBeenCalled();
  });

  it("A2a 永久旁路：多条历史缓存也不读取", async () => {
    mocks.listValid.mockResolvedValue([
      row("解释闭包概念", "答案A"),
      row("什么是闭包", "答案B"),
    ]);
    const hit = await lookupCache("什么是闭包");
    expect(hit).toBeNull();
    expect(mocks.listValid).not.toHaveBeenCalled();
    expect(mocks.embed).not.toHaveBeenCalled();
  });

  it("维度不一致的旧缓存被跳过（换过 provider）", async () => {
    mocks.listValid.mockResolvedValue([
      { ...row("什么是闭包", "x"), queryEmbedding: [0.1, 0.2] }, // 错误维度
    ]);
    expect(await lookupCache("什么是闭包")).toBeNull();
  });

  it("provider name 不匹配的旧缓存被跳过（跨算法版本 — HIGH-1 防线）", async () => {
    // 旧版本写入的缓存（如 'keyword-hash'），vec 跟当前 v2 算法不兼容，绝不能命中
    mocks.listValid.mockResolvedValue([
      { ...row("什么是闭包", "旧答案"), providerName: "keyword-hash" },
    ]);
    expect(await lookupCache("什么是闭包")).toBeNull();
    expect(mocks.recordHit).not.toHaveBeenCalled();
  });
});

describe("D9：lookupCache 仅按当前 embedding provider 拉缓存", () => {
  it("A2a 不调用 listValid", async () => {
    mocks.listValid.mockResolvedValue([row("什么是闭包", "闭包是函数加词法环境")]);
    await lookupCache("什么是闭包");
    expect(mocks.listValid).not.toHaveBeenCalled();
  });

  it("DB 层 mock 即便返回别的 provider 的整批 vec，lookup 也不命中（双重防线）", async () => {
    // 即便有人误把 listValid 实现成拉全表，JS 层 providerName 不匹配也会 skip
    mocks.listValid.mockResolvedValue([
      { ...row("什么是闭包", "旧答案"), providerName: "some-other-provider" },
    ]);
    expect(await lookupCache("什么是闭包")).toBeNull();
    expect(mocks.recordHit).not.toHaveBeenCalled();
  });
});

describe("writeCache — 保守过滤", () => {
  it("A2a 永久旁路：普通问答也不写缓存", async () => {
    const before = Date.now();
    const ok = await writeCache("什么是闭包", "闭包是...", "m-1", "standard");
    void before;
    expect(ok).toBe(false);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.embed).not.toHaveBeenCalled();
  });

  it("时间敏感 query 不写", async () => {
    const ok = await writeCache("今天的汇率", "7.1", "m-1", "standard");
    expect(ok).toBe(false);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("答案含代码不写", async () => {
    const ok = await writeCache("写个函数", "```js\nfn(){}\n```", "m-1", "standard");
    expect(ok).toBe(false);
    expect(mocks.create).not.toHaveBeenCalled();
  });
});

describe("cleanupExpiredCache", () => {
  it("调用 db deleteExpired", async () => {
    await cleanupExpiredCache();
    expect(mocks.deleteExpired).toHaveBeenCalledTimes(1);
  });
});
