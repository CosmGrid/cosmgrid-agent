// usage-tracker 单测（v0.9 阶段7：role 落盘修复 — 不再写死 "main_chat"）
import { describe, it, expect, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  savingsCreate: vi.fn(),
}));

// db 的 usageEvents.create mock 掉，只验证传进去的 role
// 注意：usage-tracker 在 src/lib/llm/，引的是 "../db" = src/lib/db；
// 本测试在 __tests__/，故 mock 路径要多一层 "../../db"
vi.mock("../../db", () => ({
  usageEvents: { create: mocks.create },
  savingsEvents: { create: mocks.savingsCreate },
}));
// 成本计算 mock 成固定值，隔离价格表
vi.mock("../cost-calculator", () => ({
  estimateCostWithCatalog: vi.fn(() => ({
    cost: 0.001,
    pricingKnown: true,
    priceCatalogId: "price-actual",
    priceVersion: "test-version",
    priceSource: "builtin",
    priceSourceUrl: "builtin:test",
    resolvedPrice: null,
  })),
}));
// 模型表现统计是旁路，单测 usage-tracker 时 mock 掉，避免触达 db
vi.mock("../model-performance-stats", () => ({
  recordPerformanceSample: vi.fn(),
}));

import { recordUsageEvent, flushPendingWrites } from "../usage-tracker";
import { estimateCostWithCatalog, type CatalogCostEstimate } from "../cost-calculator";

const baseParams = {
  modelId: "m-1",
  modelName: "test-model",
  providerType: "openai",
  providerId: "prov-1",
  apiCredentialId: "cred-1",
  usage: { inputTokens: 100, outputTokens: 50 },
  finishReason: "stop",
};

describe("recordUsageEvent — role 落盘", () => {
  beforeEach(() => {
    mocks.create.mockClear();
    mocks.create.mockResolvedValue("usage-1");
    mocks.savingsCreate.mockClear();
    mocks.savingsCreate.mockResolvedValue(undefined);
  });

  it("传入 role 时按传入值落盘（不再写死 main_chat）", async () => {
    await recordUsageEvent({ ...baseParams, role: "hard" }, { awaitWrite: true });
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.create.mock.calls[0]![0]).toMatchObject({ role: "hard" });
  });

  it("不传 role 时兜底为 main_chat（向后兼容）", async () => {
    await recordUsageEvent(baseParams, { awaitWrite: true });
    expect(mocks.create.mock.calls[0]![0]).toMatchObject({ role: "main_chat" });
  });

  it("role 取值覆盖三种 complexity 桶", async () => {
    for (const role of ["simple", "standard", "hard"] as const) {
      mocks.create.mockClear();
      await recordUsageEvent({ ...baseParams, role }, { awaitWrite: true });
      expect(mocks.create.mock.calls[0]![0]).toMatchObject({ role });
    }
  });

  it("token / cost / success 仍正确透传", async () => {
    await recordUsageEvent({ ...baseParams, role: "standard" }, { awaitWrite: true });
    expect(mocks.create.mock.calls[0]![0]).toMatchObject({
      modelId: "m-1",
      inputTokens: 100,
      outputTokens: 50,
      cost: 0.001,
      pricingKnown: true,
      priceCatalogId: "price-actual",
      success: true,
    });
  });

  it("查价时传 providerType，避免同名模型跨 provider 错价", async () => {
    await recordUsageEvent({ ...baseParams, providerType: "openai-compatible" }, { awaitWrite: true });
    expect(estimateCostWithCatalog).toHaveBeenCalledWith(
      "test-model",
      { inputTokens: 100, outputTokens: 50 },
      "openai-compatible",
    );
  });

  it("finishReason=end_turn 也算正常调用，避免 CLI 正常结束被误判为不稳定", async () => {
    await recordUsageEvent({ ...baseParams, finishReason: "end_turn" }, { awaitWrite: true });
    expect(mocks.create.mock.calls[0]![0]).toMatchObject({
      success: true,
    });
  });

  it("finishReason=length 不算正常调用", async () => {
    await recordUsageEvent({ ...baseParams, finishReason: "length" }, { awaitWrite: true });
    expect(mocks.create.mock.calls[0]![0]).toMatchObject({
      success: false,
    });
  });

  it("flushPendingWrites 等待未 await 的写入完成", async () => {
    recordUsageEvent({ ...baseParams, role: "simple" });
    await flushPendingWrites();
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });
});

