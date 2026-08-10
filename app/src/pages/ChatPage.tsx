// ChatPage - 重构为 "Cosmic Cyber" 视觉风格
// 阶段 7：handleSend 整套 + 流式 state + 流式计时/自动滚底/队列排空 effect 全搬到 hook C
// ChatPage 协调层只保留 hook 组合 + handleNewChat / switchConversation / handleNodeModelChange / handleFormSubmit
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { usePanelResize } from "@/components/ui/resize-handle";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { deriveChainNodeGraph } from "@/components/work-panel/derive-chain-node-graph";
import { ensureModelLimitsLoaded } from "@/lib/llm/model-limits";
import { type ModelListItem, type CredentialListItem } from "@/lib/api";
import { conversations as dbConversations, messages as dbMessages, toolExecutions, type Conversation } from "@/lib/db";
import { usePermissionModeSetting } from "@/lib/app-settings";
import { enableWorkspaceProtection } from "@/lib/llm/tools/git-snapshot";
import { getActiveAssistantModelLabel } from "@/pages/chat/streaming-status";
import { parseOrchestration, pinModelToNode, serializeOrchestration } from "@/lib/llm/orchestrator";
import { ChatTranscript } from "@/pages/chat/ChatTranscript";
import { ChatHeader } from "@/pages/chat/ChatHeader";
import { ChatInputDock } from "@/pages/chat/ChatInputDock";
import { ChatWorkPanel } from "@/pages/chat/ChatWorkPanel";
import { dbMessagesToChat } from "@/pages/chat/history";
import { deriveToolCallsByMessage } from "@/pages/chat/tool-calls-by-message";
import { useChatAttachments } from "@/pages/chat/useChatAttachments";
import { useChatInput } from "@/pages/chat/useChatInput";
import { useChatStream } from "@/pages/chat/useChatStream";
import { useConversations } from "@/pages/chat/useConversations";
import { shouldRouteNextActionAsChatMessage } from "@/pages/chat/next-action-dispatch";
import { useModelSelection } from "@/pages/chat/useModelSelection";
import { useOrchestration } from "@/pages/chat/useOrchestration";
import { useWorkPanel } from "@/pages/chat/useWorkPanel";

// 工具权限三档（read/confirm/auto）：持久化在 app-settings 的 localStorage，
// 用户的习惯跨会话保留，重启也不被重置回只读。PermissionMode 类型从 app-settings 导出，
// 见 @/lib/app-settings（hook 也从那里导入）
interface ChatPageProps {
  /** 当前是否停留在聊天页（所有页面常驻挂载，靠这个判断"切回来了"以刷新模型列表） */
  active?: boolean;
}

