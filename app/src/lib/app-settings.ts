// v0.9 阶段7 — 应用级开关（localStorage 持久化）
//
// 目前有「智能路由 v2」开关 + 「权限档」持久化：
// - 智能路由 v2 是叠加在 v1 之上的可选增强：关掉后行为退回纯 v1 规则路由 + 不查语义缓存
//   （产品真北：用户始终可一键覆盖）
// - 权限档（read/confirm/auto）持久化：用户选过哪档就记哪档，关应用重启不丢
//   （2026-07-18 写权限双层重构：默认档从 read 改为 confirm——read 是纯只读审阅模式，
//   新用户默认应该能干活；confirm 能写但每次写盘前弹确认，记忆化让用户切过的档位跨会话保留）
import { useEffect, useState } from "react";

const SMART_ROUTING_KEY = "cosmgrid.smartRouting";
const PURE_SINGLE_MODEL_MODE_KEY = "cosmgrid.pureSingleModelMode";
const DEVELOPER_DIAGNOSTICS_KEY = "cosmgrid.developerDiagnostics";
const MEMORY_EMBEDDING_MODE_KEY = "cosmgrid.memoryEmbedding.mode";
const MEMORY_EMBEDDING_CREDENTIAL_KEY = "cosmgrid.memoryEmbedding.credentialId";
const MEMORY_EMBEDDING_MODEL_KEY = "cosmgrid.memoryEmbedding.modelName";

function hasLocalStorage(): boolean {
  return typeof localStorage !== "undefined"
    && typeof localStorage.getItem === "function"
    && typeof localStorage.setItem === "function";
}

/** 智能路由（v2）是否开启。默认开；只有显式存 "off" 才算关。 */
export function isSmartRoutingEnabled(): boolean {
  if (!hasLocalStorage()) return true;
  return localStorage.getItem(SMART_ROUTING_KEY) !== "off";
}

export function setSmartRoutingEnabled(on: boolean): void {
  if (!hasLocalStorage()) return;
  localStorage.setItem(SMART_ROUTING_KEY, on ? "on" : "off");
}

/** React hook 版：组件里读写开关 */
export function useSmartRoutingSetting(): [boolean, (on: boolean) => void] {
  const [enabled, setEnabled] = useState<boolean>(isSmartRoutingEnabled);

  useEffect(() => {
    setSmartRoutingEnabled(enabled);
  }, [enabled]);

  return [enabled, setEnabled];
}

/**
 * 纯净单模型模式（调试用）：关掉意图裁判、后台编排自动切模型、对弈自动触发、
 * 语义缓存、项目记忆检索、harness 自查重答闭环、**出错故障转移到备用模型**——
 * 只留"发消息→选中模型直接回复"这一条最基础的链路，出错就直接报错。
 * 用于排查"单模型对话本身是否正常工作"时把其余耦合层全部隔离掉——如果出错还偷偷换成
 * 别的模型接着答，排查对象就已经不是"单模型"了。默认关（不影响现有行为）。
 */
export function isPureSingleModelModeEnabled(): boolean {
  if (!hasLocalStorage()) return false;
  return localStorage.getItem(PURE_SINGLE_MODEL_MODE_KEY) === "on";
}

export function setPureSingleModelModeEnabled(on: boolean): void {
  if (!hasLocalStorage()) return;
  localStorage.setItem(PURE_SINGLE_MODEL_MODE_KEY, on ? "on" : "off");
}

export function usePureSingleModelModeSetting(): [boolean, (on: boolean) => void] {
  const [enabled, setEnabled] = useState<boolean>(isPureSingleModelModeEnabled);

  useEffect(() => {
    setPureSingleModelModeEnabled(enabled);
  }, [enabled]);

  return [enabled, setEnabled];
}

/** 工程化诊断面板（开发者工具）。默认关，避免普通用户右侧面板被内部状态淹没。 */
export function isDeveloperDiagnosticsEnabled(): boolean {
  if (!hasLocalStorage()) return false;
  return localStorage.getItem(DEVELOPER_DIAGNOSTICS_KEY) === "on";
}

export function setDeveloperDiagnosticsEnabled(on: boolean): void {
  if (!hasLocalStorage()) return;
  localStorage.setItem(DEVELOPER_DIAGNOSTICS_KEY, on ? "on" : "off");
}

export function useDeveloperDiagnosticsSetting(): [boolean, (on: boolean) => void] {
  const [enabled, setEnabled] = useState<boolean>(isDeveloperDiagnosticsEnabled);

  useEffect(() => {
    setDeveloperDiagnosticsEnabled(enabled);
  }, [enabled]);

  return [enabled, setEnabled];
}

