import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  content: "const value: number = 'bad';",
  transports: [] as Array<{
    sent: Array<Record<string, unknown>>;
    emit: (message: unknown) => void;
    simulateTerminated: () => void;
    simulateError: () => void;
    disposeCount: number;
  }>,
}));

vi.mock("@/lib/llm/tools/fs-adapter", () => ({
  getFsAdapter: () => ({
    readTextFile: vi.fn(async () => state.content),
  }),
}));

vi.mock("../server-detection", () => ({
  detectLspServer: vi.fn(async () => ({
    languageId: "typescript",
    program: "typescript-language-server",
    args: ["--stdio"],
  })),
  languageIdForPath: vi.fn(() => "typescript"),
}));

vi.mock("@/lib/rpc/tauri-transport", () => ({
  TauriRpcTransport: class {
    sent: Array<Record<string, unknown>> = [];
    disposeCount = 0;
    private listener: ((message: unknown) => void) | null = null;
    private closeListeners: Array<() => void> = [];
    private errorListeners: Array<(error: Error) => void> = [];

    constructor() {
      state.transports.push(this);
    }

    onMessage(listener: (message: unknown) => void) {
      this.listener = listener;
    }

    onClose(listener: () => void) {
      this.closeListeners.push(listener);
    }

    onError(listener: (error: Error) => void) {
      this.errorListeners.push(listener);
    }

    async start() {}
    async dispose() {
      this.disposeCount++;
    }

    emit(message: unknown) {
      this.listener?.(message);
    }

    /** 测试用：模拟进程终止/报错，触发 onDead 让会话缓存 evict 自己。 */
    simulateTerminated() {
      for (const l of this.closeListeners) l();
    }

    /** 测试用：模拟子进程往 stdout 打了一行非 JSON 内容（onError，进程本身没死）。 */
    simulateError() {
      for (const l of this.errorListeners) l(new Error("malformed"));
    }

    async send(raw: unknown) {
      const message = raw as Record<string, unknown>;
      this.sent.push(message);
      const id = message.id;
      const method = message.method;
      if (id !== undefined) {
        let result: unknown = null;
        if (method === "initialize") result = { capabilities: {} };
        if (method === "textDocument/definition") {
          result = [{
            uri: "file:///workspace/src/definition.ts",
            range: { start: { line: 2, character: 4 } },
          }];
        }
        if (method === "textDocument/hover") {
          result = { contents: { kind: "plaintext", value: "const value: number" } };
        }
        queueMicrotask(() => this.emit({ jsonrpc: "2.0", id, result }));
      }
      if (method === "textDocument/didOpen" || method === "textDocument/didChange") {
        queueMicrotask(() => this.emit({
          jsonrpc: "2.0",
          method: "textDocument/publishDiagnostics",
          params: {
            uri: "file:///workspace/src/file.ts",
            diagnostics: [{
              range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } },
              severity: 1,
              source: "ts",
              message: "Type mismatch",
            }],
          },
        }));
      }
    }
  },
}));

const {
  disposeLspSessions,
  getLspDefinition,
  getLspDiagnostics,
  getLspHover,
} = await import("../lsp-session");

describe("lsp-session", () => {
  beforeEach(() => {
    state.content = "const value: number = 'bad';";
  });

  it("opens, refreshes changed content, and returns current diagnostics", async () => {
    await expect(getLspDiagnostics("/workspace", "/workspace/src/file.ts"))
      .resolves.toContain("Type mismatch");

    state.content = "const value: number = 1;";
    await expect(getLspDiagnostics("/workspace", "/workspace/src/file.ts"))
      .resolves.toContain("Type mismatch");

    const methods = state.transports[0]!.sent.map((message) => message.method);
    expect(methods).toContain("textDocument/didOpen");
    expect(methods).toContain("textDocument/didChange");
  });

  it("formats definition and hover responses", async () => {
    await expect(getLspDefinition("/workspace", "/workspace/src/file.ts", 1, 1))
      .resolves.toContain("definition.ts:3:5");
    await expect(getLspHover("/workspace", "/workspace/src/file.ts", 1, 1))
      .resolves.toContain("const value: number");
  });

  // 2026-07-15 review 修复回归测试：进程崩溃/被 kill 后，之前 sessions 缓存的条目原样留着
  // 指向已死的 transport，之后同 workspace 的调用会一直复用这个死会话，用户必须重启 app
  // 才能恢复。现在 transport 报 terminated 后应该把缓存 evict，下一次调用会重新 spawn 一个
  // 全新的 transport（而不是继续复用死掉的那个）。用独立的 workspace 路径隔离，不跟前面
  // 测试共享的 "/workspace" 会话互相干扰。
  it("transport 报 terminated 后应该从缓存 evict，下次调用重新建会话而不是复用死会话", async () => {
    await getLspDiagnostics("/workspace-evict", "/workspace-evict/src/file.ts");
    const transportsAfterFirstCall = state.transports.length;
    const firstTransport = state.transports[transportsAfterFirstCall - 1]!;

    // 模拟进程被杀（比如 write_rpc_stdin 超时自动终止）
    firstTransport.simulateTerminated();

    await getLspDiagnostics("/workspace-evict", "/workspace-evict/src/file.ts");
    const transportsAfterSecondCall = state.transports.length;

    // evict 生效：第二次调用应该重新建了一个新 transport，不是复用第一次那个
    expect(transportsAfterSecondCall).toBe(transportsAfterFirstCall + 1);
  });

  // 2026-07-16 review 修复回归测试：onClose（进程真的死了）时 Rust 侧 rpc.rs 的
  // child.wait() 已经把 session_id 从表里删了，只 evict JS 缓存就够。但 onError（子进程
  // 往 stdout 打了一行非 JSON 内容，进程本身没死）之前只 evict 不 dispose——Rust 侧那个
  // 还活着的进程会永久占着这个确定性 session_id，下次同 workspace 重连撞
  // "RPC session already exists" 硬拒绝，必须重启 app 才能恢复。现在 onError 也应该先
  // dispose()（真正 kill 掉 Rust 侧进程释放 session_id）再 evict。
  it("transport 报 error（进程没死，stdout 吐了脏数据）也要 dispose 掉进程，不能只 evict 缓存", async () => {
    await getLspDiagnostics("/workspace-error-evict", "/workspace-error-evict/src/file.ts");
    const transportsAfterFirstCall = state.transports.length;
    const firstTransport = state.transports[transportsAfterFirstCall - 1]!;

    firstTransport.simulateError();

    expect(firstTransport.disposeCount).toBe(1);

    await getLspDiagnostics("/workspace-error-evict", "/workspace-error-evict/src/file.ts");
    const transportsAfterSecondCall = state.transports.length;
    expect(transportsAfterSecondCall).toBe(transportsAfterFirstCall + 1);
  });

  it("gracefully shuts down active sessions", async () => {
    await disposeLspSessions();
    const methods = state.transports[0]!.sent.map((message) => message.method);
    expect(methods).toContain("shutdown");
    expect(methods).toContain("exit");
  });
});
