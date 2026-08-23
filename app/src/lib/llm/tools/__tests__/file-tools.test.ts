// read/glob/grep 工具单测（v0.7 阶段4，用内存假 fs）
//
// L6 安全网收拢（2026-07-09）：checkPath 现在由 executor 按 tool.security 声明统一跑，
// 工具自己不再调用——测试改走 executeTool（跟生产路径一致），不再直接调 tool.execute。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const auditCreate = vi.hoisted(() => vi.fn().mockResolvedValue("id"));
vi.mock("../../../db", () => ({
  toolExecutions: { create: auditCreate },
}));

import { setFsAdapter, type FsAdapter, type FsDirEntry } from "../fs-adapter";
import { readTool } from "../read-tool";
import { globTool } from "../glob-tool";
import { grepTool } from "../grep-tool";
import { executeTool } from "../executor";
import { globToRegExp, walkSafeFiles } from "../walk";
import { formatHashLine } from "../hashline";
import { getDefaultRealpathFn, setDefaultRealpathFn } from "../path-safety";
import type { ToolContext } from "../types";

const WS = "/ws";
const ctx: ToolContext = { workspacePath: WS };
const previousRealpath = getDefaultRealpathFn();

// 从「绝对路径→内容」map 合成一个假 FsAdapter
function makeFakeFs(files: Record<string, string>): FsAdapter {
  const paths = Object.keys(files);
  return {
    readTextFile: async (p) => {
      if (p in files) return files[p]!;
      throw new Error(`ENOENT: ${p}`);
    },
    readBytes: async () => new Uint8Array(0),
    exists: async (p) => paths.some((f) => f === p || f.startsWith(p + "/")),
    readDir: async (dir) => {
      const prefix = dir.endsWith("/") ? dir : dir + "/";
      const names = new Map<string, FsDirEntry>();
      for (const f of paths) {
        if (!f.startsWith(prefix)) continue;
        const rest = f.slice(prefix.length);
        const slash = rest.indexOf("/");
        if (slash === -1) {
          names.set(rest, { name: rest, isDirectory: false, isFile: true });
        } else {
          const dirName = rest.slice(0, slash);
          if (!names.has(dirName)) names.set(dirName, { name: dirName, isDirectory: true, isFile: false });
        }
      }
      return Array.from(names.values());
    },
    writeTextFile: async () => {},
    mkdirp: async () => {},
  };
}

function makeNodeFsAdapter(): FsAdapter {
  return {
    readTextFile: async (p) => fs.promises.readFile(p, "utf8"),
    readBytes: async (p) => new Uint8Array(await fs.promises.readFile(p)),
    readDir: async (p) => (await fs.promises.readdir(p, { withFileTypes: true })).map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
      isFile: entry.isFile(),
    })),
    exists: async (p) => fs.existsSync(p),
    writeTextFile: async (p, content) => { await fs.promises.writeFile(p, content); },
    mkdirp: async (p) => { await fs.promises.mkdir(p, { recursive: true }); },
  };
}

function auditText(): string {
  return auditCreate.mock.calls.map(([row]) => JSON.stringify(row)).join("\n");
}

beforeEach(() => {
  auditCreate.mockClear();
  setDefaultRealpathFn((p) => p);
  setFsAdapter(makeFakeFs({
    "/ws/src/auth.ts": "line1\nline2 TODO fix\nline3",
    "/ws/src/utils/helper.ts": "export const x = 1;\n// TODO refactor",
    "/ws/README.md": "# Project\nsome docs",
    "/ws/node_modules/pkg/index.js": "TODO should be ignored",
  }));
});

afterEach(() => {
  setDefaultRealpathFn(previousRealpath);
});

