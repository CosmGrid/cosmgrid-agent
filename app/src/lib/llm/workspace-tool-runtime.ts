import type { Tool } from "ai";
import { buildAiSdkTools, createDefaultToolRegistry, ToolRegistry, type ToolConfirmRequest, type AskUserRequest, type CommandAuthorizationInput } from "./tools";
import { webFetchTool } from "./tools/web-fetch-tool";
import { rememberTool } from "./tools/memory-tool";
import { askUserTool } from "./tools/ask-user-tool";
import { buildWorkspacePreamble } from "./prompts/workspace-context";
import { registerEnabledMcpTools } from "@/lib/mcp/register-tools";
import type { McpServerRow } from "@/lib/db/mcp";
import { getModelToolCallSupport } from "./model-limits"; // 2026-07-10 OMO-7 capability guardrail

export interface WorkspaceToolRuntimeOptions {
  workspacePath?: string | null;
  includeWrite: boolean;
  projectId?: string;
  conversationId?: string;
  /** 2026-07-04 修复：这次调用归属的 assistant 消息 id，透传进 ToolContext，
   *  让工具执行审计能按真实消息分组，而不是靠时间戳窗口猜。 */
  messageId?: string;
  confirm?: (preview: ToolConfirmRequest) => Promise<boolean>;
  commandAuthorization?: CommandAuthorizationInput;
  /** 本地 MCP 进程启动前的独立人工授权；不能被 auto 权限档替换为自动同意。 */
  approveMcpLaunch?: (server: McpServerRow, workspacePath?: string) => Promise<boolean>;
  /** ask_user_question 工具用：结构化追问；null 表示停止时未作答。 */
  askUser?: (request: AskUserRequest) => Promise<string | null>;
  blockedCommands?: string[];
  includePreamble?: boolean;
  /** 桌面绝对路径——让模型知道"保存/导出到桌面"该写哪（见 workspace-context.ts 的 desktopPath）。 */
  desktopPath?: string | null;
  /** 2026-07-10 OMO-7 capability guardrail：当前选中模型的人类可读名，传了才能查 models.dev
   *  的 tool_call/vision 能力位；不传就按"支持"处理（不确定不拦截）。 */
  modelName?: string;
  /** K7 能力门控：本轮允许的 capability 集（来源 = 工作流阶段策略），烘进每个工具的 ToolContext。
   *  不传 / 空 = 不门控（无阶段策略时保持全放行）。 */
  activeCaps?: string[];
}

export interface WorkspaceToolRuntime {
  tools?: Record<string, Tool>;
  workspacePreamble: string | null;
}

/**
 * 构造一轮模型调用要用的工作区工具。
 * 工具构建和项目说明读取故意分开容错：说明读取失败不能连坐工具能力。
 */
export async function prepareWorkspaceToolRuntime(
  options: WorkspaceToolRuntimeOptions,
): Promise<WorkspaceToolRuntime> {
  // The runtime is the sole source of command read roots.  Callers can provide
  // authorization inputs, never a root list; each turn gets a replacement list.
  const commandAuthorization = options.commandAuthorization
    ? {
        ...options.commandAuthorization,
        authorizedReadRoots: options.workspacePath ? [options.workspacePath] : [],
      }
    : undefined;
  // 2026-07-10 OMO-7 capability guardrail：models.dev 明确说这个模型不支持工具调用
  // （不是查不到的 undefined）→ 不管有没有工作区，整个工具集都不给，直接返回空。
  // 给了也是白给——provider 大概率会因为带了 tools 参数直接 400，不如干脆不传。
  const toolCallDisabled = options.modelName !== undefined && getModelToolCallSupport(options.modelName) === false;

  // 没绑工作区：文件/命令类工具没有根目录可用，但 web_fetch（联网）和 remember（记忆）
  // 不依赖 workspacePath，不该被连坐一起消失——纯聊天模式下也该给这两个。
  if (!options.workspacePath) {
    if (toolCallDisabled) return { tools: undefined, workspacePreamble: null };
    let tools: Record<string, Tool> | undefined;
    try {
      const registry = new ToolRegistry();
      registry.register(webFetchTool);
      registry.register(askUserTool);
      if (options.conversationId) registry.register(rememberTool);
      await registerEnabledMcpTools(registry, {
        approveLocalLaunch: options.approveMcpLaunch,
      });
      tools = buildAiSdkTools(registry, {
        workspacePath: "",
        projectId: options.projectId,
        conversationId: options.conversationId,
        messageId: options.messageId,
        confirm: options.confirm,
        ...(commandAuthorization ? { commandAuthorization } : {}),
        askUser: options.askUser,
        activeCaps: options.activeCaps,
      });
    } catch (err) {
      console.error("[tools] 构建无工作区工具失败:", err);
    }
    return { tools, workspacePreamble: null };
  }

  let tools: Record<string, Tool> | undefined;
  let workspacePreamble: string | null = null;

  if (!toolCallDisabled) {
    try {
      const registry = createDefaultToolRegistry({ includeWrite: options.includeWrite, modelName: options.modelName });
      await registerEnabledMcpTools(registry, {
        workspacePath: options.workspacePath,
        approveLocalLaunch: options.approveMcpLaunch,
      });
      tools = buildAiSdkTools(registry, {
        workspacePath: options.workspacePath,
        projectId: options.projectId,
        conversationId: options.conversationId,
        messageId: options.messageId,
        confirm: options.confirm,
        ...(commandAuthorization ? { commandAuthorization } : {}),
        askUser: options.askUser,
        blockedCommands: options.blockedCommands,
        activeCaps: options.activeCaps,
      });
    } catch (err) {
      console.error("[tools] 构建工具失败:", err);
    }
  }

  if (options.includePreamble) {
    try {
      workspacePreamble = await buildWorkspacePreamble(options.workspacePath, {
        includeWrite: options.includeWrite,
        desktopPath: options.desktopPath,
      });
    } catch (err) {
      console.error("[tools] 读项目自述失败（不影响工具）:", err);
    }
  }

  return { tools, workspacePreamble };
}
