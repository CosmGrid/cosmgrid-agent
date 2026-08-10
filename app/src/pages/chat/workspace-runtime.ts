import { desktopDir } from "@tauri-apps/api/path";
import type { ToolConfirmRequest, AskUserRequest } from "@/lib/llm/tools";
import { buildWorkspacePreamble } from "@/lib/llm/prompts/workspace-context";
import {
  prepareWorkspaceToolRuntime,
  type WorkspaceToolRuntime,
} from "@/lib/llm/workspace-tool-runtime";
import { formatLocalMcpLaunch } from "@/lib/mcp/session-scope";

export interface PrepareChatWorkspaceRuntimeArgs {
  workspacePath: string | null;
  primaryIsCli: boolean;
  includeWriteTools: boolean;
  conversationId: string | null;
  assistantId: string;
  permissionMode: "read" | "confirm" | "auto";
  requestConfirm: (req: ToolConfirmRequest) => Promise<boolean>;
  requestAskUser: (req: AskUserRequest) => Promise<string | null>;
  getDesktopPath?: () => Promise<string | null>;
  stopIfAborted: () => boolean;
  /** 2026-07-10 OMO-7 capability guardrail：当前选中模型的人类可读名，透传给
   *  prepareWorkspaceToolRuntime 查 models.dev 的 tool_call/vision 能力位。 */
  modelName?: string;
  /** K7 能力门控：本轮允许的 capability 集（来源 = 工作流阶段策略），透传烘进工具 ToolContext。 */
  activeCaps?: string[];
}

export interface PreparedChatWorkspaceRuntime {
  aborted: boolean;
  desktopPath: string | null;
  tools?: WorkspaceToolRuntime["tools"];
  workspacePreamble: string | null;
}

export async function prepareChatWorkspaceRuntime(
  args: PrepareChatWorkspaceRuntimeArgs,
): Promise<PreparedChatWorkspaceRuntime> {
  const desktopPath = await (args.getDesktopPath ?? (() => desktopDir().catch(() => null)))();
  const writableDesktopPath = args.includeWriteTools ? desktopPath : null;
  const confirm = async (request: ToolConfirmRequest): Promise<boolean> => {
    // 工具可能先做路径解析/差异计算，直到 Stop 之后才抵达确认边界。
    // 必须在真正入队前再次核对本轮，auto 档也不能让旧轮继续写盘。
    if (args.stopIfAborted()) return false;
    return args.permissionMode === "auto" ? true : args.requestConfirm(request);
  };
  const approveMcpLaunch: NonNullable<
    Parameters<typeof prepareWorkspaceToolRuntime>[0]["approveMcpLaunch"]
  > = async (server, workspacePath) => {
    if (args.stopIfAborted()) return false;
    return args.requestConfirm({
      toolName: `mcp-server:${server.name}`,
      summary: `允许启动本地 MCP server？\n${formatLocalMcpLaunch(server, workspacePath)}`,
    });
  };
  const askUser = async (request: AskUserRequest): Promise<string | null> => {
    if (args.stopIfAborted()) return null;
    return args.requestAskUser(request);
  };

  if (args.workspacePath) {
    if (args.primaryIsCli) {
      const workspacePreamble = await buildWorkspacePreamble(args.workspacePath, {
        includeWrite: args.includeWriteTools,
        desktopPath: writableDesktopPath,
      });
      return {
        aborted: args.stopIfAborted(),
        desktopPath,
        workspacePreamble,
      };
    }

    const runtime = await prepareWorkspaceToolRuntime({
      workspacePath: args.workspacePath,
      includeWrite: args.includeWriteTools,
      conversationId: args.conversationId ?? undefined,
      messageId: args.assistantId,
      confirm,
      approveMcpLaunch,
      askUser,
      includePreamble: true,
      desktopPath: writableDesktopPath,
      modelName: args.modelName,
      activeCaps: args.activeCaps,
    });
    return {
      aborted: args.stopIfAborted(),
      desktopPath,
      tools: runtime.tools,
      workspacePreamble: runtime.workspacePreamble,
    };
  }

  if (!args.primaryIsCli) {
    const runtime = await prepareWorkspaceToolRuntime({
      includeWrite: false,
      conversationId: args.conversationId ?? undefined,
      messageId: args.assistantId,
      confirm,
      approveMcpLaunch,
      askUser,
      modelName: args.modelName,
      activeCaps: args.activeCaps,
    });
    return {
      aborted: args.stopIfAborted(),
      desktopPath,
      tools: runtime.tools,
      workspacePreamble: null,
    };
  }

  return {
    aborted: false,
    desktopPath,
    workspacePreamble: null,
  };
}
