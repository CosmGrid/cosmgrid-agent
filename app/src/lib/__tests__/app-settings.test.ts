// app-settings 单测（v0.9 阶段7：智能路由开关）
import { describe, it, expect, beforeEach } from "vitest";

// node 环境无 localStorage，注入内存 stub
const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
};

import {
  DEFAULT_MEMORY_EMBEDDING_MODEL,
  getMemoryEmbeddingSetting,
  isDeveloperDiagnosticsEnabled,
  getPermissionMode,
  isSmartRoutingEnabled,
  setMemoryEmbeddingSetting,
  setDeveloperDiagnosticsEnabled,
  setPermissionMode,
  setSmartRoutingEnabled,
} from "../app-settings";

describe("智能路由开关", () => {
  beforeEach(() => store.clear());

  it("默认开启（未设置过）", () => {
    expect(isSmartRoutingEnabled()).toBe(true);
  });

  it("显式关闭后为 false", () => {
    setSmartRoutingEnabled(false);
    expect(isSmartRoutingEnabled()).toBe(false);
  });

  it("关闭后再开启为 true", () => {
    setSmartRoutingEnabled(false);
    setSmartRoutingEnabled(true);
    expect(isSmartRoutingEnabled()).toBe(true);
  });
});

describe("工程化诊断开关", () => {
  beforeEach(() => store.clear());

  it("默认关闭，普通用户不显示内部诊断面板", () => {
    expect(isDeveloperDiagnosticsEnabled()).toBe(false);
  });

  it("显式开启后才显示诊断面板", () => {
    setDeveloperDiagnosticsEnabled(true);
    expect(isDeveloperDiagnosticsEnabled()).toBe(true);
    setDeveloperDiagnosticsEnabled(false);
    expect(isDeveloperDiagnosticsEnabled()).toBe(false);
  });
});

describe("权限档持久化", () => {
  beforeEach(() => store.clear());

  // 2026-07-18 写权限双层重构：默认档从 read 改为 confirm——read 是纯只读审阅模式，
  // 新用户默认应该能干活；confirm 能写但每次写盘前弹确认，安全性不丢。
  it("默认 confirm（未设置过时，能写但每次写盘前弹确认）", () => {
    expect(getPermissionMode()).toBe("confirm");
  });

  it("切到 read 后再读回就是 read", () => {
    setPermissionMode("read");
    expect(getPermissionMode()).toBe("read");
  });

  it("切到 auto 后能切回 confirm", () => {
    setPermissionMode("auto");
    expect(getPermissionMode()).toBe("auto");
    setPermissionMode("confirm");
    expect(getPermissionMode()).toBe("confirm");
  });

  it("localStorage 脏写（非三档之一）降级回 confirm，绝不让 UI 拿到非法值", () => {
    store.set("cosmgrid.permissionMode", "garbage_value");
    expect(getPermissionMode()).toBe("confirm");
  });
});

describe("项目记忆 embedding 设置", () => {
  beforeEach(() => store.clear());

  it("默认使用本地快速检索", () => {
    expect(getMemoryEmbeddingSetting()).toEqual({
      mode: "local",
      credentialId: null,
      modelName: DEFAULT_MEMORY_EMBEDDING_MODEL,
    });
  });

  it("可保存远程真实向量配置", () => {
    setMemoryEmbeddingSetting({
      mode: "remote",
      credentialId: "cred-1",
      modelName: "text-embedding-3-large",
    });

    expect(getMemoryEmbeddingSetting()).toEqual({
      mode: "remote",
      credentialId: "cred-1",
      modelName: "text-embedding-3-large",
    });
  });

  it("脏 mode 降级回 local，空模型降级到默认模型", () => {
    store.set("cosmgrid.memoryEmbedding.mode", "garbage");
    store.set("cosmgrid.memoryEmbedding.modelName", "   ");

    expect(getMemoryEmbeddingSetting()).toEqual({
      mode: "local",
      credentialId: null,
      modelName: DEFAULT_MEMORY_EMBEDDING_MODEL,
    });
  });
});