describe("阶段 F1 H3：roleKind 透传 + spread 守门（review F1-7）", () => {
  beforeEach(() => {
    mocks.create.mockClear();
    mocks.create.mockResolvedValue("usage-1");
    mocks.savingsCreate.mockClear();
    mocks.savingsCreate.mockResolvedValue(undefined);
  });

  it("roleKind='frontend' → usageEvents.create 入参含 roleKind='frontend'", async () => {
    await recordUsageEvent({ ...baseParams, roleKind: "frontend" }, { awaitWrite: true });
    expect(mocks.create.mock.calls[0]![0]).toMatchObject({ roleKind: "frontend" });
  });

  it("roleKind=undefined → 入参对象不含 roleKind 字段（spread 守门，让 db 层 ?? null 兜底）", async () => {
    await recordUsageEvent(baseParams, { awaitWrite: true });
    const calledArg = mocks.create.mock.calls[0]![0] as Record<string, unknown>;
    expect("roleKind" in calledArg).toBe(false);
  });

  it("roleKind=null → 入参 roleKind=null（明确归'未分类'组，区别于 undefined）", async () => {
    await recordUsageEvent({ ...baseParams, roleKind: null }, { awaitWrite: true });
    const calledArg = mocks.create.mock.calls[0]![0] as Record<string, unknown>;
    expect(calledArg.roleKind).toBeNull();
  });

  it("roleKind='stage' → 入参含 roleKind='stage'（stage 不是 RoleId，是合法 actor_role 值）", async () => {
    await recordUsageEvent({ ...baseParams, roleKind: "stage" }, { awaitWrite: true });
    expect(mocks.create.mock.calls[0]![0]).toMatchObject({ roleKind: "stage" });
  });

  it("role 和 roleKind 同存不互相覆盖（两者独立维度）", async () => {
    await recordUsageEvent(
      { ...baseParams, role: "hard", roleKind: "frontend" },
      { awaitWrite: true },
    );
    expect(mocks.create.mock.calls[0]![0]).toMatchObject({
      role: "hard",        // workRole 难度桶：不变
      roleKind: "frontend", // 阶段 F1 新增：actor 维度
    });
  });
});

// =====================================================================
// 分支覆盖（v0.9 review）：flush / options / savings 分支 / 错误处理
// ---------------------------------------------------------------------
// 关注的分支（覆盖前 43.75% → 目标 ≥ 80%）：
//   L48:  flushPendingWrites 空集早返回（true 分支）
//   L55:  options.awaitWrite 决定是否返回 promise（false 分支 → void）
//   L83:  if (success && costEstimate.pricingKnown && costEstimate.resolvedPrice)
//         各短路分支：pricingKnown=false / resolvedPrice=null / 全 true 进入
//   L89:  if (cacheSavings) — 计算为空 vs 计算为对象
//   L111: if (params.routingDecision && actualModelId === params.modelId)
//         — 未传 / actualModelId 不匹配 / 命中后 baseline pricingKnown=false / saved<=0 / 写盘
//   L151: if (params.compressionStats) — 未传 / saved<=0 / 写盘
//   L189: catch (error) — 写入失败捕获 + console.error
//   spread: projectId / conversationId / interrupted / latencyMs / cacheTokens ?? 0
// =====================================================================

const KNOWN_PRICE = {
  input: 1,
  output: 1,
  contextWindow: 128_000,
  cacheRead: 0.1,
  cacheWrite: 1.25,
} as const;

