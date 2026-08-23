// path-safety 单测（v0.7 阶段4：路径边界 + 敏感路径，安全关键）
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  normalizePath,
  resolveInWorkspace,
  isSensitivePath,
  checkPath,
  checkWritePath,
  setDefaultRealpathFn,
  getDefaultRealpathFn,
} from "../path-safety";

const WS = "/Users/me/projects/foo";

describe("normalizePath", () => {
  it("折叠 . 和 ..", () => {
    expect(normalizePath("/a/b/../c")).toBe("/a/c");
    expect(normalizePath("/a/./b")).toBe("/a/b");
  });
  it("绝对路径越根的 .. 被吞", () => {
    expect(normalizePath("/a/../../b")).toBe("/b");
  });
  it("多斜杠归一", () => {
    expect(normalizePath("/a//b///c")).toBe("/a/b/c");
  });
});

describe("resolveInWorkspace", () => {
  it("相对路径接在 workspace 后", () => {
    expect(resolveInWorkspace(WS, "src/auth.ts")).toBe(`${WS}/src/auth.ts`);
  });
  it("绝对路径原样规范化", () => {
    expect(resolveInWorkspace(WS, "/etc/passwd")).toBe("/etc/passwd");
  });
});

describe("checkPath — 边界", () => {
  it("strict 模式拒绝缺少 resolver、目标或 workspace canonical 的路径", async () => {
    expect((await checkPath(WS, "src/auth.ts", { requireRealpath: true })).ok).toBe(false);
    expect((await checkPath(WS, "src/auth.ts", {
      requireRealpath: true,
      realpathFn: () => { throw new Error("target reject"); },
    })).ok).toBe(false);
    expect((await checkPath(WS, "src/auth.ts", {
      requireRealpath: true,
      realpathFn: (p) => p === WS ? (() => { throw new Error("workspace reject"); })() : p,
    })).ok).toBe(false);
  });

  it("strict 模式先拒绝字面敏感路径，不调用 resolver", async () => {
    let resolverCalls = 0;
    const r = await checkPath(WS, ".env", {
      requireRealpath: true,
      realpathFn: (p) => { resolverCalls++; return p; },
    });
    expect(r.ok).toBe(false);
    expect(resolverCalls).toBe(0);
  });

  it("边界与敏感比较兼容反斜杠、Windows drive 与 extended path，且保留 resolver 原始 resolved", async () => {
    const workspace = "C:\\Work\\Project";
    const canonical = "\\\\?\\C:\\Work\\Project\\src\\ok.ts";
    const r = await checkPath(workspace, "src\\ok.ts", {
      requireRealpath: true,
      realpathFn: (p) => p === "C:/Work/Project/src/ok.ts"
        ? canonical
        : "C:/Work/Project",
    });
    expect(r.ok).toBe(true);
    expect(r.resolved).toBe(canonical);
    expect((await checkPath(workspace, "C:\\Work\\Project\\.env", {
      requireRealpath: true,
      realpathFn: (p) => p,
    })).ok).toBe(false);
  });

  it("UNC 与 extended UNC 目标支持内部边界并拒绝同前缀 sibling", async () => {
    const workspace = "\\\\server\\share\\project";
    const resolver = (p: string) => p === "//server/share/project"
      ? "\\\\?\\UNC\\server\\share\\project"
      : p === "//server/share/project/src/ok.ts"
        ? "\\\\?\\UNC\\server\\share\\project\\src\\ok.ts"
        : p;
    expect((await checkPath(workspace, "src/ok.ts", { requireRealpath: true, realpathFn: resolver })).ok).toBe(true);
    expect((await checkPath(workspace, "//server/share/project-other/x.ts", { requireRealpath: true, realpathFn: resolver })).ok).toBe(false);
  });

  it("strict canonical 敏感目标即使名称安全也拒绝", async () => {
    const r = await checkPath(WS, "safe-link", {
      requireRealpath: true,
      realpathFn: (p) => p === WS ? p : `${WS}/.ssh/id_rsa_backup`,
    });
    expect(r.ok).toBe(false);
  });

  it("工作区内允许", async () => {
    expect((await checkPath(WS, "src/auth.ts")).ok).toBe(true);
  });
  it("workspace 根本身允许", async () => {
    expect((await checkPath(WS, ".")).ok).toBe(true);
  });
  it("路径遍历越界拒绝", async () => {
    const r = await checkPath(WS, "../../etc/passwd");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/越出/);
  });
  it("绝对路径越界拒绝", async () => {
    expect((await checkPath(WS, "/etc/passwd")).ok).toBe(false);
  });
  it("前缀相同但不在子目录下的兄弟目录拒绝", async () => {
    // /Users/me/projects/foobar 不应被当成 /Users/me/projects/foo 的子路径
    expect((await checkPath(WS, "/Users/me/projects/foobar/x")).ok).toBe(false);
  });
});