describe("read 工具", () => {
  it("读文件返回带 hashline（行号#hash|内容）的内容", async () => {
    const r = await executeTool(readTool, { file_path: "src/auth.ts" }, ctx);
    expect(r.status).toBe("success");
    expect(r.output).toContain(formatHashLine(1, "line1"));
    expect(r.output).toContain("3 行");
  });

  it("offset/limit 截取", async () => {
    const r = await executeTool(readTool, { file_path: "src/auth.ts", offset: 2, limit: 1 }, ctx);
    expect(r.output).toContain(formatHashLine(2, "line2 TODO fix"));
    expect(r.output).not.toContain("line1");
  });

  it("越界路径拒绝", async () => {
    const r = await executeTool(readTool, { file_path: "../../etc/passwd" }, ctx);
    expect(r.status).toBe("denied");
  });

  it("敏感路径拒绝", async () => {
    const r = await executeTool(readTool, { file_path: ".env" }, ctx);
    expect(r.status).toBe("denied");
  });

  it("不存在的文件 → error", async () => {
    const r = await executeTool(readTool, { file_path: "src/nope.ts" }, ctx);
    expect(r.status).toBe("error");
  });
});

describe("globToRegExp", () => {
  it("** 跨目录匹配", () => {
    expect(globToRegExp("src/**/*.ts").test("src/a/b/c.ts")).toBe(true);
    expect(globToRegExp("src/**/*.ts").test("src/a.ts")).toBe(true);
  });
  it("* 不跨目录", () => {
    expect(globToRegExp("src/*.ts").test("src/a/b.ts")).toBe(false);
    expect(globToRegExp("src/*.ts").test("src/a.ts")).toBe(true);
  });
});

