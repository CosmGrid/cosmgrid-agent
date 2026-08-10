import { JsonRpcClient } from "@/lib/rpc/rpc-client";
import { TauriRpcTransport } from "@/lib/rpc/tauri-transport";
import type { McpServerRow } from "@/lib/db/mcp";
import type { McpToolCallResult, McpToolLike } from "@/lib/llm/tools/mcp-tool-adapter";
import { buildLocalMcpSessionScope } from "./session-scope";

interface McpToolListResult {
  tools?: McpToolLike[];
  nextCursor?: string;
}

interface LocalMcpSession {
  client: JsonRpcClient;
  transport: TauriRpcTransport;
}

type RemoteClientModule = typeof import("./remote-client");

const localSessions = new Map<string, Promise<LocalMcpSession>>();
const MCP_PROTOCOL_VERSION = "2025-11-25";
let remoteClientModulePromise: Promise<RemoteClientModule> | null = null;
// 修复（2026-07-13 真实事故：什么都没做，只点了几个功能，退出还是卡顿一下）：不能用
// "remote-client 模块有没有被 import 过"当作"现在是否还有真实远程会话"的信号——只要调用
// 过一次 listMcpTools/callMcpTool（哪怕是本地 stdio 类型，第79行 listMcpTools 也会顺带
// 触发 loadRemoteClient），remoteClientModulePromise 就永久不为 null（从没有代码把它
// 重置回 null），导致 hasKnownMcpSessions() 对这个进程的余生永远返回 true，每次关闭都
// 白白走一遍清理慢路径。这里改成记录已经 resolve 出来的模块引用，查它真实的
// hasRemoteMcpSessions()（remote-client.ts 自己维护的会话 Map），而不是"模块加载过没有"
// 这个错误的代理指标。模块还在加载中时天然返回 false——这个阶段真实会话必然还不存在，
// 判 false 不会漏清理。
let resolvedRemoteClientModule: RemoteClientModule | null = null;

function loadRemoteClient(): Promise<RemoteClientModule> {
  remoteClientModulePromise ??= import("./remote-client").then((mod) => {
    resolvedRemoteClientModule = mod;
    return mod;
  });
  return remoteClientModulePromise;
}

export function hasKnownMcpSessions(): boolean {
  return localSessions.size > 0 || (resolvedRemoteClientModule?.hasRemoteMcpSessions() ?? false);
}

async function getLocalSession(server: McpServerRow, workspacePath?: string): Promise<LocalMcpSession> {
  const scope = buildLocalMcpSessionScope(server, workspacePath);
  const key = scope.key;
  await disposeStaleLocalConfigSessions(server.id, scope.configFingerprint);
  let promise = localSessions.get(key);
  if (!promise) {
    // 2026-07-15 review 修复：进程崩溃/被 kill（比如 write_rpc_stdin 超时自动终止，见
    // rpc.rs）后，之前这里完全没反应——localSessions 缓存的条目原样留着指向已死的
    // client/transport，之后同 workspace 的调用要么快速失败于"session not found"要么再次
    // 悬挂，用户必须重启 app 才能恢复。onDead 挂上 transport 的 onClose/onError，进程一
    // 终止/一报错就把这个 key 从缓存里 evict；只在"当前仍是这一份 promise"时才删，避免
    // 旧会话延迟触发的事件误删掉中途已经建好的新会话。
    const onDead = () => {
      if (localSessions.get(key) === promise) localSessions.delete(key);
    };
    promise = (async () => {
      if (!server.command) throw new Error(`MCP server ${server.name} has no command`);
      const transport = new TauriRpcTransport({
        sessionId: scope.sessionId,
        program: server.command,
        args: server.args,
        cwd: workspacePath || null,
        env: server.env,
        framing: "newline",
      });
      const client = new JsonRpcClient(transport, { timeoutMs: 30_000 });
      // 2026-07-16 review 修复：onError（子进程 stdout 打出一行非 JSON 内容，很多第三方
      // stdio MCP server 常见的调试日志误打到 stdout）触发时进程本身没死，只 evict JS 缓存
      // 不 kill 掉这个还活着的进程的话，Rust 侧 session_id 永久占位——下次同 workspace
      // 重连用同一个确定性 session_id 调 spawn_rpc_process 会撞 "already exists" 硬拒绝，
      // 这个 server 只能重启 app 才能恢复。onClose（进程真的终止）时 Rust 侧已经在
      // child.wait() 里把 session_id 从表里删了，这里再 dispose() 一次是无害空操作
      // （dispose 内部 catch 掉了错误），两种触发统一走 dispose+evict，不再只 evict。
      const disposeAndEvict = () => {
        void transport.dispose();
        onDead();
      };
      transport.onClose(disposeAndEvict);
      transport.onError(disposeAndEvict);
      await transport.start();
      await client.call("initialize", {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "Cosmgrid-Agent", version: "0.1" },
      });
      await client.notify("notifications/initialized");
      return { client, transport };
    })().catch((error) => {
      localSessions.delete(key);
      throw error;
    });
    localSessions.set(key, promise);
  }
  return promise;
}

