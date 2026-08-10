import { TauriRpcTransport } from "@/lib/rpc/tauri-transport";
import { JsonRpcClient } from "@/lib/rpc/rpc-client";
import { getFsAdapter } from "@/lib/llm/tools/fs-adapter";
import {
  buildDidOpenParams,
  filePathToUri,
  formatLspDiagnostics,
  type LspDiagnostic,
  positionToLsp,
} from "./protocol";
import { detectLspServer, languageIdForPath, type LspServerConfig } from "./server-detection";
import { planDocumentSync, type OpenDocumentState } from "./document-sync";

type DiagnosticsMap = Map<string, LspDiagnostic[]>;

interface SessionEntry {
  client: JsonRpcClient;
  transport: TauriRpcTransport;
  diagnostics: DiagnosticsMap;
  openDocuments: Map<string, OpenDocumentState>;
  server: LspServerConfig;
}

interface LspLocation {
  uri?: string;
  targetUri?: string;
  range?: { start: { line: number; character: number } };
  targetSelectionRange?: { start: { line: number; character: number } };
}

interface LspHover {
  contents?: string | { kind?: string; value?: string } | Array<string | { value?: string }>;
}

const sessions = new Map<string, Promise<SessionEntry>>();

export function hasLspSessions(): boolean {
  return sessions.size > 0;
}

function sessionKey(workspacePath: string, server: LspServerConfig): string {
  return `${workspacePath}::${server.program}::${server.args.join(" ")}`;
}

function stableSessionId(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `lsp-${(hash >>> 0).toString(16)}`;
}

async function createSession(
  workspacePath: string,
  server: LspServerConfig,
  onDead: () => void,
): Promise<SessionEntry> {
  const transport = new TauriRpcTransport({
    sessionId: stableSessionId(sessionKey(workspacePath, server)),
    program: server.program,
    args: server.args,
    cwd: workspacePath,
    framing: "content-length",
  });
  const client = new JsonRpcClient(transport, { timeoutMs: 20_000 });
  // 2026-07-15 review 修复：进程崩溃/被 kill（比如 write_rpc_stdin 超时自动终止，见 rpc.rs）
  // 后，之前这里完全没反应——sessions 缓存的 SessionEntry 原样留着，指向一个已经死掉的
  // client/transport，之后同 workspace 的调用要么快速失败于"session not found"要么再次
  // 悬挂，用户必须重启 app 才能恢复该 workspace 的 LSP 功能。这里挂上 onClose/onError，
  // 进程一终止/一报错就把这个 key 从缓存里 evict，下次调用会重新 spawn 一个干净的会话。
  //
  // 2026-07-16 review 修复：onClose（进程真的退出）触发时 Rust 侧 rpc.rs 的 child.wait()
  // 已经把这个 session_id 从 RpcChildren 表里删了，这条路径本来就没问题。但 onError
  // （比如子进程往 stdout 打了一行不是 JSON 的日志，见 tauri-transport.ts 的
  // "malformed JSON" 分支）触发时进程根本没死，Rust 侧那个 session_id 依然占着——只 evict
  // JS 侧缓存不 kill 掉这个还活着的进程的话，下次同 workspace 重连会用同一个确定性
  // session_id 调 spawn_rpc_process，命中 rpc.rs 的 "RPC session already exists" 硬拒绝，
  // 这个 workspace 的 LSP 从此死锁，只能重启 app。所以两种触发都要先 dispose()（内部会调
  // kill_rpc_process 真正杀掉 Rust 侧进程，进程已经死了的场景下这只是个无害的空操作，
  // dispose() 内部本来就 catch 掉了错误）再 evict 缓存，不能只 evict 不 dispose。
  const disposeAndEvict = () => {
    void transport.dispose();
    onDead();
  };
  transport.onClose(disposeAndEvict);
  transport.onError(disposeAndEvict);
  const diagnostics: DiagnosticsMap = new Map();

  client.onRequest("workspace/configuration", (params) => {
    const items = (params as { items?: unknown[] } | undefined)?.items;
    return Array.isArray(items) ? items.map(() => null) : [];
  });
  client.onRequest("client/registerCapability", () => null);
  client.onRequest("client/unregisterCapability", () => null);
  client.onRequest("workspace/workspaceFolders", () => [
    { uri: filePathToUri(workspacePath), name: workspacePath.split("/").pop() ?? "workspace" },
  ]);

  client.onNotification((method, params) => {
    if (method !== "textDocument/publishDiagnostics" || !params || typeof params !== "object") return;
    const payload = params as { uri?: unknown; diagnostics?: unknown };
    if (typeof payload.uri !== "string" || !Array.isArray(payload.diagnostics)) return;
    diagnostics.set(payload.uri, payload.diagnostics as LspDiagnostic[]);
  });

  await transport.start();
  await client.call("initialize", {
    processId: null,
    rootUri: filePathToUri(workspacePath),
    capabilities: {
      textDocument: {
        synchronization: { didOpen: true, didChange: true },
        publishDiagnostics: { relatedInformation: true },
        hover: { contentFormat: ["markdown", "plaintext"] },
        definition: { linkSupport: true },
      },
    },
    workspaceFolders: [{ uri: filePathToUri(workspacePath), name: workspacePath.split("/").pop() ?? "workspace" }],
  });
  await client.notify("initialized", {});

  return { client, transport, diagnostics, openDocuments: new Map(), server };
}

