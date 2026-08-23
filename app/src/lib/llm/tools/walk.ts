// v0.7 阶段4 — 目录递归遍历 + 简单 glob 匹配（glob/grep 工具共用）

import ignore, { type Ignore } from "ignore";
import { getFsAdapter, type FsAdapter } from "./fs-adapter";
import { checkPath, isSensitivePath } from "./path-safety";

/** 默认忽略的目录（不下钻，省时省内存）。即使没有 .gitignore 也兜底剪掉这些重目录。 */
const DEFAULT_IGNORE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", "target", ".venv", "__pycache__",
]);

/** 读取工作区根的 .gitignore，构造匹配器。读不到就返回空匹配器（靠 DEFAULT_IGNORE_DIRS 兜底）。
 *  这样工具就和 claude code / ripgrep / opencode 一样尊重 .gitignore——
 *  否则会一头扎进 .gitignore 里排除的大目录（如本项目 23k 文件的 `技术参考/`），把文件名额耗光、搜不到真源码。 */
async function loadGitignore(workspaceRoot: string, fs: FsAdapter, strict = false): Promise<Ignore> {
  const ig = ignore();
  const candidate = `${workspaceRoot}/.gitignore`;
  if (isSensitivePath(candidate)) return ig;
  try {
    const check = await checkPath(workspaceRoot, candidate, strict ? { requireRealpath: true } : {});
    if (check.ok) ig.add(await fs.readTextFile(check.resolved));
  } catch {
    // Missing or unsafe .gitignore: use only DEFAULT_IGNORE_DIRS.
  }
  return ig;
}

export interface SafeWalkFile {
  relativePath: string;
  resolvedPath: string;
}

function isValidBasename(name: string): boolean {
  return name.length > 0 && name !== "." && name !== ".." && !name.includes("/") && !name.includes("\\");
}

/**
 * Walk an already-resolved search root while re-checking every directory and file.
 * Rejected descendants are intentionally silent so sensitive names are not enumerated.
 */
export async function walkSafeFiles(
  workspaceRoot: string,
  searchRoot: string,
  maxFiles = 5000,
): Promise<SafeWalkFile[]> {
  const fs = getFsAdapter();
  const rootCheck = await checkPath(workspaceRoot, searchRoot, { requireRealpath: true });
  if (!rootCheck.ok) throw new Error("搜索根目录无法完成安全校验");
  const workspaceCheck = await checkPath(workspaceRoot, workspaceRoot, { requireRealpath: true });
  if (!workspaceCheck.ok) throw new Error("搜索根目录无法完成安全校验");

  const ig = await loadGitignore(workspaceRoot, fs, true);
  const out: SafeWalkFile[] = [];

  const normalizedWorkspace = workspaceCheck.resolved.replace(/[\\]+/g, "/").replace(/\/$/, "");
  const normalizedSearch = rootCheck.resolved.replace(/[\\]+/g, "/").replace(/\/$/, "");
  const searchRel = normalizedSearch === normalizedWorkspace
    ? ""
    : normalizedSearch.startsWith(`${normalizedWorkspace}/`)
      ? normalizedSearch.slice(normalizedWorkspace.length + 1)
      : (() => { throw new Error("搜索根目录无法完成安全校验"); })();

  async function recurse(canonicalDir: string, workspaceRel: string, outputRel: string): Promise<void> {
    if (out.length >= maxFiles) return;
    let entries;
    try {
      entries = await fs.readDir(canonicalDir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= maxFiles || !isValidBasename(entry.name)) continue;
      const childWorkspaceRel = workspaceRel ? `${workspaceRel}/${entry.name}` : entry.name;
      const childOutputRel = outputRel ? `${outputRel}/${entry.name}` : entry.name;
      const lexical = `${workspaceRoot}/${childWorkspaceRel}`;
      if (isSensitivePath(lexical)) continue;
      if (entry.isDirectory === entry.isFile) continue;
      if (entry.isDirectory) {
        if (DEFAULT_IGNORE_DIRS.has(entry.name) || ig.ignores(`${childWorkspaceRel}/`)) continue;
        let checked;
        try {
          checked = await checkPath(workspaceRoot, lexical, { requireRealpath: true });
        } catch {
          continue;
        }
        if (!checked.ok || isSensitivePath(checked.resolved)) continue;
        await recurse(checked.resolved, childWorkspaceRel, childOutputRel);
      } else {
        if (ig.ignores(childWorkspaceRel)) continue;
        let checked;
        try {
          checked = await checkPath(workspaceRoot, lexical, { requireRealpath: true });
        } catch {
          continue;
        }
        if (!checked.ok || isSensitivePath(checked.resolved)) continue;
        out.push({ relativePath: childOutputRel, resolvedPath: checked.resolved });
      }
    }
  }

  await recurse(rootCheck.resolved, searchRel, "");
  return out;
}