async function disposeStaleLocalConfigSessions(serverId: string, configFingerprint: string): Promise<void> {
  const entries = [...localSessions.entries()].filter(([key]) => (
    key.startsWith(`${serverId}::`) && !key.endsWith(`::${configFingerprint}`)
  ));
  for (const [key] of entries) localSessions.delete(key);
  const settled = await Promise.allSettled(entries.map(([, session]) => session));
  await Promise.all(settled.map((entry) => {
    if (entry.status !== "fulfilled") return Promise.resolve();
    entry.value.client.dispose();
    return entry.value.transport.dispose();
  }));
}

export async function listMcpTools(server: McpServerRow, workspacePath?: string): Promise<McpToolLike[]> {
  if (server.transport === "remote_http") {
    const { listRemoteMcpTools } = await loadRemoteClient();
    return listRemoteMcpTools(server);
  }
  const session = await getLocalSession(server, workspacePath);
  const { listAllRemoteTools } = await loadRemoteClient();
  return listAllRemoteTools({
    listTools: (params) => session.client.call<McpToolListResult>("tools/list", params),
  });
}

export async function callMcpTool(
  server: McpServerRow,
  toolName: string,
  input: unknown,
  workspacePath?: string,
): Promise<McpToolCallResult> {
  const params = { name: toolName, arguments: input };
  if (server.transport === "remote_http") {
    const { callRemoteMcpTool } = await loadRemoteClient();
    return callRemoteMcpTool(server, toolName, input);
  }
  const session = await getLocalSession(server, workspacePath);
  return session.client.call<McpToolCallResult>("tools/call", params);
}

export async function disposeLocalMcpSessions(): Promise<void> {
  const settled = await Promise.allSettled([...localSessions.values()]);
  localSessions.clear();
  await Promise.all(settled.map((entry) => {
    if (entry.status !== "fulfilled") return Promise.resolve();
    entry.value.client.dispose();
    return entry.value.transport.dispose();
  }));
}

export async function disposeAllMcpSessions(): Promise<void> {
  const remoteClient = remoteClientModulePromise ? await remoteClientModulePromise : null;
  await Promise.all([
    disposeLocalMcpSessions(),
    remoteClient ? remoteClient.disposeRemoteMcpSessions() : Promise.resolve(),
  ]);
}

export async function disposeMcpServerSessions(serverId: string): Promise<void> {
  const entries = [...localSessions.entries()].filter(([key]) => key.startsWith(`${serverId}::`));
  for (const [key] of entries) localSessions.delete(key);
  const settled = await Promise.allSettled(entries.map(([, session]) => session));
  await Promise.all(settled.map((entry) => {
    if (entry.status !== "fulfilled") return Promise.resolve();
    entry.value.client.dispose();
    return entry.value.transport.dispose();
  }));
  const remoteClient = remoteClientModulePromise ? await remoteClientModulePromise : null;
  await remoteClient?.disposeRemoteMcpServerSessions(serverId);
}