export function ChatPage({ active = true }: ChatPageProps = {}) {
  const { t } = useTranslation();
  const { confirm, alert } = useConfirm();
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [conversationList, setConversationList] = useState<Conversation[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [permissionMode, setPermissionMode] = usePermissionModeSetting();
  // isStreaming 提到 ChatPage 顶层共享（hook C 持有逻辑 + hook E 守卫需要读 + 协调器用）
  const [isStreaming, setIsStreaming] = useState(false);
  // 阶段 7：selectedModelId/availableModels/credentials 提到 ChatPage 顶层 useState
  // hook B 改用 props setter 写、hook C 用 getter 读——避免 hook B/C 循环依赖
  const [selectedModelId, setSelectedModelId] = useState<string>("");
  const [availableModels, setAvailableModels] = useState<ModelListItem[]>([]);
  const [credentials, setCredentials] = useState<CredentialListItem[]>([]);

  // hook A：会话管理（持 conversationId/conversationList/conversationIdRef）
  const {
    conversationId: _conversationId,
    conversationIdRef: _conversationIdRef,
    setConversationId: _setConversationId,
  } = useConversations();
  // 显式抑制 lint：conversationIdRef 保留以备 hook D / 协调层未来用
  void _conversationIdRef;
  void _setConversationId;
  const workPanel = usePanelResize({ initial: 320, min: 240, max: 560, edge: "left" });

  const pendingRoutingDecisionRef = useRef<{
    prompt: string;
    baselineModelId: string;
    baselineModelName: string;
    baselineProviderType?: string | null;
    actualModelId: string;
  } | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // hook F：输入 + 滚动机制（scrollRef/inputAreaRef/inputAreaH/stickToBottomRef/
  // showJumpToBottom + scrollToBottom + ResizeObserver + 滚动监听 effect）
  // messages 变化触发的自动滚底 effect 留在协调层（归 hook C 流式，本阶段不搬）
  const {
    scrollRef,
    inputAreaRef,
    inputAreaH,
    stickToBottomRef,
    showJumpToBottom,
    scrollToBottom,
  } = useChatInput();

  // hook D：编排 + 对弈链 + 工作流快照（useReducer 重构）
  // 必须在 hook B 之前调用——hook B 依赖 orchestrationRef + applyOrchestration
  const {
    orchestration,
    chainExecutedRoles,
    chainSkippedRoles,
    chainAbortedRole,
    chainRunning,
    workflowEvents,
    workflowSnapshot,
    setChainExecutedRoles,
    setChainSkippedRoles,
    setChainAbortedRole,
    setChainRunning,
    orchestrationRef,
    workflowSnapshotRef,
    chainAbortRef,
    applyOrchestration,
    applyWorkflowSnapshot,
    pickNextAction,
    loadWorkflowForConversation,
  } = useOrchestration({ conversationId });

  // hook B：模型选择——移到 hook C 之后（hook B 依赖 hook C 的 messages + setSwitchNotice）

  // Harness 闭环 + 流式计时 + 自动滚底 effect —— 已搬到 hook C 流式

  function pickConversationModelId(
    conv: Conversation | null | undefined,
    models: ModelListItem[],
    fallbackId: string,
  ): string {
    const preferredId = conv?.defaultModelId ?? null;
    if (preferredId && models.some((m) => m.id === preferredId)) return preferredId;
    if (fallbackId && models.some((m) => m.id === fallbackId)) return fallbackId;
    return models[0]?.id ?? "";
  }

  // 进页面就预热 models.dev 输出上限表，让首条消息也能按模型真实上限精确给预算
  useEffect(() => {
    void ensureModelLimitsLoaded();
  }, []);

  // 挂载 effect：拉首条历史会话 + 恢复 artifacts + 编排快照。移到 hook B 之后（需要 hook B 暴露的函数 + hook C 的 setter + hook D 的函数）

  // hook E：右侧工作面板（workspace + 工具确认流 + artifacts/toolCallViews/panelOpen）
  const {
    panelOpen,
    workspacePath,
    protectedWorkspaces,
    artifacts,
    toolCallViews,
    pendingConfirm,
    pendingQuestion,
    setPanelOpen,
    setWorkspacePath,
    setProtectedWorkspaces,
    applyToolExecutionRows,
    clearToolExecutionViews,
    requestAskUser,
    requestConfirm,
    resolveAskUser,
    resolveConfirm,
    forceResolveConfirm,
    forceResolveAskUser,
    bindWorkspace,
    chooseWorkspace,
    clearWorkspace,
  } = useWorkPanel({
    conversationId,
    // 改会话工作文件夹时同步 conversationList（不写库，hook E 内部写）
    onConversationWorkspaceChanged: (path) => {
      setConversationList((prev) =>
        prev.map((c) => (c.id === conversationId ? { ...c, workspacePath: path } : c)),
      );
    },
    isStreaming,
    t,
  });

  // hook D：编排 + 对弈链 + 工作流快照（useReducer 重构）已上移到 hook F 之后

  // hook C：流式主循环 + 队列 + handleSend 整套（5 段 helper + runBackgroundOrchestration
  // + runChainIfNeeded + handleStop + 流式计时 + 自动滚底 + 队列排空 effect）
  const {
    messages,
    setMessages,
    streamElapsedMs,
    streamActivityPhase,
    pendingQueue,
    setPendingQueue,
    streamError,
    setStreamError,
    switchNotice,
    setSwitchNotice,
    cacheNotice,
    setCacheNotice,
    persistNotice,
    harnessNotice,
    debateParticipants,
    lastUsage,
    handleStop,
    usedPlaybookMemories,
    playbookPipelineTick,
  } = useChatStream({
    conversationId,
    conversationList,
    getSelectedModelId: () => selectedModelId,
    setSelectedModelId,
    getAvailableModels: () => availableModels,
    getCredentials: () => credentials,
    workspacePath,
    setWorkspacePath,
    permissionMode,
    setPanelOpen,
    isStreaming,
    setIsStreaming,
    handleNodeModelChange,
    orchestrationRef,
    workflowSnapshotRef,
    applyOrchestration,
    applyWorkflowSnapshot,
    setChainExecutedRoles,
    setChainSkippedRoles,
    setChainAbortedRole,
    setChainRunning,
    chainAbortRef,
    applyToolExecutionRows,
    requestConfirm,
    requestAskUser,
    scrollRef,
    stickToBottomRef,
    pendingRoutingDecisionRef,
    t,
  });

  // 兜底 Stop 解挂（2026-08-05）：handleStop 已重置 drainingRef + isStreaming，但这里再强制
  // resolve 掉任何挂起的「工具确认 / 追问」——否则 handleStop 解开了闸门，可那一轮仍在
  // await requestConfirm 里，确认 resolver 永不触发，turn 永远走不到 finally。三件套一起清，
  // 保证卡死（B2 确认没 resolve / B3 辅助调用超时）时一键彻底解开。
  function stopAll() {
    handleStop();
    forceResolveConfirm(false);
    forceResolveAskUser();
  }

  // hook B：模型选择（在 hook C 之后——hook B 依赖 hook C 的 messages + setSwitchNotice）
  const {
    handleModelChange,
    handleSmartPick,
    loadModelsAndCreds,
  } = useModelSelection({
    conversationId,
    orchestrationRef,
    inputRef,
    pendingRoutingDecisionRef,
    active,
    messages,
    selectedModelId,
    setSelectedModelId,
    availableModels,
    setAvailableModels,
    credentials,
    setCredentials,
    applyOrchestration,
    setSwitchNotice,
    // 用户手动切模型时同步会话默认模型到 conversationList + 写库
    onConversationDefaultModelChanged: (newId) => {
      setConversationList((prev) =>
        prev.map((c) => (c.id === conversationId ? { ...c, defaultModelId: newId } : c)),
      );
      if (conversationId) void dbConversations.setDefaultModelId(conversationId, newId).catch(() => {});
    },
    alert,
    t,
  });

  const {
    draftAttachments,
    handlePaste,
    removeAttachment,
    setDraftAttachments,
  } = useChatAttachments({ t, bindWorkspace, setStreamError });

  async function handleNewChat() {
    // 修复（2026-07-03，用户反馈"点新建对话没反应"）：这里原来是 isStreaming 时直接
    // return，如果 isStreaming 因为任何原因卡在 true（比如底层 provider 卡死不理
    // AbortSignal，或者本轮还没走到统一安全网 finally），用户会永远点不动"新建对话"，
    // 且没有任何提示——跟 handleStop（停止键）"权威停止：不管底层卡没卡死，直接把 UI
    // 拉回空闲态"是同一个思路：新建对话本身就是"我要放弃当前这轮，另起一个"的明确意图，
    // 应该强制中断当前流，而不是被它卡住拒绝响应。
    if (isStreaming) stopAll();
    try {
      const conv = await dbConversations.create({ title: t("chat.untitledChat"), defaultModelId: selectedModelId || null, projectId: null });
      setConversationList((prev) => [conv, ...prev]);
      setConversationId(conv.id);
      setWorkspacePath(null);
      setSelectedModelId(pickConversationModelId(conv, availableModels, selectedModelId));
      setMessages([]);
      clearToolExecutionViews();
      applyOrchestration(null);
      applyWorkflowSnapshot(null);
      setPendingQueue([]);
      setStreamError(null);
      setSwitchNotice(null);
      setCacheNotice(null);
    } catch (err) {
      console.error("[handleNewChat] failed to create conversation", err);
      setStreamError(t("chat.newChatFailed"));
    }
  }

  async function switchConversation(id: string) {
    if (id === conversationId) return;
    // 修复（2026-07-03）：同 handleNewChat——切换对话也是"放弃当前这轮"的明确意图，
    // isStreaming 卡住时应该强制停止而不是拒绝响应。
    if (isStreaming) stopAll();
    const nextConv = conversationList.find((c) => c.id === id) ?? null;
    setConversationId(id);
    setWorkspacePath(nextConv?.workspacePath ?? null);
    setSelectedModelId((prev) => pickConversationModelId(nextConv, availableModels, prev));
    setPendingQueue([]);
    setStreamError(null);
    setSwitchNotice(null);
    setCacheNotice(null);
    try {
      const hist = await dbMessages.listByConversation(id);
      setMessages(dbMessagesToChat(hist, availableModels));
    } catch {
      setMessages([]);
    }
    // 加载该会话的历史工具执行 → 派生工件（切回旧会话能看到之前的产出物）
    try {
      applyToolExecutionRows(await toolExecutions.listByConversation(id));
    } catch {
      clearToolExecutionViews();
    }
    try {
      applyOrchestration(parseOrchestration(await dbConversations.getOrchestration(id)));
    } catch {
      applyOrchestration(null);
    }
    await loadWorkflowForConversation(id);
  }

  async function handleDeleteConversation(id: string) {
    // 修复（2026-07-06，用户反馈"最后一个对话删不掉"）：同 handleNewChat/switchConversation
    // ——这里原来是 isStreaming 时直接 return，isStreaming 卡在 true 时点删除会被静默拦截、
    // 且没有任何提示。删除同样是"放弃当前这轮"的明确意图，应强制停止当前流而不是拒绝响应。
    if (isStreaming) stopAll();
    if (!(await confirm({ description: t("chat.deleteConvConfirm"), destructive: true }))) return;
    try {
      await dbConversations.archive(id);
    } catch (err) {
      // 修复（2026-07-04，用户反馈"删了、重装后又出现"）：这里原来是 catch 后什么都不做、
      // 照样把这条从 UI 列表移除——库里archive失败时 UI 却谎报"删掉了"，下次启动重新从库
      // 读取列表，这条又出现，看起来像"诈尸"。现在库操作失败就如实告知，且不碰 UI 列表，
      // 保证"看起来还在列表里" == "库里真的还在"，不会再有状态不一致。
      console.error("[handleDeleteConversation] failed to archive conversation", err);
      void alert({ description: t("chat.deleteConvFailed") });
      return;
    }
    const remaining = conversationList.filter((c) => c.id !== id);
    if (remaining.length === 0) {
      const conv = await dbConversations.create({ title: t("chat.untitledChat"), defaultModelId: selectedModelId || null, projectId: null });
      setConversationList([conv]);
      setConversationId(conv.id);
      setWorkspacePath(null);
      setSelectedModelId(pickConversationModelId(conv, availableModels, selectedModelId));
      setMessages([]);
      clearToolExecutionViews();
      applyOrchestration(null);
      applyWorkflowSnapshot(null);
      return;
    }
    setConversationList(remaining);
    if (id === conversationId) {
      const next = remaining[0]!;
      setConversationId(next.id);
      setWorkspacePath(next.workspacePath);
      setSelectedModelId((prev) => pickConversationModelId(next, availableModels, prev));
      try {
        const hist = await dbMessages.listByConversation(next.id);
        setMessages(dbMessagesToChat(hist, availableModels));
      } catch {
        setMessages([]);
      }
      try {
        applyToolExecutionRows(await toolExecutions.listByConversation(next.id));
      } catch {
        clearToolExecutionViews();
      }
      try {
        applyOrchestration(parseOrchestration(await dbConversations.getOrchestration(next.id)));
      } catch {
        applyOrchestration(null);
      }
      await loadWorkflowForConversation(next.id);
    }
  }

  async function handleRenameConversation(id: string, title: string) {
    const trimmed = title.trim();
    if (!trimmed) return;
    // 先乐观更新 UI，再落库（落库失败不回滚，下次加载以库为准）
    setConversationList((prev) => prev.map((c) => (c.id === id ? { ...c, title: trimmed } : c)));
    try {
      await dbConversations.rename(id, trimmed);
    } catch {
      // 改名落库失败不阻断
    }
  }

  // handleSend 拆 5 段（阶段 6 拆分）：主体只做协调 + 通用初始化；具体逻辑在 5 个 helper 内。
  // 共享变量通过闭包共享——5 个 helper 都定义在 handleSend 内部，直接访问 model/controller/convId 等。
  // 阶段 7：handleSend + 5 段 helper + runBackgroundOrchestration + runChainIfNeeded + handleStop
  // + 流式计时/自动滚底 effect + 队列排空 effect + handleSendRef 全部搬到 hook C
  // （useChatStream.ts），这里保留协调层（handleNewChat/switchConversation/handleNodeModelChange/handleFormSubmit）



  // 从节点地图给「任意节点」（含还没轮到的）主动指定模型：钉住该节点，编排后续不自动覆盖。
  // 不走 switched_up——这是用户对某节点的明确指派，不是"嫌弃当前回答"。
  function handleNodeModelChange(nodeId: string, modelId: string) {
    const state = orchestrationRef.current;
    if (!state) return;
    const updated = pinModelToNode(state, nodeId, modelId);
    applyOrchestration(updated);
    if (conversationId) void dbConversations.saveOrchestration(conversationId, serializeOrchestration(updated)).catch(() => {});
    // 改的是当前节点 → 顶部选择器也跟上，下一轮就用它
    if (nodeId === state.currentNodeId) setSelectedModelId(modelId);
  }

  // 挂载 effect：拉首条历史会话 + 恢复 artifacts + 编排快照（hook B + C + D 都已就绪）
  useEffect(() => {
    void (async () => {
      try {
        const ml = await loadModelsAndCreds();

        // 主对话多会话：列出全部主对话，没有就建一条，恢复最近一条的历史（关 app 不丢上下文）
        let list = await dbConversations.listMainChats();
        if (list.length === 0) {
          await dbConversations.getOrCreateMainChat(ml[0]?.id ?? null, t("chat.untitledChat"));
          list = await dbConversations.listMainChats();
        }
        setConversationList(list);
        const activeConv = list[0]!;
        setConversationId(activeConv.id);
        setWorkspacePath(activeConv.workspacePath);
        setSelectedModelId(pickConversationModelId(activeConv, ml, activeConv.defaultModelId ?? ""));
        const hist = await dbMessages.listByConversation(activeConv.id);
        setMessages(dbMessagesToChat(hist, ml));
        try {
          applyToolExecutionRows(await toolExecutions.listByConversation(activeConv.id));
        } catch {
          clearToolExecutionViews();
        }
        try {
          applyOrchestration(parseOrchestration(await dbConversations.getOrchestration(activeConv.id)));
        } catch {
          applyOrchestration(null);
        }
        await loadWorkflowForConversation(activeConv.id);
        setLoadError(null);
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : t("chat.loadError"));
      }
    })();
  }, []);

  function handleFormSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    const text = String(formData.get("input") ?? "").trim();
    const atts = draftAttachments;
    // 纯空不允许；但只拖图无文字也允许发
    if (!text && atts.length === 0) return;
    // 一律入队，由 drain effect 串行处理：空闲时立刻发，回复中则排队，回完自动接着发。
    setPendingQueue((q) => [...q, { text, ...(atts.length ? { attachments: atts } : {}) }]);
    setDraftAttachments([]);
    (e.currentTarget as HTMLFormElement).reset();
    // form.reset() 只清 value，不清 onChange 里手动写的内联 height——
    // 不重置的话，发送后输入框还会保持发送前撑开的高度，视觉上很奇怪。
    if (inputRef.current) inputRef.current.style.height = "auto";
  }

  // Task #9：只在 reducer 明确产生 "pick_next_step" 这种待选决策时才把 nextActions 递给
  // 输入框卡片——pendingDecision 还有 resolve_ambiguity 等其它 kind，那些目前没有专门的按钮
  // UI（用户还是打字处理），不能不分青红皂白地把 nextActions 塞进来。
  const pendingNextActions =
    workflowSnapshot?.pendingDecision?.kind === "pick_next_step" && workflowSnapshot.nextActions.length > 0
      ? workflowSnapshot.nextActions
      : null;

  // Task #9 独立复检发现的真 bug（HIGH）：debate 阶段有一条独立的执行入口 runDebateRuntime，
  // 只由 shouldRunDebateTurn 检查"这条消息文本"里有没有博弈关键词来触发（debate-runtime.ts），
  // 跟 workflowSnapshot.currentNodeId 完全解耦——applyNextActionChoice 只会把 currentNodeId
  // 挪到 debate 节点，不会真的启动博弈。用户点了"开启多模型博弈"按钮后，如果下一句只说
  // "继续"，博弈根本不会发生，静默走回单模型问答——跟 Task #9 本来要修的"分类器猜错就走错
  // 分支"是同一类症状，只是换了个触发点。
  // 直接确定性推进（pickNextAction）对 debate 这一个 action 不成立，因为它不是"挪个指针，
  // 等下一轮正常对话捡起来"，而是"现在就要真的跑一次多模型博弈"。修法：把按钮文案（本身就含
  // "博弈"关键词，isExplicitDebateRequest 能命中）当一条真实用户消息入队，走跟手打字完全
  // 相同的 handleSend 管线（intent classifier → applyTurnIntentDecision 推进阶段 →
  // shouldRunDebateTurn 判定为真 → runDebateRuntime 真正执行），而不是绕开这整条现成、
  // 经过验证的链路。其余四个 next action（make_plan/review_plan/execute_plan/
  // verify_changes）没有独立 runtime，只是挪阶段指针给下一轮正常对话的工具能力门控用，
  // 确定性推进对它们是安全、正确的，不受这次修复影响。
  function handlePickNextAction(actionId: string): void {
    const action = pendingNextActions?.find((a) => a.id === actionId);
    if (action && shouldRouteNextActionAsChatMessage(action)) {
      setPendingQueue((q) => [...q, { text: t(action.labelKey) }]);
      return;
    }
    void pickNextAction(actionId);
  }

  const selectedModel = availableModels.find(m => m.id === selectedModelId);
  const activeModelLabel = getActiveAssistantModelLabel(
    messages,
    selectedModel?.displayName ?? selectedModel?.name ?? "—",
  );
  const latestToolCalls = toolCallViews.slice(-8);
  const activeToolCall = pendingConfirm
    ? {
        id: "pending-confirm",
        toolName: pendingConfirm.toolName,
        status: "awaiting_approval" as const,
        shortSummary: pendingConfirm.summary,
        summaryKey: "unknown",
        summaryVars: { tool: pendingConfirm.toolName },
        detailPreview: "",
        detailFull: "",
        createdAt: new Date().toISOString(),
        durationMs: 0,
        messageId: null,
        // 阶段2（2026-07-11）：ToolCallView 新增结构化字段；awaiting_approval 是 UI 占位
        // 状态（待用户确认），还没真正执行，无 resultJson / artifacts / nextActions。
        errorCode: null,
        nextActions: [],
        artifacts: [],
      }
    : latestToolCalls[latestToolCalls.length - 1];

  // 把工具动作归属到对应那一轮的 assistant 消息（详细原理见 tool-calls-by-message.ts 头部注释：
  // 2026-07-04 修复，优先按真实 messageId 精确归属，只有历史遗留行才退回时间戳窗口兜底）。
  const toolCallsByMessage = useMemo(
    () => deriveToolCallsByMessage(messages, toolCallViews),
    [messages, toolCallViews],
  );

  const chainNodeGraph = useMemo(() => deriveChainNodeGraph({
    orchestration,
    workflowSnapshot,
    selectedModelId,
    selectedModelName: selectedModel?.displayName ?? selectedModel?.name ?? selectedModelId,
    availableModels,
    chainRunning,
    chainExecutedRoles,
    chainSkippedRoles,
    chainAbortedRole,
    debateParticipants,
  }), [
    orchestration,
    selectedModelId,
    selectedModel?.displayName,
    selectedModel?.name,
    workflowSnapshot,
    availableModels,
    chainRunning,
    chainExecutedRoles,
    chainSkippedRoles,
    debateParticipants,
    chainAbortedRole,
  ]);

  if (loadError) {
    return (
      <div className="flex h-full items-center justify-center p-12">
        <Alert variant="destructive" className="max-w-md bg-red-500/10 border-red-500/20 backdrop-blur-xl">
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full">
      <div className="relative flex flex-col h-full flex-1 min-w-0 rounded-3xl overflow-hidden glass">
      {/* 写操作确认：只做审批，不展示工作内容；详情放右侧工作面板。
          UI 修复（2026-07-02）：从独立悬浮卡片改成贴着输入框的小提示条，渲染挪到 ChatInputDock 内部。 */}
      <ChatHeader
        conversations={conversationList}
        conversationId={conversationId}
        selectedModelId={selectedModelId}
        availableModels={availableModels}
        panelOpen={panelOpen}
        lastUsage={lastUsage}
        switchNotice={switchNotice}
        cacheNotice={cacheNotice}
        persistNotice={persistNotice}
        harnessNotice={harnessNotice}
        onSwitchConversation={(id) => void switchConversation(id)}
        onNewChat={() => void handleNewChat()}
        onDeleteConversation={(id) => void handleDeleteConversation(id)}
        onRenameConversation={(id, title) => void handleRenameConversation(id, title)}
        onModelChange={handleModelChange}
        onSmartPick={() => void handleSmartPick()}
        onTogglePanel={() => setPanelOpen((v) => !v)}
      />

      {/* 对话列表容器 */}
      <div
        ref={scrollRef}
        data-chat-transcript-region="true"
        className="flex-1 overflow-y-auto scroll-smooth custom-scrollbar"
      >
        <ChatTranscript
          availableModelCount={availableModels.length}
          messages={messages}
          isStreaming={isStreaming}
          streamActivityPhase={streamActivityPhase}
          pendingQueue={pendingQueue}
          inputAreaH={inputAreaH}
          streamElapsedMs={streamElapsedMs}
          toolCallsByMessage={toolCallsByMessage}
          streamError={streamError}
          onStreamErrorClear={() => setStreamError(null)}
          onEnableWorkspaceProtection={
            workspacePath && !protectedWorkspaces.has(workspacePath)
              ? async () => {
                  await enableWorkspaceProtection(workspacePath);
                  setProtectedWorkspaces((prev) => new Set(prev).add(workspacePath));
                }
              : undefined
          }
        />
      </div>

      {/* 回到底部：用户往上翻看历史时出现，点一下回到最新（输出再多也不抢滚动） */}
      {showJumpToBottom && (
        <button
          type="button"
          onClick={scrollToBottom}
          title={t("chat.jumpToBottom")}
          className="absolute bottom-28 left-1/2 -translate-x-1/2 z-30 w-9 h-9 rounded-full glass border border-white/15 shadow-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-white/10 transition-colors animate-in fade-in slide-in-from-bottom-2 duration-300"
        >
          <ArrowDown className="w-4 h-4" />
        </button>
      )}

      <ChatInputDock
        inputAreaRef={inputAreaRef}
        inputRef={inputRef}
        onSubmit={handleFormSubmit}
        onPaste={handlePaste}
        activeToolCall={activeToolCall}
        isStreaming={isStreaming}
        streamActivityPhase={streamActivityPhase}
        streamElapsedMs={streamElapsedMs}
        workspacePath={workspacePath}
        onClearWorkspace={() => void clearWorkspace()}
        onChooseWorkspace={() => void chooseWorkspace()}
        permissionMode={permissionMode}
        onPermissionModeChange={setPermissionMode}
        draftAttachments={draftAttachments}
        onRemoveAttachment={removeAttachment}
        selectedModelName={selectedModel ? selectedModel.displayName || selectedModel.name : null}
        onStop={stopAll}
        pendingConfirm={pendingConfirm}
        onResolveConfirm={resolveConfirm}
        pendingQuestion={pendingQuestion}
        onResolveQuestion={resolveAskUser}
        pendingNextActions={pendingNextActions}
        onPickNextAction={handlePickNextAction}
      />
      </div>

      {panelOpen && (
        <ChatWorkPanel
          width={workPanel.width}
          onResizeMouseDown={workPanel.onMouseDown}
          onClose={() => setPanelOpen(false)}
          nodes={chainNodeGraph.nodes}
          workflowEvents={workflowEvents}
          workflowSnapshot={workflowSnapshot}
          availableModels={availableModels}
          disabled={isStreaming}
          onMainModelChange={handleModelChange}
          onNodeModelChange={handleNodeModelChange}
          conversationId={conversationId}
          workspacePath={workspacePath}
          artifacts={artifacts}
          toolCalls={toolCallViews}
          running={isStreaming}
          streamActivityPhase={streamActivityPhase}
          streamElapsedMs={streamElapsedMs}
          activeModelLabel={activeModelLabel}
          messages={messages}
          playbookMemories={usedPlaybookMemories}
          playbookRefreshTick={playbookPipelineTick}
          playbookProjectId={
            (conversationId ? conversationList.find((c) => c.id === conversationId)?.projectId : null) ?? null
          }
        />
      )}
    </div>
  );
}
