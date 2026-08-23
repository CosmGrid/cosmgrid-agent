import { describe, it, expect } from "vitest";
import {
  verifyFileClaims,
  verifyUrlClaims,
  verifyCommandClaims,
  unverifiedClaims,
  type ReadRecord,
  type FetchRecord,
  type ExecRecord,
} from "../verify-claims";

const readRec = (file_path: string, status = "success"): ReadRecord => ({
  input: JSON.stringify({ file_path }),
  status,
});

const fetchRec = (url: string, status = "success"): FetchRecord => ({
  input: JSON.stringify({ url }),
  status,
});

const bashRec = (command: string, status = "success"): ExecRecord => ({
  input: JSON.stringify({ command }),
  status,
});

const grepRec = (pattern: string, status = "success"): ExecRecord => ({
  input: JSON.stringify({ pattern }),
  status,
});

const searchRec = (query: string, status = "success"): ExecRecord => ({
  input: JSON.stringify({ query }),
  status,
});

describe("verifyFileClaims", () => {
  it("声称的路径在 read 记录里 → verified", () => {
    const out = verifyFileClaims(["/tmp/test.txt"], [readRec("/tmp/test.txt")]);
    expect(out[0]?.verified).toBe(true);
  });

  it("声称的路径不在 read 记录里 → 未验证（编的）", () => {
    const out = verifyFileClaims(["/tmp/fake.txt"], [readRec("/tmp/real.txt")]);
    expect(out[0]?.verified).toBe(false);
    expect(out[0]?.reason).toContain("编造");
  });

  it("相对路径 vs 绝对路径能匹配（模型说 app/db.ts，实际读了 /workspace/app/db.ts）", () => {
    const out = verifyFileClaims(["app/src/db.ts"], [readRec("/workspace/app/src/db.ts")]);
    expect(out[0]?.verified).toBe(true);
  });

  it("basename 相同且带扩展名能匹配", () => {
    const out = verifyFileClaims(["pkg.json"], [readRec("/abs/pkg.json")]);
    expect(out[0]?.verified).toBe(true);
  });

  it("denied/error 状态的 read 不算读过（没真拿到内容）", () => {
    const out = verifyFileClaims(["/tmp/x.txt"], [readRec("/tmp/x.txt", "denied")]);
    expect(out[0]?.verified).toBe(false);
  });

  it("空 read 记录 → 全部未验证", () => {
    const out = verifyFileClaims(["/a.txt", "/b.ts"], []);
    expect(out.every((c) => !c.verified)).toBe(true);
  });
});

describe("verifyUrlClaims（web_fetch 版——覆盖之前 read-only 校验漏掉的网页 claim）", () => {
  it("任意 web_fetch URL 记录均 fail closed → 未验证", () => {
    const out = verifyUrlClaims(["https://example.com/a"], [fetchRec("https://example.com/a")]);
    expect(out[0]?.verified).toBe(false);
  });

  it("声称的 URL 没有对应 web_fetch 记录 → 未验证（编的）", () => {
    const out = verifyUrlClaims(["https://example.com/fake"], [fetchRec("https://example.com/real")]);
    expect(out[0]?.verified).toBe(false);
    expect(out[0]?.reason).toContain("编造");
  });

  it("协议头大小写、末尾斜杠差异也不能绕过隔离", () => {
    const out = verifyUrlClaims(["https://example.com/a/"], [fetchRec("HTTPS://example.com/a")]);
    expect(out[0]?.verified).toBe(false);
  });

  it("web_fetch 记录状态非 success（超时/失败）→ 不算真读到", () => {
    const out = verifyUrlClaims(["https://example.com/a"], [fetchRec("https://example.com/a", "error")]);
    expect(out[0]?.verified).toBe(false);
  });

  it("空 fetch 记录 → 全部未验证", () => {
    const out = verifyUrlClaims(["https://a.com", "https://b.com"], []);
    expect(out.every((c) => !c.verified)).toBe(true);
  });
});

describe("verifyCommandClaims（bash/grep/web_search 并集版——覆盖之前完全没接的三个工具）", () => {
  it("声称的命令在 bash 成功记录里 → verified", () => {
    const out = verifyCommandClaims(["pnpm test"], [bashRec("pnpm test")]);
    expect(out[0]?.verified).toBe(true);
  });

  it("声称的 pattern 在 grep 成功记录里 → verified", () => {
    const out = verifyCommandClaims(["foo"], [grepRec("foo")]);
    expect(out[0]?.verified).toBe(true);
  });

  it("声称的查询词在 web_search 成功记录里 → verified", () => {
    const out = verifyCommandClaims(["bar"], [searchRec("bar")]);
    expect(out[0]?.verified).toBe(true);
  });

  it("声称的内容跟任何工具记录都对不上 → 未验证（编的）", () => {
    const out = verifyCommandClaims(["pnpm test"], [bashRec("ls -la")]);
    expect(out[0]?.verified).toBe(false);
    expect(out[0]?.reason).toContain("编造");
  });

  it("宽松匹配：模型转述时带了额外参数，互相包含就算对上", () => {
    const out = verifyCommandClaims(["pnpm test"], [bashRec("pnpm test -- --run")]);
    expect(out[0]?.verified).toBe(true);
  });

  it("非 success 状态（超时/失败/拒绝）→ 不算真跑过", () => {
    const out = verifyCommandClaims(["pnpm test"], [bashRec("pnpm test", "denied")]);
    expect(out[0]?.verified).toBe(false);
  });

  it("空记录 → 全部未验证", () => {
    const out = verifyCommandClaims(["a", "b"], []);
    expect(out.every((c) => !c.verified)).toBe(true);
  });
});

describe("unverifiedClaims", () => {
  it("只返回未验证的", () => {
    const claims = verifyFileClaims(
      ["/ok.txt", "/fake.txt", "/ok2.ts"],
      [readRec("/ok.txt"), readRec("/ok2.ts")],
    );
    const uv = unverifiedClaims(claims);
    expect(uv).toHaveLength(1);
    expect(uv[0]?.claimed).toBe("/fake.txt");
  });
});