export type MemoryEmbeddingMode = "local" | "remote";

export interface MemoryEmbeddingSetting {
  mode: MemoryEmbeddingMode;
  credentialId: string | null;
  modelName: string;
}

export const DEFAULT_MEMORY_EMBEDDING_MODEL = "text-embedding-3-small";

function isMemoryEmbeddingMode(value: string | null): value is MemoryEmbeddingMode {
  return value === "local" || value === "remote";
}

/** 项目记忆检索用的 embedding 设置。默认本地关键词哈希；只有显式开启 remote 才会请求外部接口。 */
export function getMemoryEmbeddingSetting(): MemoryEmbeddingSetting {
  if (!hasLocalStorage()) {
    return { mode: "local", credentialId: null, modelName: DEFAULT_MEMORY_EMBEDDING_MODEL };
  }
  const rawMode = localStorage.getItem(MEMORY_EMBEDDING_MODE_KEY);
  const mode = isMemoryEmbeddingMode(rawMode) ? rawMode : "local";
  const credentialId = localStorage.getItem(MEMORY_EMBEDDING_CREDENTIAL_KEY);
  const modelName = localStorage.getItem(MEMORY_EMBEDDING_MODEL_KEY)?.trim() || DEFAULT_MEMORY_EMBEDDING_MODEL;
  return {
    mode,
    credentialId: credentialId?.trim() ? credentialId : null,
    modelName,
  };
}

export function setMemoryEmbeddingSetting(setting: MemoryEmbeddingSetting): void {
  if (!hasLocalStorage()) return;
  localStorage.setItem(MEMORY_EMBEDDING_MODE_KEY, setting.mode);
  if (setting.credentialId?.trim()) {
    localStorage.setItem(MEMORY_EMBEDDING_CREDENTIAL_KEY, setting.credentialId.trim());
  } else {
    localStorage.removeItem(MEMORY_EMBEDDING_CREDENTIAL_KEY);
  }
  localStorage.setItem(MEMORY_EMBEDDING_MODEL_KEY, setting.modelName.trim() || DEFAULT_MEMORY_EMBEDDING_MODEL);
}

export function useMemoryEmbeddingSetting(): [MemoryEmbeddingSetting, (setting: MemoryEmbeddingSetting) => void] {
  const [setting, setSettingState] = useState<MemoryEmbeddingSetting>(getMemoryEmbeddingSetting);

  useEffect(() => {
    setMemoryEmbeddingSetting(setting);
  }, [setting]);

  return [setting, setSettingState];
}

// —— 权限档（read / confirm / auto）持久化 ——
export type PermissionMode = "read" | "confirm" | "auto";

const PERMISSION_MODE_KEY = "cosmgrid.permissionMode";
const VALID_PERMISSION_MODES: readonly PermissionMode[] = ["read", "confirm", "auto"];

/**
 * 读权限档。默认 confirm（2026-07-18 写权限双层重构：只读档是纯审阅模式，新用户首轮
 * 大概率是想让 AI 干活，默认卡死成只读只会让人以为"工具坏了"；confirm 档能写，但每次
 * 写盘前仍会弹确认，安全性不丢——是"能干活"和"不失控"之间更合理的默认值）。
 * localStorage 脏写（不是三档之一）也降级回 confirm，绝不让 UI 拿到非法值。
 */
export function getPermissionMode(): PermissionMode {
  if (!hasLocalStorage()) return "confirm";
  const raw = localStorage.getItem(PERMISSION_MODE_KEY);
  if (raw && (VALID_PERMISSION_MODES as readonly string[]).includes(raw)) {
    return raw as PermissionMode;
  }
  return "confirm";
}

export function setPermissionMode(mode: PermissionMode): void {
  if (!hasLocalStorage()) return;
  localStorage.setItem(PERMISSION_MODE_KEY, mode);
}

/** React hook 版：组件里读写权限档。setter 同步落 localStorage，重启保留用户习惯 */
export function usePermissionModeSetting(): [PermissionMode, (mode: PermissionMode) => void] {
  const [mode, setModeState] = useState<PermissionMode>(getPermissionMode);

  // 用 ref 镜像当前 mode，避免 useEffect 在 mount 时把默认值再写一次 localStorage
  // （getPermissionMode 已默认 read，首次不写也行；这里 effect 只在 mode 变化时同步）
  useEffect(() => {
    setPermissionMode(mode);
  }, [mode]);

  return [mode, setModeState];
}