async function makeCost(overrides: Partial<CatalogCostEstimate> = {}): Promise<CatalogCostEstimate> {
  return {
    cost: 0.001,
    pricingKnown: true,
    priceCatalogId: "price-actual",
    priceVersion: "test-version",
    priceSource: "builtin",
    priceSourceUrl: "builtin:test",
    resolvedPrice: null,
    ...overrides,
  };
}

describe("usage-tracker 分支覆盖：flush / options / savings / errors", () => {
  beforeEach(() => {
    mocks.create.mockReset();
    mocks.create.mockResolvedValue("usage-1");
    mocks.savingsCreate.mockReset();
    mocks.savingsCreate.mockResolvedValue(undefined);
    vi.mocked(estimateCostWithCatalog).mockReset();
    vi.mocked(estimateCostWithCatalog).mockImplementation(() => makeCost());
  });

  // ---------- flushPendingWrites 分支 ----------
  it("flushPendingWrites 无 pending writes 时直接返回（早返回分支 L48）", async () => {
    await flushPendingWrites();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.savingsCreate).not.toHaveBeenCalled();
  });

  it("flushPendingWrites 有 pending writes 时等待 Promise.allSettled 完成（L49）", async () => {
    // 排空之前的 pending（保险），然后创建一笔 fire-and-forget 写入并 flush
    await flushPendingWrites();
    mocks.create.mockClear();
    recordUsageEvent({ ...baseParams, role: "hard" });
    // pending set 此时非空
    await flushPendingWrites();
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });

  // ---------- recordUsageEvent 选项 / 返回类型分支 ----------
  it("不传 awaitWrite 选项时 recordUsageEvent 返回 undefined（fire-and-forget 路径）", async () => {
    const ret = recordUsageEvent({ ...baseParams, role: "hard" });
    expect(ret).toBeUndefined();
    await flushPendingWrites(); // 清场，避免污染下一个测试
  });

  it("awaitWrite:false 时仍返回 undefined（条件 false 分支）", async () => {
    const ret = recordUsageEvent({ ...baseParams, role: "hard" }, { awaitWrite: false });
    expect(ret).toBeUndefined();
    await flushPendingWrites();
  });

  it("awaitWrite:true 时返回 Promise<void> 实例", async () => {
    const ret = recordUsageEvent({ ...baseParams, role: "hard" }, { awaitWrite: true });
    expect(ret).toBeInstanceOf(Promise);
  });

  // ---------- success 分支（finishReason） ----------
  it("finishReason=length (success=false) 跳过整段 savings 计算", async () => {
    vi.mocked(estimateCostWithCatalog).mockImplementation(() =>
      makeCost({ resolvedPrice: { ...KNOWN_PRICE, catalogId: "c", version: "v", source: "builtin", sourceUrl: "u" } }),
    );
    await recordUsageEvent({ ...baseParams, finishReason: "length", role: "hard" }, { awaitWrite: true });
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.savingsCreate).not.toHaveBeenCalled();
  });

  // ---------- pricingKnown / resolvedPrice 短路分支 ----------
  it("pricingKnown=false 时跳过 savings 块（costEstimate.pricingKnown 短路分支）", async () => {
    vi.mocked(estimateCostWithCatalog).mockImplementation(() => makeCost({ pricingKnown: false }));
    await recordUsageEvent({ ...baseParams, role: "hard" }, { awaitWrite: true });
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.savingsCreate).not.toHaveBeenCalled();
  });

  it("pricingKnown=true 但 resolvedPrice=null 时跳过 savings 块（resolvedPrice 短路分支）", async () => {
    // 默认 mock 已经是这个分支，但显式重置后断言更有保障
    vi.mocked(estimateCostWithCatalog).mockImplementation(() =>
      makeCost({ pricingKnown: true, resolvedPrice: null }),
    );
    await recordUsageEvent({ ...baseParams, role: "hard" }, { awaitWrite: true });
    expect(mocks.savingsCreate).not.toHaveBeenCalled();
  });

  // ---------- 进入 savings 块：默认三个子分支都跳过 ----------
  it("成功 + pricingKnown + resolvedPrice 全满足时进入 savings 块，但 cache/routing/compression 默认都返回 null", async () => {
    vi.mocked(estimateCostWithCatalog).mockImplementation(() =>
      makeCost({ resolvedPrice: { ...KNOWN_PRICE, catalogId: "c", version: "v", source: "builtin", sourceUrl: "u" } }),
    );
    await recordUsageEvent({ ...baseParams, role: "hard" }, { awaitWrite: true });
    expect(mocks.create).toHaveBeenCalledTimes(1);
    // 没 cacheReadInputTokens → cacheSavings=null；没 routingDecision → 跳过；没 compressionStats → 跳过
    expect(mocks.savingsCreate).not.toHaveBeenCalled();
  });

  // ---------- cache savings 命中 ----------
  it("cacheHitTokens>0 + cacheRead<input + cacheRead 已知 → 写一行 cache savings（kind=cache）", async () => {
    vi.mocked(estimateCostWithCatalog).mockImplementation(() =>
      makeCost({ resolvedPrice: { ...KNOWN_PRICE, catalogId: "c", version: "v", source: "builtin", sourceUrl: "u" } }),
    );
    await recordUsageEvent(
      {
        ...baseParams,
        role: "hard",
        usage: { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 100 },
      },
      { awaitWrite: true },
    );
    expect(mocks.savingsCreate).toHaveBeenCalledTimes(1);
    const arg = mocks.savingsCreate.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.kind).toBe("cache");
    expect(arg.formulaVersion).toBe("cache-v1");
  });

  // ---------- routingDecision 全部 false / 不匹配 分支 ----------
  it("不传 routingDecision 时跳过整段 routing 分支（外层条件 false）", async () => {
    vi.mocked(estimateCostWithCatalog).mockImplementation(() =>
      makeCost({ resolvedPrice: { ...KNOWN_PRICE, catalogId: "c", version: "v", source: "builtin", sourceUrl: "u" } }),
    );
    await recordUsageEvent({ ...baseParams, role: "hard" }, { awaitWrite: true });
    expect(mocks.savingsCreate).not.toHaveBeenCalled();
  });

  it("routingDecision.actualModelId !== params.modelId 时跳过 routing（内层条件 false）", async () => {
    vi.mocked(estimateCostWithCatalog).mockImplementation(() =>
      makeCost({ resolvedPrice: { ...KNOWN_PRICE, catalogId: "c", version: "v", source: "builtin", sourceUrl: "u" } }),
    );
    await recordUsageEvent(
      {
        ...baseParams,
        role: "hard",
        // modelId 是 'm-1'，actualModelId 故意不匹配
        routingDecision: {
          baselineModelId: "baseline-1",
          baselineModelName: "baseline-name",
          actualModelId: "different-actual",
        },
      },
      { awaitWrite: true },
    );
    expect(mocks.savingsCreate).not.toHaveBeenCalled();
  });

  it("routingDecision 命中（actualModelId === modelId）但 baseline pricingKnown=false → 跳过 routing savings（baselineEstimate.pricingKnown 分支）", async () => {
    // 第一次调用（主成本）返回 known + resolvedPrice，第二次（baseline 估算）返回 unknown
    vi.mocked(estimateCostWithCatalog)
      .mockImplementationOnce(() =>
        makeCost({ resolvedPrice: { ...KNOWN_PRICE, catalogId: "c", version: "v", source: "builtin", sourceUrl: "u" } }),
      )
      .mockImplementationOnce(() => makeCost({ pricingKnown: false }));
    await recordUsageEvent(
      {
        ...baseParams,
        role: "hard",
        routingDecision: {
          baselineModelId: "baseline-1",
          baselineModelName: "baseline-unknown",
          actualModelId: "m-1",
        },
      },
      { awaitWrite: true },
    );
    expect(mocks.savingsCreate).not.toHaveBeenCalled();
  });

  it("routingDecision 命中 + baseline 更便宜 → calculateRoutingSavings 返回 null（saved<=0 分支）", async () => {
    // 主成本贵（0.001），baseline 估算更便宜（0.0001），saved = 0.0001 - 0.001 = -0.0009 → null
    vi.mocked(estimateCostWithCatalog)
      .mockImplementationOnce(() =>
        makeCost({ resolvedPrice: { ...KNOWN_PRICE, catalogId: "c", version: "v", source: "builtin", sourceUrl: "u" } }),
      )
      .mockImplementationOnce(() =>
        makeCost({ cost: 0.0001, resolvedPrice: { ...KNOWN_PRICE, catalogId: "c2", version: "v2", source: "builtin", sourceUrl: "u2" } }),
      );
    await recordUsageEvent(
      {
        ...baseParams,
        role: "hard",
        routingDecision: {
          baselineModelId: "baseline-cheap",
          baselineModelName: "baseline-cheap",
          actualModelId: "m-1",
        },
      },
      { awaitWrite: true },
    );
    expect(mocks.savingsCreate).not.toHaveBeenCalled();
  });

  it("routingDecision 全部命中 → 写一行 routing savings（kind=routing）", async () => {
    // 主成本便宜（actualCost=0.001），baseline 更贵（baselineCost=0.01），saved > 0
    vi.mocked(estimateCostWithCatalog)
      .mockImplementationOnce(() =>
        makeCost({ resolvedPrice: { ...KNOWN_PRICE, catalogId: "c", version: "v", source: "builtin", sourceUrl: "u" } }),
      )
      .mockImplementationOnce(() =>
        makeCost({ cost: 0.01, resolvedPrice: { ...KNOWN_PRICE, catalogId: "c2", version: "v2", source: "builtin", sourceUrl: "u2" } }),
      );
    await recordUsageEvent(
      {
        ...baseParams,
        role: "hard",
        routingDecision: {
          baselineModelId: "baseline-expensive",
          baselineModelName: "baseline-expensive",
          actualModelId: "m-1",
        },
      },
      { awaitWrite: true },
    );
    expect(mocks.savingsCreate).toHaveBeenCalledTimes(1);
    const arg = mocks.savingsCreate.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.kind).toBe("routing");
    expect(arg.formulaVersion).toBe("routing-v1");
    expect(arg.baselineCost).toBeGreaterThan(arg.actualCost as number);
  });

  // ---------- compressionStats 分支 ----------
  it("compressionStats.beforeTokens <= afterTokens → compressionSavings=null（不写盘）", async () => {
    vi.mocked(estimateCostWithCatalog).mockImplementation(() =>
      makeCost({ resolvedPrice: { ...KNOWN_PRICE, catalogId: "c", version: "v", source: "builtin", sourceUrl: "u" } }),
    );
    await recordUsageEvent(
      {
        ...baseParams,
        role: "hard",
        compressionStats: { beforeTokens: 100, afterTokens: 200 }, // after > before → null
      },
      { awaitWrite: true },
    );
    expect(mocks.savingsCreate).not.toHaveBeenCalled();
  });

  it("compressionStats 命中 → 写一行 compression savings（kind=compression）", async () => {
    vi.mocked(estimateCostWithCatalog).mockImplementation(() =>
      makeCost({ resolvedPrice: { ...KNOWN_PRICE, catalogId: "c", version: "v", source: "builtin", sourceUrl: "u" } }),
    );
    await recordUsageEvent(
      {
        ...baseParams,
        role: "hard",
        compressionStats: { beforeTokens: 1000, afterTokens: 100 }, // 缩小 10 倍 → saved > 0
      },
      { awaitWrite: true },
    );
    expect(mocks.savingsCreate).toHaveBeenCalledTimes(1);
    const arg = mocks.savingsCreate.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.kind).toBe("compression");
    expect(arg.formulaVersion).toBe("compression-v1");
  });

  // ---------- interrupted / projectId / conversationId / cacheTokens ??0 / latencyMs spread ----------
  it("interrupted=true 时贯穿到 usageEvents.create（params.interrupted ?? false 真分支）", async () => {
    await recordUsageEvent(
      { ...baseParams, role: "hard", interrupted: true },
      { awaitWrite: true },
    );
    expect(mocks.create.mock.calls[0]![0]).toMatchObject({ interrupted: true });
  });

  it("不传 interrupted → 默认 false（?? false 假分支）", async () => {
    await recordUsageEvent({ ...baseParams, role: "hard" }, { awaitWrite: true });
    expect(mocks.create.mock.calls[0]![0]).toMatchObject({ interrupted: false });
  });

  it("projectId / conversationId 显式传入时贯穿（?? null 真分支）", async () => {
    await recordUsageEvent(
      {
        ...baseParams,
        role: "hard",
        projectId: "proj-x",
        conversationId: "conv-y",
      },
      { awaitWrite: true },
    );
    const arg = mocks.create.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.projectId).toBe("proj-x");
    expect(arg.conversationId).toBe("conv-y");
  });

  it("不传 projectId / conversationId → 写入 null（?? null 假分支）", async () => {
    await recordUsageEvent({ ...baseParams, role: "hard" }, { awaitWrite: true });
    const arg = mocks.create.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.projectId).toBeNull();
    expect(arg.conversationId).toBeNull();
  });

  it("usage.inputTokens/outputTokens/cacheWriteInputTokens/cacheReadInputTokens 缺失时默认 0（?? 0 各假分支）", async () => {
    await recordUsageEvent(
      {
        ...baseParams,
        role: "hard",
        usage: { inputTokens: 7, outputTokens: 0 } as never, // outputTokens 显式 0；cacheRead/cacheWrite 都缺失
      },
      { awaitWrite: true },
    );
    const arg = mocks.create.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.inputTokens).toBe(7);
    expect(arg.outputTokens).toBe(0);
    expect(arg.cacheCreationTokens).toBe(0);
    expect(arg.cacheHitTokens).toBe(0);
  });

  it("usage.inputTokens/outputTokens 显式 undefined 时真值兜底为 0（?? 0 各真分支）", async () => {
    await recordUsageEvent(
      {
        ...baseParams,
        role: "hard",
        // 显式 undefined，让 ?? 命中真分支（用 0）
        usage: { inputTokens: undefined, outputTokens: undefined } as never,
      },
      { awaitWrite: true },
    );
    const arg = mocks.create.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.inputTokens).toBe(0);
    expect(arg.outputTokens).toBe(0);
  });

  it("usage.cacheReadInputTokens/cacheWriteInputTokens 显式传入时贯穿", async () => {
    await recordUsageEvent(
      {
        ...baseParams,
        role: "hard",
        usage: { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 20, cacheWriteInputTokens: 30 },
      },
      { awaitWrite: true },
    );
    const arg = mocks.create.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.cacheHitTokens).toBe(20);
    expect(arg.cacheCreationTokens).toBe(30);
  });

  // ---------- error 路径（catch） ----------
  it("usageEvents.create 抛错时 catch 接住并 console.error（错误兜底路径）", async () => {
    mocks.create.mockReset();
    mocks.create.mockRejectedValueOnce(new Error("db boom"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await recordUsageEvent({ ...baseParams, role: "hard" }, { awaitWrite: true });
      expect(errSpy).toHaveBeenCalled();
      const firstArg = errSpy.mock.calls[0]?.[0];
      expect(typeof firstArg === "string" ? firstArg : "").toContain("usage-tracker");
    } finally {
      errSpy.mockRestore();
    }
  });

  it("success 时 savings 一整段失败 → catch 接住（写盘失败不影响主流程）", async () => {
    vi.mocked(estimateCostWithCatalog).mockImplementation(() =>
      makeCost({ resolvedPrice: { ...KNOWN_PRICE, catalogId: "c", version: "v", source: "builtin", sourceUrl: "u" } }),
    );
    mocks.savingsCreate.mockReset();
    mocks.savingsCreate.mockRejectedValueOnce(new Error("savings boom"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // 给 cacheReadInputTokens 让 calculateCacheSavings 非空，从而触发 savingsEvents.create
      await recordUsageEvent(
        {
          ...baseParams,
          role: "hard",
          usage: { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 100 },
        },
        { awaitWrite: true },
      );
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });

  // ---------- providerType / latencyMs 剩余真分支 ----------
  it("不传 providerType → estimateCostWithCatalog 第三参为 null（?? null 真分支）", async () => {
    // baseParams 默认有 providerType='openai'，这里手动剥离掉
    const { providerType: _drop, ...noProvider } = baseParams;
    void _drop;
    await recordUsageEvent({ ...noProvider, role: "hard" }, { awaitWrite: true });
    expect(estimateCostWithCatalog).toHaveBeenCalledWith(
      "test-model",
      { inputTokens: 100, outputTokens: 50 },
      null,
    );
  });

  it("latencyMs 显式传入 → recordPerformanceSample 的 metric 参数含 latencyMs 字段（spread 真分支）", async () => {
    const perfMod = await import("../model-performance-stats");
    await recordUsageEvent(
      { ...baseParams, role: "hard", latencyMs: 1234 },
      { awaitWrite: true },
    );
    const calls = vi.mocked(perfMod.recordPerformanceSample).mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(1);
    const last = calls[calls.length - 1]!;
    const perfArg = last[2] as unknown as Record<string, unknown>;
    expect(perfArg.latencyMs).toBe(1234);
  });
});

describe("recordUsageEvent — success 字段随 finishReason 联动（C 档第1/4步，2026-07-12）", () => {
  // 这个联动本身是既有逻辑（success = isNormalFinishReason(finishReason)），没有改代码；
  // 加这组测试是为了锁死它——chat-fallback.ts 现在会在"内容不完整"时改传
  // finishReason="empty_response" 而不是模型原始报的 "stop"，落库的 success 必须
  // 跟着变成 false，这张表才不会继续把"思考写一半就停"的假成功记成成功。
  beforeEach(() => {
    mocks.create.mockClear();
    mocks.create.mockResolvedValue("usage-1");
    mocks.savingsCreate.mockClear();
    mocks.savingsCreate.mockResolvedValue(undefined);
  });

  it("finishReason='empty_response'（内容不完整判定）→ success=false", async () => {
    await recordUsageEvent({ ...baseParams, finishReason: "empty_response" }, { awaitWrite: true });
    expect(mocks.create.mock.calls[0]![0]).toMatchObject({ success: false });
  });

  it("finishReason='stop'（真正说完了）→ success=true", async () => {
    await recordUsageEvent({ ...baseParams, finishReason: "stop" }, { awaitWrite: true });
    expect(mocks.create.mock.calls[0]![0]).toMatchObject({ success: true });
  });

  it("finishReason='end_turn' → success=true", async () => {
    await recordUsageEvent({ ...baseParams, finishReason: "end_turn" }, { awaitWrite: true });
    expect(mocks.create.mock.calls[0]![0]).toMatchObject({ success: true });
  });

  it("finishReason='length'（截断）→ success=false", async () => {
    await recordUsageEvent({ ...baseParams, finishReason: "length" }, { awaitWrite: true });
    expect(mocks.create.mock.calls[0]![0]).toMatchObject({ success: false });
  });
});