describe("glob 工具", () => {
  it("canonical workspace 前缀变化时，子目录搜索仍输出相对搜索根并读取 canonical 文件", async () => {
    const canonicalMap: Record<string, string> = {
      "/var/ws": "/private/var/ws",
      "/var/ws/src": "/private/var/ws/src",
      "/var/ws/src/ok.ts": "/private/var/ws/src/ok.ts",
      "/var/ws/.gitignore": "/private/var/ws/.gitignore",
    };
    setDefaultRealpathFn((p) => canonicalMap[p] ?? (p.startsWith("/private/var/ws") ? p : (() => { throw new Error(`missing resolver: ${p}`); })()));
    setFsAdapter(makeFakeFs({
      "/private/var/ws/src/ok.ts": "CANONICAL_OK_SENTINEL",
    }));
    const subdirCtx: ToolContext = { workspacePath: "/var/ws" };
    const r = await executeTool(globTool, { pattern: "**/*.ts", path: "src" }, subdirCtx);
    expect(r.output).toContain("ok.ts");
    expect(r.output).not.toContain("src/ok.ts");
  });

  it("匹配 ts 文件，忽略 node_modules", async () => {
    const r = await executeTool(globTool, { pattern: "**/*.ts" }, ctx);
    expect(r.output).toContain("src/auth.ts");
    expect(r.output).toContain("src/utils/helper.ts");
    expect(r.output).not.toContain("node_modules");
  });

  it("无匹配返回提示", async () => {
    const r = await executeTool(globTool, { pattern: "**/*.py" }, ctx);
    expect(r.output).toMatch(/没有匹配/);
  });

  it("尊重 .gitignore：排除的目录不被搜到（修复一头扎进 技术参考/ 的 bug）", async () => {
    setFsAdapter(makeFakeFs({
      "/ws/.gitignore": "/技术参考/\n/项目文档/\nbuild/",
      "/ws/app/src/db.ts": "export const db = 1;",
      "/ws/技术参考/opencode/huge.ts": "noise",
      "/ws/项目文档/plan.ts": "noise",
      "/ws/build/out.ts": "noise",
    }));
    const r = await executeTool(globTool, { pattern: "**/*.ts" }, ctx);
    expect(r.output).toContain("app/src/db.ts"); // 真源码搜得到
    expect(r.output).not.toContain("技术参考"); // gitignore 排除目录不下钻
    expect(r.output).not.toContain("项目文档");
    expect(r.output).not.toContain("build/out.ts");
  });

  it.each([
    ["workspace 外普通目标", "/external/plain.gitignore"],
    ["workspace 内敏感 canonical 目标", "/ws/.env"],
  ])("resolver 将字面 .gitignore 映射到 %s 时不读取候选且仍搜索普通文件", async (_label, canonicalGitignore) => {
    const reads: string[] = [];
    const base = makeFakeFs({
      "/ws/.gitignore": "src/ignored/",
      "/ws/src/ok.ts": "GITIGNORE_SAFE_SENTINEL",
    });
    setDefaultRealpathFn((p) => p === "/ws/.gitignore" ? canonicalGitignore : p);
    setFsAdapter({ ...base, readTextFile: async (p) => { reads.push(p); return base.readTextFile(p); } });
    const result = await executeTool(grepTool, { pattern: "GITIGNORE_SAFE_SENTINEL" }, ctx);
    expect(result.output).toContain("src/ok.ts");
    expect(reads).not.toContain("/ws/.gitignore");
    expect(reads).not.toContain(canonicalGitignore);
  });

  it.each([
    ["grep", grepTool],
    ["glob", globTool],
  ] as const)("%s 在 resolver 缺失、搜索根失败、workspace canonical 失败时均返回 generic error 且不泄露", async (_name, tool) => {
    const cases: Array<{ label: string; input: Record<string, string>; resolver: ((p: string) => string) | undefined }> = [
      { label: "resolver missing", input: { pattern: "SYMBOL" }, resolver: undefined },
      { label: "target reject", input: { pattern: "SYMBOL", path: "src" }, resolver: (p) => { if (p === "/ws/src") throw new Error("target-secret"); return p; } },
      { label: "workspace reject", input: { pattern: "SYMBOL", path: "src" }, resolver: (p) => { if (p === "/ws") throw new Error("workspace-secret"); return p; } },
    ];
    for (const testCase of cases) {
      auditCreate.mockClear();
      setDefaultRealpathFn(testCase.resolver);
      const result = await executeTool(tool, testCase.input, ctx);
      expect(result.status, testCase.label).toBe("error");
      expect(result.output, testCase.label).toBe("遍历失败：搜索根目录无法完成安全校验");
      expect(JSON.stringify(result), testCase.label).not.toContain("/ws");
      expect(JSON.stringify(result), testCase.label).not.toContain("secret");
      expect(auditText(), testCase.label).not.toContain("/ws");
      expect(auditText(), testCase.label).not.toContain("secret");
      expect(JSON.stringify(result.artifacts ?? []), testCase.label).not.toMatch(/\/ws|secret/);
    }
  });
});

