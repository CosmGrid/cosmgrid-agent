import { describe, expect, it } from "vitest";
import type { McpServerRow } from "@/lib/db/mcp";
import { buildLocalMcpSessionScope, formatLocalMcpLaunch } from "../session-scope";

function server(overrides: Partial<McpServerRow> = {}): McpServerRow {
  return {
    id: "server-1",
    name: "test",
    transport: "local_stdio",
    url: null,
    command: "node",
    args: ["server.js"],
    env: {},
    headers: {},
    secretCredentialId: null,
    enabled: true,
    createdAt: "2026-07-09T00:00:00.000Z",
    updatedAt: "2026-07-09T00:00:00.000Z",
    ...overrides,
  };
}

describe("buildLocalMcpSessionScope", () => {
  it("isolates the same server across workspaces", () => {
    const a = buildLocalMcpSessionScope(server(), "/workspace-a");
    const b = buildLocalMcpSessionScope(server(), "/workspace-b");
    expect(a.key).not.toBe(b.key);
    expect(a.sessionId).not.toBe(b.sessionId);
  });

  it("invalidates the scope when executable configuration changes", () => {
    const before = buildLocalMcpSessionScope(server(), "/workspace-a");
    const after = buildLocalMcpSessionScope(server({ args: ["other.js"] }), "/workspace-a");
    expect(before.configFingerprint).not.toBe(after.configFingerprint);
    expect(before.key).not.toBe(after.key);
  });

  it("does not include secret environment values in identifiers", () => {
    const scope = buildLocalMcpSessionScope(server({ env: { TOKEN: "top-secret" } }), "/workspace-a");
    expect(scope.key).not.toContain("top-secret");
    expect(scope.sessionId).not.toContain("top-secret");
    expect(scope.configFingerprint).not.toContain("top-secret");
  });

  it("formats launch details without exposing environment values", () => {
    const output = formatLocalMcpLaunch(
      server({ env: { TOKEN: "top-secret", API_KEY: "another-secret" } }),
      "/workspace-a",
    );
    expect(output).toContain("node server.js");
    expect(output).toContain("/workspace-a");
    expect(output).toContain("API_KEY, TOKEN");
    expect(output).not.toContain("top-secret");
    expect(output).not.toContain("another-secret");
    expect(formatLocalMcpLaunch(server())).toContain("无工作区");
  });
});
