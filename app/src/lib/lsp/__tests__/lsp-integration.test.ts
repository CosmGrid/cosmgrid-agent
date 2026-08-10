import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JsonRpcClient, type JsonRpcTransport } from "@/lib/rpc/rpc-client";
import { encodeContentLengthFrame } from "@/lib/rpc/framing";
import { filePathToUri } from "../protocol";

class NodeLspTransport implements JsonRpcTransport {
  private messageListener: ((message: unknown) => void) | null = null;
  private closeListener: (() => void) | null = null;
  private errorListener: ((error: Error) => void) | null = null;
  private buffer = Buffer.alloc(0);

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.on("data", (chunk: Buffer) => this.handleChunk(chunk));
    child.on("exit", () => this.closeListener?.());
    child.on("error", (error) => this.errorListener?.(error));
  }

  onMessage(listener: (message: unknown) => void): void {
    this.messageListener = listener;
  }

  onClose(listener: () => void): void {
    this.closeListener = listener;
  }

  onError(listener: (error: Error) => void): void {
    this.errorListener = listener;
  }

  async send(message: unknown): Promise<void> {
    const frame = encodeContentLengthFrame(JSON.stringify(message));
    await new Promise<void>((resolve, reject) => {
      this.child.stdin.write(frame, (error) => error ? reject(error) : resolve());
    });
  }

  private handleChunk(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const match = /(?:^|\r\n)Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        this.errorListener?.(new Error("LSP frame missing Content-Length"));
        return;
      }
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + length) return;
      const body = this.buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      this.buffer = this.buffer.subarray(bodyStart + length);
      this.messageListener?.(JSON.parse(body));
    }
  }
}

describe("TypeScript LSP real-process integration", () => {
  let workspace: string;
  let child: ChildProcessWithoutNullStreams;
  let client: JsonRpcClient;
  let diagnosticPromise: Promise<unknown>;

  beforeAll(async () => {
    workspace = await mkdtemp(join(tmpdir(), "cosmgrid-lsp-"));
    await writeFile(join(workspace, "package.json"), JSON.stringify({ private: true }));
    await writeFile(join(workspace, "tsconfig.json"), JSON.stringify({
      compilerOptions: { strict: true, noEmit: true },
      include: ["index.ts"],
    }));
    const filePath = join(workspace, "index.ts");
    const content = "const count: number = 'wrong';\ncount;\n";
    await writeFile(filePath, content);

    child = spawn(join(process.cwd(), "node_modules/.bin/typescript-language-server"), ["--stdio"], {
      cwd: workspace,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const transport = new NodeLspTransport(child);
    client = new JsonRpcClient(transport, { timeoutMs: 10_000 });
    client.onRequest("client/registerCapability", () => null);
    client.onRequest("workspace/configuration", (params) => {
      const items = (params as { items?: unknown[] } | undefined)?.items;
      return Array.isArray(items) ? items.map(() => null) : [];
    });
    diagnosticPromise = new Promise((resolve) => {
      client.onNotification((method, params) => {
        if (method !== "textDocument/publishDiagnostics") return;
        // typescript-language-server 可能先发布一次空 diagnostics，再发布真正的类型错误。
        // 不能把第一条通知当最终结果，否则用例会随进程时序随机红。
        const diagnostics = (params as {
          diagnostics?: Array<{ message?: string }>;
        } | undefined)?.diagnostics;
        if (diagnostics?.some((item) => item.message?.includes("not assignable"))) {
          resolve(params);
        }
      });
    });

    await client.call("initialize", {
      processId: null,
      rootUri: filePathToUri(workspace),
      capabilities: {
        textDocument: {
          synchronization: { didOpen: true, didChange: true },
          publishDiagnostics: { relatedInformation: true },
          hover: { contentFormat: ["plaintext"] },
        },
      },
      workspaceFolders: [{ uri: filePathToUri(workspace), name: "fixture" }],
    });
    await client.notify("initialized", {});
    await client.notify("workspace/didChangeConfiguration", { settings: {} });
    await client.notify("textDocument/didOpen", {
      textDocument: {
        uri: filePathToUri(filePath),
        languageId: "typescript",
        version: 1,
        text: content,
      },
    });
  }, 20_000);

  afterAll(async () => {
    await client.call("shutdown").catch(() => undefined);
    await client.notify("exit").catch(() => undefined);
    client.dispose();
    child.kill("SIGKILL");
    await rm(workspace, { recursive: true, force: true });
  });

  it("receives diagnostics and serves hover from the real language server", async () => {
    const diagnostics = await diagnosticPromise as { diagnostics?: Array<{ message?: string }> };
    expect(diagnostics.diagnostics?.some((item) => item.message?.includes("not assignable"))).toBe(true);

    const hover = await client.call<{ contents?: unknown }>("textDocument/hover", {
      textDocument: { uri: filePathToUri(join(workspace, "index.ts")) },
      position: { line: 1, character: 1 },
    });
    expect(JSON.stringify(hover.contents)).toContain("number");
  }, 15_000);
});