describe("grep 工具", () => {
  it("安全名称 symlink 只读 canonical 内部目标；外部/敏感不读不下钻，非法 basename fail closed", async () => {
    const resolverCalls: string[] = [];
    const dirCalls: string[] = [];
    const entries: FsDirEntry[] = [
      { name: "safe-link", isFile: true, isDirectory: false },
      { name: "outside-link", isFile: false, isDirectory: true },
      { name: ".env", isFile: true, isDirectory: false },
      { name: ".ssh", isFile: false, isDirectory: true },
      { name: "", isFile: true, isDirectory: false },
      { name: ".", isFile: true, isDirectory: false },
      { name: "..", isFile: true, isDirectory: false },
      { name: "bad/name", isFile: true, isDirectory: false },
      { name: "bad\\name", isFile: true, isDirectory: false },
    ];
    setDefaultRealpathFn((p) => {
      resolverCalls.push(p);
      if (p === "/ws/safe-link") return "/ws/inside.txt";
      if (p === "/ws/outside-link") return "/external/ordinary";
      if (p === "/ws/.env") return "/ws/inside.txt";
      return p;
    });
    const adapter = makeFakeFs({ "/ws/inside.txt": "INTERNAL_CANONICAL" });
    setFsAdapter({ ...adapter, readDir: async (p) => { dirCalls.push(p); return p === "/ws" ? entries : []; } });
    const walked = await walkSafeFiles("/ws", "/ws");
    expect(walked).toEqual([{ relativePath: "safe-link", resolvedPath: "/ws/inside.txt" }]);
    expect(dirCalls).toEqual(["/ws"]);
    expect(resolverCalls).not.toContain("/ws/");
    expect(resolverCalls).not.toContain("/ws/bad/name");
    expect(resolverCalls).not.toContain("/ws/bad\\name");
  });

  it("walker 保留显式 maxFiles 上限", async () => {
    const files = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`/ws/${i}.txt`, String(i)]));
    setFsAdapter(makeFakeFs(files));
    const walked = await walkSafeFiles("/ws", "/ws", 2);
    expect(walked).toHaveLength(2);
  });

  it("子项文件与目录 resolver 失败时静默跳过，普通同级项仍保留", async () => {
    const resolverCalls: string[] = [];
    const files = {
      "/ws/ok.txt": "OK",
      "/ws/failed-file.txt": "NO",
      "/ws/ok-dir/child.txt": "CHILD",
      "/ws/failed-dir/hidden.txt": "NO",
    };
    const base = makeFakeFs(files);
    setDefaultRealpathFn((p) => {
      resolverCalls.push(p);
      if (p === "/ws/failed-file.txt" || p === "/ws/failed-dir") throw new Error("reject");
      return p;
    });
    setFsAdapter(base);
    const walked = await walkSafeFiles("/ws", "/ws");
    expect(walked.map((entry) => entry.relativePath)).toEqual(["ok.txt", "ok-dir/child.txt"]);
    expect(resolverCalls).toContain("/ws/failed-file.txt");
    expect(resolverCalls).toContain("/ws/failed-dir");
    expect(resolverCalls).not.toContain("/ws/failed-dir/hidden.txt");
  });

  it("根 strict 校验失败时 executeTool 返回固定 generic error 且审计不泄露路径，子项失败静默保留普通项", async () => {
    setDefaultRealpathFn((p) => {
      if (p === "/ws") throw new Error("workspace reject");
      return p;
    });
    const rootFailure = await executeTool(globTool, { pattern: "**/*" }, ctx);
    expect(rootFailure.status).toBe("error");
    expect(rootFailure.output).toBe("遍历失败：搜索根目录无法完成安全校验");
    const row = auditCreate.mock.calls.at(-1)?.[0] as { output: string; resultJson: string };
    expect(row.output).not.toContain("/ws");
    expect(row.resultJson).not.toContain("/ws");
  });

  it("grep 与 glob 完整敏感矩阵：敏感文件零读、敏感目录零下钻、审计与 artifacts 无泄露", async () => {
    const files: Record<string, string> = {
      "/ws/src/ok.ts": "MATRIX_VISIBLE",
      "/ws/.env": "MATRIX_ENV",
      "/ws/.ENV": "MATRIX_ENV_UPPER",
      "/ws/secret.env": "MATRIX_SECRET",
      "/ws/secrets.env": "MATRIX_SECRETS",
      "/ws/keystore.json": "MATRIX_KEYSTORE",
      "/ws/id_rsa": "MATRIX_RSA",
      "/ws/id_rsa.pub": "MATRIX_RSA_PUB",
      "/ws/id_rsa_backup/key": "MATRIX_RSA_BACKUP",
      "/ws/.ssh/id_rsa": "MATRIX_SSH",
      "/ws/.aws/credentials": "MATRIX_AWS",
      "/ws/.gnupg/private.key": "MATRIX_GNUPG",
    };
    const reads: string[] = [];
    const dirs: string[] = [];
    const base = makeFakeFs(files);
    setFsAdapter({
      ...base,
      readTextFile: async (p) => { reads.push(p); return base.readTextFile(p); },
      readDir: async (p) => { dirs.push(p); return base.readDir(p); },
    });
    const grep = await executeTool(grepTool, { pattern: "MATRIX_" }, ctx);
    const glob = await executeTool(globTool, { pattern: "**/*" }, ctx);
    const auditRows = auditCreate.mock.calls.map(([row]) => row as { output: string; resultJson: string });
    expect(grep.output).toContain("src/ok.ts");
    expect(glob.output).toContain("src/ok.ts");
    for (const secret of Object.keys(files).filter((p) => !p.endsWith("ok.ts"))) {
      expect(reads).not.toContain(secret);
    }
    expect(dirs).not.toContain("/ws/.ssh");
    expect(dirs).not.toContain("/ws/.aws");
    expect(dirs).not.toContain("/ws/.gnupg");
    for (const row of auditRows) {
      expect(row.output).not.toMatch(/MATRIX_(ENV|SECRET|SECRETS|KEYSTORE|RSA|SSH|AWS|GNUPG)/);
      expect(row.resultJson).not.toMatch(/MATRIX_(ENV|SECRET|SECRETS|KEYSTORE|RSA|SSH|AWS|GNUPG)/);
    }
    expect(glob.artifacts?.map((artifact) => `${artifact.uri} ${artifact.label}`).join(" ")).not.toMatch(/\.env|secret|keystore|id_rsa|\.ssh|\.aws|\.gnupg/i);
  });

  it("逐子文件校验并跳过敏感 descendants，且不读取其内容", async () => {
    const reads: string[] = [];
    const files: Record<string, string> = {
      "/ws/src/ok.ts": "VISIBLE_SENTINEL",
      "/ws/.env": "ENV_SENTINEL",
      "/ws/secret.env": "SECRET_SENTINEL",
      "/ws/id_rsa_backup/key": "RSA_SENTINEL",
      "/ws/.ssh/id_rsa": "SSH_SENTINEL",
    };
    const base = makeFakeFs(files);
    setFsAdapter({ ...base, readTextFile: async (p) => { reads.push(p); return base.readTextFile(p); } });
    const r = await executeTool(grepTool, { pattern: "SENTINEL" }, ctx);
    expect(r.output).toContain("src/ok.ts");
    expect(r.output).not.toContain("ENV_SENTINEL");
    expect(r.output).not.toContain("SSH_SENTINEL");
    expect(reads).toEqual(["/ws/.gitignore", "/ws/src/ok.ts"]);
  });

  it("独立 id_rsa_backup 文件与其目录后代均零读、零输出、零 artifact、零 audit", async () => {
    const reads: string[] = [];
    const base = makeFakeFs({
      "/ws/src/ok.ts": "RSA_MATRIX_VISIBLE",
      "/ws/id_rsa_backup": "RSA_BACKUP_FILE_SECRET",
      "/ws/id_rsa_backup/key": "RSA_BACKUP_CHILD_SECRET",
    });
    setFsAdapter({ ...base, readTextFile: async (p) => { reads.push(p); return base.readTextFile(p); } });
    const grep = await executeTool(grepTool, { pattern: "RSA_" }, ctx);
    const glob = await executeTool(globTool, { pattern: "**/*" }, ctx);
    expect(grep.output).toContain("src/ok.ts");
    expect(grep.output).not.toMatch(/RSA_BACKUP/);
    expect(glob.output).toContain("src/ok.ts");
    expect(glob.output).not.toMatch(/id_rsa_backup/);
    expect(glob.artifacts?.some((a) => /id_rsa_backup/i.test(`${a.uri} ${a.label}`))).toBe(false);
    expect(reads).not.toContain("/ws/id_rsa_backup");
    expect(reads).not.toContain("/ws/id_rsa_backup/key");
    expect(auditText()).not.toMatch(/RSA_BACKUP|id_rsa_backup/);
  });

  it("安全名称 file/dir symlink 指向 canonical 敏感目标时 grep/glob 均零读零下钻且保留普通同级", async () => {
    const reads: string[] = [];
    const dirs: string[] = [];
    const base = makeFakeFs({ "/ws/ordinary.ts": "SYMLINK_MATRIX_VISIBLE" });
    setDefaultRealpathFn((p) => {
      if (p === "/ws/safe-file-link") return "/ws/.ssh/id_rsa";
      if (p === "/ws/safe-dir-link") return "/ws/.aws";
      return p;
    });
    setFsAdapter({
      ...base,
      readTextFile: async (p) => { reads.push(p); return base.readTextFile(p); },
      readDir: async (p) => {
        dirs.push(p);
        if (p === "/ws") return [
          { name: "safe-file-link", isFile: true, isDirectory: false },
          { name: "safe-dir-link", isFile: false, isDirectory: true },
          { name: "ordinary.ts", isFile: true, isDirectory: false },
        ];
        return [];
      },
    });
    const grep = await executeTool(grepTool, { pattern: "SYMLINK_MATRIX" }, ctx);
    const glob = await executeTool(globTool, { pattern: "**/*" }, ctx);
    expect(grep.output).toContain("ordinary.ts");
    expect(grep.output).not.toMatch(/safe-(file|dir)-link|id_rsa|\.aws/);
    expect(glob.output).toContain("ordinary.ts");
    expect(glob.output).not.toMatch(/safe-(file|dir)-link|id_rsa|\.aws/);
    expect(glob.artifacts?.some((a) => /safe-|id_rsa|\.aws/.test(`${a.uri} ${a.label}`))).toBe(false);
    expect(reads).not.toContain("/ws/.ssh/id_rsa");
    expect(dirs).not.toContain("/ws/.aws");
    expect(auditText()).not.toMatch(/safe-(file|dir)-link|id_rsa|\.aws/);
  });

  it("真实 Node Dirent symlink 呈 false/false 时 walker 不跟随且保留普通真实文件", async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "cosmgrid-node-symlink-"));
    const workspace = path.join(temp, "workspace");
    const outside = path.join(temp, "outside");
    try {
      fs.mkdirSync(workspace);
      fs.mkdirSync(outside);
      fs.writeFileSync(path.join(workspace, "ordinary.txt"), "NODE_SYMLINK_VISIBLE");
      fs.writeFileSync(path.join(outside, "secret.txt"), "NODE_SYMLINK_SECRET");
      fs.symlinkSync(path.join(outside, "secret.txt"), path.join(workspace, "safe-link"));
      setFsAdapter(makeNodeFsAdapter());
      setDefaultRealpathFn((p) => fs.realpathSync(p));
      const entries = await makeNodeFsAdapter().readDir(workspace);
      const link = entries.find((entry) => entry.name === "safe-link");
      expect(link).toMatchObject({ isFile: false, isDirectory: false });
      const result = await executeTool(grepTool, { pattern: "NODE_SYMLINK" }, { workspacePath: workspace });
      expect(result.output).toContain("ordinary.txt");
      expect(result.output).not.toContain("NODE_SYMLINK_SECRET");
      expect(result.output).not.toContain("safe-link");
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });

  it("搜 TODO，跳过 node_modules", async () => {
    const r = await executeTool(grepTool, { pattern: "TODO" }, ctx);
    expect(r.output).toContain("src/auth.ts:2");
    expect(r.output).toContain("src/utils/helper.ts:2");
    expect(r.output).not.toContain("node_modules");
  });

  it("include 限定文件类型", async () => {
    const r = await executeTool(grepTool, { pattern: "TODO", include: "*.ts" }, ctx);
    expect(r.output).toContain("auth.ts");
  });

  it("非法正则 → error", async () => {
    const r = await executeTool(grepTool, { pattern: "[invalid(" }, ctx);
    expect(r.status).toBe("error");
  });

  it("无匹配返回提示", async () => {
    const r = await executeTool(grepTool, { pattern: "NONEXISTENT_XYZ" }, ctx);
    expect(r.output).toMatch(/没有匹配/);
  });
});