async function getSession(workspacePath: string, filePath: string): Promise<SessionEntry | null> {
  const server = await detectLspServer(workspacePath, filePath);
  if (!server) return null;
  const key = sessionKey(workspacePath, server);
  let promise = sessions.get(key);
  if (!promise) {
    // onDead 只在“当前仍是这个 key 对应的这一份 promise”时才 evict——避免旧会话延迟触发的
    // onClose，把中间已经被新会话重新占用的同一个 key 误删掉（比如 evict 后立刻又有新调用
    // 建了新会话，旧 transport 才慢一拍报 terminated）。
    const onDead = () => {
      if (sessions.get(key) === promise) sessions.delete(key);
    };
    promise = createSession(workspacePath, server, onDead).catch((error) => {
      sessions.delete(key);
      throw error;
    });
    sessions.set(key, promise);
  }
  return promise;
}

async function syncFile(entry: SessionEntry, filePath: string): Promise<{ uri: string; changed: boolean }> {
  const uri = filePathToUri(filePath);
  const languageId = languageIdForPath(filePath) ?? entry.server.languageId;
  const content = await getFsAdapter().readTextFile(filePath);
  const plan = planDocumentSync(entry.openDocuments.get(uri), content);
  if (plan.kind === "open") {
    entry.diagnostics.delete(uri);
    await entry.client.notify("textDocument/didOpen", buildDidOpenParams({
      path: filePath,
      languageId,
      content,
      version: plan.state.version,
    }));
  } else if (plan.kind === "change") {
    entry.diagnostics.delete(uri);
    await entry.client.notify("textDocument/didChange", {
      textDocument: { uri, version: plan.state.version },
      contentChanges: [{ text: content }],
    });
  }
  entry.openDocuments.set(uri, plan.state);
  return { uri, changed: plan.kind !== "unchanged" };
}

async function waitForDiagnostics(entry: SessionEntry, uri: string): Promise<LspDiagnostic[] | null> {
  const started = Date.now();
  while (Date.now() - started < 1_500) {
    const diagnostics = entry.diagnostics.get(uri);
    if (diagnostics) return diagnostics;
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  return entry.diagnostics.get(uri) ?? null;
}

export async function getLspDiagnostics(workspacePath: string, filePath: string): Promise<string> {
  const entry = await getSession(workspacePath, filePath);
  if (!entry) {
    return "未找到可用的 TypeScript LSP。请在项目里安装 typescript-language-server，或把它加入 PATH。";
  }
  const { uri } = await syncFile(entry, filePath);
  const diagnostics = await waitForDiagnostics(entry, uri);
  if (!diagnostics) {
    return `LSP diagnostics 超时：${filePath} 尚未返回诊断，不能据此判断代码无错误。`;
  }
  return formatLspDiagnostics(filePath, diagnostics);
}

function formatLocation(location: LspLocation): string | null {
  const uri = location.targetUri ?? location.uri;
  const start = location.targetSelectionRange?.start ?? location.range?.start;
  if (!uri || !start) return null;
  return `${uri}:${start.line + 1}:${start.character + 1}`;
}

export async function getLspDefinition(
  workspacePath: string,
  filePath: string,
  line: number,
  character: number,
): Promise<string> {
  const entry = await getSession(workspacePath, filePath);
  if (!entry) return "未找到可用的 TypeScript LSP，无法跳转定义。";
  const { uri } = await syncFile(entry, filePath);
  const result = await entry.client.call("textDocument/definition", {
    textDocument: { uri },
    position: positionToLsp({ line, character }),
  });
  const locations = (Array.isArray(result) ? result : result ? [result] : []) as LspLocation[];
  const formatted = locations.map(formatLocation).filter((item): item is string => Boolean(item));
  return formatted.length > 0 ? `定义位置：\n${formatted.join("\n")}` : "没有找到定义位置。";
}

function hoverContentsToText(contents: LspHover["contents"]): string {
  if (!contents) return "";
  if (typeof contents === "string") return contents;
  if (Array.isArray(contents)) {
    return contents.map((item) => typeof item === "string" ? item : item.value ?? "").filter(Boolean).join("\n\n");
  }
  return contents.value ?? "";
}

export async function getLspHover(
  workspacePath: string,
  filePath: string,
  line: number,
  character: number,
): Promise<string> {
  const entry = await getSession(workspacePath, filePath);
  if (!entry) return "未找到可用的 TypeScript LSP，无法查看悬停信息。";
  const { uri } = await syncFile(entry, filePath);
  const result = await entry.client.call<LspHover | null>("textDocument/hover", {
    textDocument: { uri },
    position: positionToLsp({ line, character }),
  });
  const text = hoverContentsToText(result?.contents).trim();
  return text ? `Hover 信息：\n${text}` : "当前位置没有 Hover 信息。";
}

export async function disposeLspSessions(): Promise<void> {
  const entries = await Promise.allSettled([...sessions.values()]);
  sessions.clear();
  await Promise.all(entries.map((entry) => {
    if (entry.status !== "fulfilled") return Promise.resolve();
    return (async () => {
      await Promise.race([
        entry.value.client.call("shutdown").catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 1_000)),
      ]);
      await entry.value.client.notify("exit").catch(() => undefined);
      entry.value.client.dispose();
      await entry.value.transport.dispose();
    })();
  }));
}