describe("isSensitivePath / checkPath — 敏感路径", () => {
  it.each([
    "src/.env",
    ".env.local",
    "config/secrets.json",
    "deploy/secret.yaml",
    ".ssh/id_rsa",
    "keystore.json",
  ])("拒绝敏感：%s", async (p) => {
    expect((await checkPath(WS, p)).ok).toBe(false);
  });

  it("普通源码文件不敏感", async () => {
    expect(isSensitivePath(`${WS}/src/index.ts`)).toBe(false);
    expect((await checkPath(WS, "src/index.ts")).ok).toBe(true);
  });

  // 2026-07-15 review 修复：原来除了 secrets? 那条，其余五条正则大小写敏感。macOS 默认
  // APFS 大小写不敏感（但保留大小写），".ENV"/".Ssh" 这类大小写变体在文件系统层面解析到
  // 同一份文件，但正则匹配不上会绕过黑名单读到真正的敏感文件。
  it.each([
    "src/.ENV",
    ".Env.local",
    ".SSH/id_rsa",
    ".Ssh/config",
    ".AWS/credentials",
    ".GnuPG/secring.gpg",
    "KEYSTORE.JSON",
    "ID_RSA.pub",
    "id_rsa_backup",
    "id_rsa_backup/key",
  ])("大小写变体也应该被拒绝（此前会绕过黑名单）：%s", async (p) => {
    expect((await checkPath(WS, p)).ok).toBe(false);
  });
});

describe("checkWritePath — 写类工具专用，工作区外放行但标记 external", () => {
  it("工作区内 → 放行，external=false", async () => {
    const r = await checkWritePath(WS, "src/auth.ts");
    expect(r.ok).toBe(true);
    expect(r.external).toBe(false);
  });

  it("workspace 根本身 → 放行，external=false", async () => {
    expect((await checkWritePath(WS, ".")).external).toBe(false);
  });

  it("工作区外的绝对路径（如桌面）→ 放行，external=true（不再像 checkPath 那样硬拒绝）", async () => {
    const r = await checkWritePath(WS, "/Users/me/Desktop/plan.md");
    expect(r.ok).toBe(true);
    expect(r.external).toBe(true);
    expect(r.resolved).toBe("/Users/me/Desktop/plan.md");
  });

  it("路径遍历到工作区外 → 放行，external=true", async () => {
    const r = await checkWritePath(WS, "../../etc/motd");
    expect(r.ok).toBe(true);
    expect(r.external).toBe(true);
  });

  it("前缀相同但不在子目录下的兄弟目录 → 放行，external=true", async () => {
    const r = await checkWritePath(WS, "/Users/me/projects/foobar/x");
    expect(r.ok).toBe(true);
    expect(r.external).toBe(true);
  });

  it("敏感路径 → 不管在不在工作区内，一律拒绝（这条不因为 external 而放松）", async () => {
    expect((await checkWritePath(WS, ".env")).ok).toBe(false);
    expect((await checkWritePath("/Users/me/Desktop", ".ssh/id_rsa")).ok).toBe(false);
  });
});

// ============ 2.2 修复：符号链接解析（realpath 注入）============