/** 把 glob 模式编译成 RegExp。支持 ** （跨目录）、* （单层任意）、? （单字符）。 */
export function globToRegExp(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*"; // ** 跨目录
        i++;
        if (pattern[i + 1] === "/") i++; // 吞掉 **/ 的斜杠
      } else {
        re += "[^/]*"; // * 单层
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (".+^${}()|[]\\".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

/**
 * 递归收集 root 下的所有文件相对路径（POSIX 风格 /）。
 * 跳过 DEFAULT_IGNORE_DIRS；maxFiles 兜底防止超大目录卡死。
 */
export async function walkFiles(root: string, maxFiles = 5000): Promise<string[]> {
  const fs = getFsAdapter();
  const ig = await loadGitignore(root, fs);
  const out: string[] = [];

  async function recurse(dir: string, rel: string): Promise<void> {
    if (out.length >= maxFiles) return;
    let entries;
    try {
      entries = await fs.readDir(dir);
    } catch {
      return; // 读不了的目录跳过
    }
    for (const e of entries) {
      if (out.length >= maxFiles) return;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory) {
        if (DEFAULT_IGNORE_DIRS.has(e.name)) continue;
        // .gitignore 目录剪枝：带尾斜杠判断，整个目录不下钻（如 `技术参考/`）
        if (ig.ignores(`${childRel}/`)) continue;
        await recurse(`${dir}/${e.name}`, childRel);
      } else if (e.isFile) {
        if (ig.ignores(childRel)) continue; // 被 .gitignore 排除的文件不收集
        out.push(childRel);
      }
    }
  }

  await recurse(root, "");
  return out;
}

/**
 * 浅层目录树（给 workspace preamble 用）：只展开前 maxDepth 层，让模型开场就知道
 * 项目根下真实有什么，不用靠瞎猜 glob 模式去摸——弱模型摸不中容易误判"没有源码"。
 * 复用跟 walkFiles 一样的 .gitignore/DEFAULT_IGNORE_DIRS 规则，目录带尾斜杠标记。
 */
export async function listShallowTree(root: string, maxDepth = 2, maxEntries = 300): Promise<string[]> {
  const fs = getFsAdapter();
  const ig = await loadGitignore(root, fs);
  const out: string[] = [];

  async function recurse(dir: string, rel: string, depth: number): Promise<void> {
    if (out.length >= maxEntries) return;
    let entries;
    try {
      entries = await fs.readDir(dir);
    } catch {
      return;
    }
    const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
    for (const e of sorted) {
      if (out.length >= maxEntries) return;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory) {
        if (DEFAULT_IGNORE_DIRS.has(e.name)) continue;
        if (ig.ignores(`${childRel}/`)) continue;
        out.push(`${childRel}/`);
        if (depth < maxDepth) await recurse(`${dir}/${e.name}`, childRel, depth + 1);
      } else if (e.isFile) {
        if (ig.ignores(childRel)) continue;
        out.push(childRel);
      }
    }
  }

  await recurse(root, "", 1);
  return out;
}