describe("path-safety — 符号链接逃逸防护（2.2 修复）", () => {
  let tmpDir: string;
  let workspaceDir: string;
  let sensitiveDir: string;
  let previousDefaultRealpath: ReturnType<typeof getDefaultRealpathFn>;

  beforeAll(() => {
    // 创建测试目录结构：
    //   tmpDir/
    //     project/                ← workspace
        //       link-to-ssh -> ../ssh/
    //       link-internal -> ./real-file.txt
    //       real-file.txt
    //       internal-dir/
    //     ssh/                     ← 模拟 ~/.ssh（敏感）
    //       id_rsa
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "path-safety-symlink-test-"));
    workspaceDir = path.join(tmpDir, "project");
    sensitiveDir = path.join(tmpDir, "ssh");
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(sensitiveDir, { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, "real-file.txt"), "content");
    fs.writeFileSync(path.join(sensitiveDir, "id_rsa"), "fake-key");
    fs.mkdirSync(path.join(workspaceDir, "internal-dir"), { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, "internal-dir", "x.txt"), "x");
    // 创建符号链接：workspace 内 link 指向 workspace 外的 ssh/
    fs.symlinkSync(
      path.join(sensitiveDir, "id_rsa"),
      path.join(workspaceDir, "link-to-ssh"),
    );
    // 创建符号链接：workspace 内 link 指向 workspace 内
    fs.symlinkSync(
      path.join(workspaceDir, "real-file.txt"),
      path.join(workspaceDir, "link-internal"),
    );
    // 2026-07-15 review 修复：workspace 内目录符号链接指向 workspace 外（非敏感）目录——
    // 模拟"写一个还不存在的新文件"这个 write 工具最常见场景，目标文件本身从未创建过，
    // realpath 整段解析必然 ENOENT。
    const outsideDir = path.join(tmpDir, "outside-dir");
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.symlinkSync(outsideDir, path.join(workspaceDir, "link-to-outside-dir"));

    // 测试前先保存现有 default realpath（避免污染其他测试）
    previousDefaultRealpath = getDefaultRealpathFn();
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    setDefaultRealpathFn(previousDefaultRealpath);
  });

  it("不注入 realpathFn → 字符串检查仍生效（链接名 'link-to-ssh' 被认为在工作区内）", async () => {
    // 链接名 "link-to-ssh" 看起来在工作区内，字符串检查放行——这就是 2.2 描述的逃逸路径
    const r = await checkPath(workspaceDir, "link-to-ssh");
    expect(r.ok).toBe(true); // 字符串检查放行（这是逃逸漏洞）
  });

  it("checkPath 注入 realpathFn → 工作区内符号链接指向 workspace 外敏感路径 → 拒绝", async () => {
    const r = await checkPath(workspaceDir, "link-to-ssh", {
      realpathFn: (p) => fs.realpathSync(p),
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/越出/);
  });

  it("checkWritePath 注入 realpathFn → 同样拒绝（写类工具防护）", async () => {
    const r = await checkWritePath(workspaceDir, "link-to-ssh", {
      realpathFn: (p) => fs.realpathSync(p),
    });
    expect(r.ok).toBe(false);
  });

  it("工作区内符号链接指向工作区内 → 仍允许", async () => {
    const r = await checkPath(workspaceDir, "link-internal", {
      realpathFn: (p) => fs.realpathSync(p),
    });
    expect(r.ok).toBe(true);
    // macOS 上 /var → /private/var，resolved 用 realpath 形式
    const expectedResolved = fs.realpathSync(path.join(workspaceDir, "real-file.txt"));
    expect(r.resolved).toBe(expectedResolved);
  });

  it("不存在的路径 → realpath 抛错 → safeRealpath 落回原路径（让 fs 操作自然报错）", async () => {
    const r = await checkPath(workspaceDir, "this-file-does-not-exist.txt", {
      realpathFn: (p) => fs.realpathSync(p),
    });
    // 落回原路径后，原路径在工作区内 + 不敏感 → ok=true（让下游 fs 操作报 ENOENT）
    expect(r.ok).toBe(true);
  });

  // 2026-07-15 review 修复回归测试：write 工具建新文件（目标文件不存在，realpath 整段解析
  // 必然 ENOENT）时，如果父目录是指向工作区外的符号链接，旧实现会整段落回 raw 字符串比较，
  // 误判成"在工作区内"——实际 fs 层真实写入目标在工作区外。修复后应该退一步解析父目录，
  // 正确识别出这是工作区外的目录逃逸。
  it("checkPath：符号链接目录里的新建文件（目标不存在）→ 父目录解析应识别出工作区外", async () => {
    const r = await checkPath(workspaceDir, "link-to-outside-dir/new-file.txt", {
      realpathFn: (p) => fs.realpathSync(p),
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/越出/);
  });

  it("checkWritePath：符号链接目录里的新建文件（目标不存在）→ 应标记 external:true，不能被误判成工作区内", async () => {
    const r = await checkWritePath(workspaceDir, "link-to-outside-dir/new-file.txt", {
      realpathFn: (p) => fs.realpathSync(p),
    });
    expect(r.ok).toBe(true);
    // 核心断言：这是修复前的 bug 点——旧实现这里会错误地给出 external:false，
    // 用户完全不会被提醒"这次要写到工作区之外"。
    expect(r.external).toBe(true);
  });

  it("符号链接目录里已存在的文件（非新建场景，原本就能正确识别）仍然正确识别工作区外", async () => {
    fs.writeFileSync(path.join(tmpDir, "outside-dir", "existing.txt"), "x");
    const r = await checkWritePath(workspaceDir, "link-to-outside-dir/existing.txt", {
      realpathFn: (p) => fs.realpathSync(p),
    });
    expect(r.ok).toBe(true);
    expect(r.external).toBe(true);
  });

  it("realpathFn=null → 显式禁用 realpath（保持字符串检查语义）", async () => {
    // 用户如果想保持原有字符串检查行为，传 null 禁用
    const r = await checkPath(workspaceDir, "link-to-ssh", { realpathFn: null });
    expect(r.ok).toBe(true);
  });

  it("全局 setDefaultRealpathFn → 后续 checkPath 调用自动应用（应用启动时一次性注入）", async () => {
    setDefaultRealpathFn((p) => fs.realpathSync(p));
    expect(getDefaultRealpathFn()).toBeDefined();
    const r = await checkPath(workspaceDir, "link-to-ssh"); // 不传 options，用全局
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/越出/);
  });

  it("全局 realpathFn 是异步函数（模拟 Tauri invoke）→ checkPath 正确 await", async () => {
    // 2.2 修复补丁：生产环境的 realpathFn 走 Tauri invoke，是真正的 Promise，
    // 不是同步函数——这里模拟这个场景，确保 resolveBoth 正确 await 而不是把
    // Promise 对象当字符串用（那样 .startsWith 会直接抛错或产生错误的比较结果）。
    setDefaultRealpathFn(async (p) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return fs.realpathSync(p);
    });
    const r = await checkPath(workspaceDir, "link-to-ssh");
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/越出/);
  });
});
