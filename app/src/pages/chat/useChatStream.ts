import {
  useRef,
  useState,
  type Dispatch,
  type MutableRefObject,
  type RefObject,
  type SetStateAction,
} from "react";
import type { TFunction } from "i18next";
import { getApiKey } from "@/lib/keystore";
import {
  toolExecutions,
  workflowRuns,
  type Conversation,
  type ToolExecutionRow,
} from "@/lib/db";
import { type ModelListItem, type CredentialListItem } from "@/lib/api";
import { type Attachment } from "@/lib/llm/attachments";
import { type OrchestrationState, type RoleId } from "@/lib/llm/orchestrator";
import { type TurnIntentDecision, type WorkflowSnapshot } from "@/lib/workflow/types";
import { type ToolConfirmRequest, type AskUserRequest } from "@/lib/llm/tools";
import {
  type ModelEndpoint,
  type StreamUsage,
} from "@/lib/llm/chat-fallback";
import {
  currentNode,
} from "@/lib/llm/orchestrator";
import { isPureSingleModelModeEnabled, isSmartRoutingEnabled } from "@/lib/app-settings";
import { shouldExposeWriteTools, impliesWriteIntent } from "@/lib/llm/tool-permission-policy";
import { getFsAdapter } from "@/lib/llm/tools/fs-adapter";
import { prepareTurnWorkflow } from "@/lib/workflow/prepare-turn-workflow";
import { buildSkillPreamble } from "@/lib/skills/preamble";
import { selectSkillForTurn } from "@/lib/skills/selector";
import { skillDefinitions, rowToDefinition } from "@/lib/db/skill-definitions";
import type { SkillDefinition } from "@/lib/skills/types";
import { capabilitiesForPhase } from "@/lib/workflow/phase-capabilities";
import { loadClaudeCodeSkills, buildSkillCatalogPreamble } from "@/lib/llm/claude-code-compat/skill-loader";
import { attachActiveSkillToWorkflow, attachPlanSourceToWorkflow } from "@/lib/workflow/reducer";
import { buildWorkflowContextPreamble, readDesktopPlanForExecution } from "@/lib/workflow/execution-context";
import { classifyLlmError } from "@/lib/llm/error-classifier";
import { buildChatMemoryPreambles } from "@/lib/memory/chat-memory-preamble";
import { createOptimisticUserTurn } from "@/pages/chat/optimistic-turn";
import { runSemanticCacheRuntime } from "@/pages/chat/cache-runtime";
import { runDebateRuntime } from "@/pages/chat/debate-runtime";
import { evaluateChatTurnHarness } from "@/pages/chat/chat-harness-eval";
import { buildMainChatModelChain } from "@/pages/chat/model-chain";
import { prepareChatPromptRuntime } from "@/pages/chat/prompt-runtime";
import { finalizeStreamedChatTurn } from "@/pages/chat/stream-finalization";
import { runChatStreamRuntime } from "@/pages/chat/stream-runtime";
import { runPostStreamOrchestrationRuntime } from "@/pages/chat/post-stream-orchestration-runtime";
import { prepareTurnModels } from "@/pages/chat/turn-model-preparation";
import { prepareTurnPersistence } from "@/pages/chat/turn-persistence";
import { resolveWriteGuardRuntime } from "@/pages/chat/write-guard-runtime";
import { prepareChatWorkspaceRuntime } from "@/pages/chat/workspace-runtime";
import {
  useAutoScrollOnMessages,
  usePendingSendDrain,
  useStreamingTimer,
} from "@/pages/chat/chat-stream-effects";
import type { StreamActivityPhase } from "@/pages/chat/streaming-status";
import type { ChatMessage, PendingRoutingDecision, PendingSend } from "@/pages/chat/types";

type ChatUsage = StreamUsage;

export interface UseChatStreamOptions {
  // 顶层 state
  conversationId: string | null;
  /**
   * useConversations() 提供的活体 ref（effect 里同步 conversationId），用来在
   * finalizeStreamedChatTurn 的后台验收落地前判断用户是不是已经切走了会话——
   * conversationId 这个闭包值在 handleSend 定义时就已经固定，切会话后不会变。
   */
  conversationIdRef: MutableRefObject<string | null>;
  conversationList: Conversation[];
  // getSelectedModelId()/getAvailableModels()/getCredentials() 改为 getter 模式（hook B 持 state + ChatPage 顶层 useState 镜像）——
  // 避免 hook B 持 state → hook C 又依赖的循环
  getSelectedModelId: () => string;
  setSelectedModelId: (id: string) => void;
  getAvailableModels: () => ModelListItem[];
  getCredentials: () => CredentialListItem[];
  workspacePath: string | null;
  setWorkspacePath: Dispatch<SetStateAction<string | null>>;
  permissionMode: "read" | "confirm" | "auto";
  /**
   * 检测到写意图但权限只读时，主动弹窗问用户要不要切到「确认后修改」——不传则退化成
   * 只插一条文字提示（旧行为）。同一个会话只弹一次，见 handleSend 内 escalationPromptedRef。
   */
  escalatePermission?: () => Promise<boolean>;
  setPanelOpen: Dispatch<SetStateAction<boolean>>;
  // isStreaming 提到 ChatPage 顶层共享（hook C + hook E 都需要）
  isStreaming: boolean;
  setIsStreaming: Dispatch<SetStateAction<boolean>>;

  // hook D (orchestration)
  handleNodeModelChange: (nodeId: string, modelId: string) => void;
  orchestrationRef: MutableRefObject<OrchestrationState | null>;
  workflowSnapshotRef: MutableRefObject<WorkflowSnapshot | null>;
  applyOrchestration: (next: OrchestrationState | null) => void;
  applyWorkflowSnapshot: (next: WorkflowSnapshot | null) => void;
  setChainExecutedRoles: (updater: RoleId[] | ((prev: RoleId[]) => RoleId[])) => void;
  setChainSkippedRoles: (updater: RoleId[] | ((prev: RoleId[]) => RoleId[])) => void;
  setChainAbortedRole: (role: RoleId | null) => void;
  setChainRunning: (running: boolean) => void;
  chainAbortRef: MutableRefObject<AbortController | null>;

  // hook E (work panel)
  applyToolExecutionRows: (rows: ToolExecutionRow[]) => void;
  requestConfirm: (req: ToolConfirmRequest) => Promise<boolean>;
  requestAskUser: (req: AskUserRequest) => Promise<string>;

  // hook F + 顶层 ref
  scrollRef: RefObject<HTMLDivElement | null>;
  stickToBottomRef: MutableRefObject<boolean>;
  pendingRoutingDecisionRef: MutableRefObject<PendingRoutingDecision | null>;

  // i18n + UI
  t: TFunction;
}
export function useChatStream(opts: UseChatStreamOptions) {
  const {
    conversationId,
    conversationIdRef,
    conversationList,
    getSelectedModelId,
    setSelectedModelId,
    getAvailableModels,
    getCredentials,
    workspacePath,
    setWorkspacePath,
    permissionMode,
    escalatePermission,
    setPanelOpen,
    isStreaming,
    setIsStreaming,
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
  } = opts;

  // 流式 state（isStreaming 提到 ChatPage 顶层共享，避免 hook C/E 循环依赖）
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streamElapsedMs, setStreamElapsedMs] = useState(0);
  const [streamActivityPhase, setStreamActivityPhase] = useState<StreamActivityPhase>("idle");
  const [pendingQueue, setPendingQueue] = useState<PendingSend[]>([]);
  const drainingRef = useRef(false);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [switchNotice, setSwitchNotice] = useState<string | null>(null);
  const [cacheNotice, setCacheNotice] = useState<string | null>(null);
  const [harnessNotice, setHarnessNotice] = useState<string | null>(null);
  const [persistNotice, setPersistNotice] = useState<string | null>(null);
  const [debateParticipants, setDebateParticipants] = useState<{ modelId: string; modelName: string }[] | null>(null);
  const [lastUsage, setLastUsage] = useState<ChatUsage | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  /** 写权限升级弹窗只在同一个会话里问一次——记已经问过（不管用户同意与否）的会话 id */
  const escalationPromptedRef = useRef<Set<string>>(new Set());

  useStreamingTimer({ isStreaming, setStreamElapsedMs });
  useAutoScrollOnMessages({ messages, scrollRef, stickToBottomRef });

  // handleSend 整体（含 5 段 helper）
  async function handleSend(text: string, attachments?: Attachment[]) {
    const activeNode = currentNode(orchestrationRef.current);
    const nodeModelId = activeNode?.role === "leader" ? null : (activeNode?.modelId ?? null);
    const actorRole = activeNode?.role ?? "leader";
    const effectiveId =
      nodeModelId && getAvailableModels().some((m) => m.id === nodeModelId) ? nodeModelId : getSelectedModelId();
    const foundModel = getAvailableModels().find((m) => m.id === effectiveId);
    if (!foundModel || isStreaming) return;
    const model: ModelListItem = foundModel;

    const controller = new AbortController();
    abortRef.current = controller;
    const cleanupStoppedTurn = () => {
      setIsStreaming(false);
      setStreamActivityPhase("idle");
      if (abortRef.current === controller) abortRef.current = null;
    };
    const stopIfAborted = () => {
      if (!controller.signal.aborted) return false;
      cleanupStoppedTurn();
      return true;
    };
    setIsStreaming(true);
    setStreamError(null);
    setSwitchNotice(null);
    setCacheNotice(null);
    if (effectiveId !== getSelectedModelId()) setSelectedModelId(effectiveId);

    const routingDecision =
      pendingRoutingDecisionRef.current &&
      pendingRoutingDecisionRef.current.prompt === text &&
      pendingRoutingDecisionRef.current.actualModelId === model.id
        ? {
            baselineModelId: pendingRoutingDecisionRef.current.baselineModelId,
            baselineModelName: pendingRoutingDecisionRef.current.baselineModelName,
            baselineProviderType: pendingRoutingDecisionRef.current.baselineProviderType ?? null,
            actualModelId: pendingRoutingDecisionRef.current.actualModelId,
          }
        : null;
    pendingRoutingDecisionRef.current = null;
    const isFirstMessage = messages.length === 0;
    const smart = isSmartRoutingEnabled();
    const pureMode = isPureSingleModelModeEnabled();
    const optimisticTurn = createOptimisticUserTurn<ChatMessage>({ messages, text, attachments });
    const userMsg: ChatMessage = optimisticTurn.userMsg;
    const newMessages: ChatMessage[] = [...messages, userMsg];
    let userId = userMsg.id;
    stickToBottomRef.current = true;
    setMessages(newMessages);

    try {
      const prep = await prepareTurn();
      if (prep === null) return;
      if (await maybeRunDebate(prep)) return;
      const cacheOutcome = await tryCacheHit(prep);
      if (cacheOutcome.hit) return;
      await runStreamLoop(cacheOutcome.prep);
      await postStreamOrchestration(cacheOutcome.prep);
    } finally {
      cleanupStoppedTurn();
    }

    async function prepareTurn() {
      const preparedModels = await prepareTurnModels({
        model,
        availableModels: getAvailableModels(),
        credentials: getCredentials(),
        getApiKey,
        isAborted: () => controller.signal.aborted,
      });
      if (!preparedModels.ok) {
        if (preparedModels.reason === "missing-credential") {
          setStreamError(t("chat.noCredential"));
          cleanupStoppedTurn();
        } else if (preparedModels.reason === "missing-api-key") {
          setStreamError(t("chat.noApiKey"));
          cleanupStoppedTurn();
        }
        return null;
      }
      const {
        credential: cred,
        primaryIsCli,
        apiKey,
        intentJudgeModel,
        auxiliaryJudgeModel,
      } = preparedModels;

      const hasImage = attachments?.some((a) => a.kind === "image");
      if (hasImage && primaryIsCli) {
        setStreamError(t("chat.attachments.cliNoImage"));
        cleanupStoppedTurn();
        return null;
      }
      const folderAtt = attachments?.find((a) => a.kind === "folder");
      if (folderAtt) setWorkspacePath(folderAtt.path);
      const effectiveWorkspace = folderAtt?.path ?? workspacePath;

      const persistedTurn = await prepareTurnPersistence({
        conversationId,
        optimisticUserId: userId,
        modelId: model.id,
        untitledTitle: t("chat.untitledChat"),
        text,
        attachments,
        isFirstMessage,
        isAborted: () => controller.signal.aborted,
        onPersistenceFailure: () => setPersistNotice(t("chat.persistFailed")),
      });
      if (persistedTurn.aborted) return null;
      const {
        conversationId: convId,
        userId: persistedUserId,
        persistAssistant,
      } = persistedTurn;
      userId = persistedUserId;

      const currentConversation = convId
        ? conversationList.find((conversation) => conversation.id === convId) ?? null
        : null;
      const preparedWorkflow = await prepareTurnWorkflow({
        conversationId: convId,
        projectId: currentConversation?.projectId ?? null,
        pureMode,
        initialSnapshot: workflowSnapshotRef.current,
        text,
        userId,
        intentJudgeModel,
        workspacePath: effectiveWorkspace,
        applySnapshot: applyWorkflowSnapshot,
      });
      const {
        snapshot: turnWorkflowSnapshot,
        runId: turnWorkflowRunId,
        shouldCompleteNode: shouldCompleteWorkflowNode,
        intentDecision: turnIntentDecision,
        intentJudgeCalled: intentJudgeCalledThisTurn,
        workflowAdvanced: workflowAdvancedThisTurn,
      } = preparedWorkflow;
      if (stopIfAborted()) return null;

      return {
        cred,
        primaryIsCli,
        apiKey,
        intentJudgeModel,
        auxiliaryJudgeModel,
        folderAtt,
        effectiveWorkspace,
        convId,
        persistAssistant,
        turnWorkflowSnapshot,
        turnWorkflowRunId,
        shouldCompleteWorkflowNode,
        turnIntentDecision,
        intentJudgeCalledThisTurn,
        workflowAdvancedThisTurn,
      };
    }

    async function maybeRunDebate(prep: Awaited<ReturnType<typeof prepareTurn>>): Promise<boolean> {
      if (!prep) return false;
      return runDebateRuntime({
        prep: {
          conversationId: prep.convId,
          workspacePath: prep.effectiveWorkspace,
          workflowSnapshot: prep.turnWorkflowSnapshot,
          workflowRunId: prep.turnWorkflowRunId,
          intentDecision: prep.turnIntentDecision,
          persistAssistant: prep.persistAssistant,
        },
        pureMode,
        text,
        model,
        availableModels: getAvailableModels(),
        credentials: getCredentials(),
        conversationList,
        messages,
        userMessage: userMsg,
        visibleMessages: newMessages,
        controller,
        getApiKey,
        t,
        applyWorkflowSnapshot,
        setMessages,
        setPanelOpen,
        setIsStreaming,
        setStreamError,
        setSwitchNotice,
        setCacheNotice,
        setPersistNotice,
        setDebateParticipants,
        markStickToBottom: () => {
          stickToBottomRef.current = true;
        },
        clearAbortController: () => {
          if (abortRef.current === controller) abortRef.current = null;
        },
      });
    }

    type PreparedTurn = NonNullable<Awaited<ReturnType<typeof prepareTurn>>>;
    type StreamReadyTurn = PreparedTurn & {
      assistantId: string;
      assistantMsg: ChatMessage;
      taskRole: string;
      turnStartedAt: string;
      cacheIntent: TurnIntentDecision;
      cacheEligible: boolean;
      tools?: Awaited<ReturnType<typeof prepareChatWorkspaceRuntime>>["tools"];
      finalContent?: string;
      finalAssistantMsg?: ChatMessage;
    };

    async function tryCacheHit(prep: PreparedTurn): Promise<
      | { hit: true }
      | { hit: false; prep: StreamReadyTurn }
    > {
      const cacheWorkspace = prep.folderAtt?.path ?? workspacePath;
      const cacheResult = await runSemanticCacheRuntime({
        text,
        newMessages,
        modelId: model.id,
        modelLabel: model.displayName ?? model.name,
        pureMode,
        smartRoutingEnabled: smart,
        workspacePath: cacheWorkspace,
        workflowSnapshot: workflowSnapshotRef.current,
        intentJudgeCalledThisTurn: prep.intentJudgeCalledThisTurn,
        turnIntentDecision: prep.turnIntentDecision,
        intentJudgeModel: prep.intentJudgeModel,
        persistAssistant: prep.persistAssistant,
        cacheHitLabel: (days) => t("chat.cacheHit", { days }),
        markStickToBottom: () => {
          stickToBottomRef.current = true;
        },
        setMessages,
        setIsStreaming,
        setStreamError,
        setSwitchNotice,
        setCacheNotice,
        setPersistNotice,
        onCacheHitDone: cleanupStoppedTurn,
      });

      if (cacheResult.hit) return { hit: true };

      return {
        hit: false,
        prep: {
          ...prep,
          assistantId: cacheResult.assistantId,
          assistantMsg: cacheResult.assistantMsg,
          taskRole: cacheResult.taskRole,
          turnStartedAt: cacheResult.turnStartedAt,
          cacheIntent: cacheResult.cacheIntent,
          cacheEligible: cacheResult.cacheEligible,
        },
      };
    }

    async function runStreamLoop(prep: StreamReadyTurn) {
      const {
        assistantId,
        assistantMsg,
        taskRole,
        turnStartedAt,
        cacheIntent,
        cacheEligible,
      } = prep;
      const {
        cred,
        primaryIsCli,
        apiKey,
        effectiveWorkspace,
        convId,
        auxiliaryJudgeModel,
        turnWorkflowSnapshot,
        turnWorkflowRunId,
        shouldCompleteWorkflowNode,
      } = prep;
      let activeTurnWorkflowSnapshot = turnWorkflowSnapshot;

      let chain: ModelEndpoint[];
      try {
        // getApiKey 静态导入
        chain = await buildMainChatModelChain({
          primaryModel: model,
          primaryCredential: cred,
          primaryApiKey: apiKey,
          primaryIsCli,
          availableModels: getAvailableModels(),
          credentials: getCredentials(),
          attachments,
          effectiveWorkspace,
          getApiKey,
          stopIfAborted,
          pureMode,
        });
      } catch (err) {
        setStreamError(err instanceof Error ? err.message : t("chat.constructError"));
        cleanupStoppedTurn();
        return;
      }

      let tools: Awaited<ReturnType<typeof prepareChatWorkspaceRuntime>>["tools"];
      let workspacePreamble: string | null = null;
      let workflowPreamble: string | null = null;
      let skillPreamble: string | null = null;
      let projectMemoryPreamble: string | null = null;
      let crossProjectPreamble: string | null = null;
      const { effectivePermissionMode } = await resolveWriteGuardRuntime({
        text,
        decision: cacheIntent,
        workspacePath: effectiveWorkspace,
        permissionMode,
        conversationId: convId,
        assistantId,
        promptedConversationIds: escalationPromptedRef.current,
        escalatePermission,
        labels: {
          noWorkspace: t("chat.writeGuardNotice.noWorkspace"),
          readOnly: t("chat.writeGuardNotice.readOnly"),
          dynamicModelPool: t("chat.workPanel.dynamicModelPool"),
        },
        setMessages,
      });

      // K7 能力门控的允许集来自「当前工作流阶段」策略（已与 skill 解耦，见 phase-capabilities.ts）。
      // 必须在工具构建前算出：ctx 在 buildAiSdkTools 时定型，之后才执行。
      // 下方 desktopPlan 只改 planSource 不改 phase，故此处用的阶段与最终一致。
      const currentNode = activeTurnWorkflowSnapshot?.nodes.find(
        (n) => n.id === activeTurnWorkflowSnapshot?.currentNodeId,
      );
      const activeCaps = capabilitiesForPhase(currentNode?.phase);

      // Skill 选择（仅用于注入 skillPreamble；能力门控已不依赖它）。
      // DB 不可用 / 空表都降级到 undefined —— selector / preamble 内部回退到 CORE_SKILLS
      //（空数组不会被 `activeSkills ?? CORE_SKILLS` 兜底，会把 skill 整个关掉，故显式转 undefined）。
      let activeSkillDefs: SkillDefinition[] | undefined;
      try {
        const rows = await skillDefinitions.listActive();
        activeSkillDefs = rows.length > 0 ? rows.map(rowToDefinition) : undefined;
      } catch {
        activeSkillDefs = undefined;
      }
      const selectedSkill = selectSkillForTurn({
        text,
        workflowSnapshot: activeTurnWorkflowSnapshot,
        intentDecision: cacheIntent,
        activeSkills: activeSkillDefs,
      });

      const includeWriteTools = shouldExposeWriteTools(effectivePermissionMode);
      const workspaceRuntime = await prepareChatWorkspaceRuntime({
        workspacePath: effectiveWorkspace,
        primaryIsCli,
        includeWriteTools,
        conversationId: convId,
        assistantId,
        permissionMode: effectivePermissionMode,
        requestConfirm,
        requestAskUser,
        stopIfAborted,
        modelName: model.name,
        activeCaps,
      });
      if (workspaceRuntime.aborted) return;
      tools = workspaceRuntime.tools;
      prep.tools = tools;
      workspacePreamble = workspaceRuntime.workspacePreamble;
      const desktopPath = workspaceRuntime.desktopPath;

      const desktopPlan = await readDesktopPlanForExecution({
        userText: text,
        desktopPath,
        fs: getFsAdapter(),
      });
      if (desktopPlan && convId && activeTurnWorkflowSnapshot && turnWorkflowRunId) {
        const nextWorkflow = attachPlanSourceToWorkflow({
          snapshot: activeTurnWorkflowSnapshot,
          summary: desktopPlan.content.slice(0, 1200),
          source: {
            kind: "file",
            ref: desktopPlan.path,
            summary: desktopPlan.content.slice(0, 1200),
            phase: "plan",
            boundAt: new Date().toISOString(),
            label: "用户桌面方案文件",
          },
        });
        await workflowRuns.saveSnapshot({
          runId: turnWorkflowRunId,
          snapshot: nextWorkflow,
          eventType: "workflow.plan_source_attached",
          eventPayload: { path: desktopPlan.path },
        }).catch(() => {});
        activeTurnWorkflowSnapshot = nextWorkflow;
        applyWorkflowSnapshot(nextWorkflow);
      }
      workflowPreamble = buildWorkflowContextPreamble({
        snapshot: activeTurnWorkflowSnapshot,
        userText: text,
        desktopPlan,
      });

      // selectedSkill / activeSkillDefs 已在工具构建前算出（见上方 K7 能力门控块），
      // 这里只做「把选中 skill 写回 workflow snapshot + 落审计事件」的副作用。
      if (selectedSkill && convId && activeTurnWorkflowSnapshot && turnWorkflowRunId) {
        const nextWorkflow = attachActiveSkillToWorkflow({
          snapshot: activeTurnWorkflowSnapshot,
          skill: selectedSkill,
        });
        await workflowRuns.saveSnapshot({
          runId: turnWorkflowRunId,
          snapshot: nextWorkflow,
          eventType: "workflow.skill_selected",
          eventPayload: { skillId: selectedSkill.id, reason: selectedSkill.reason },
        }).catch(() => {});
        activeTurnWorkflowSnapshot = nextWorkflow;
        applyWorkflowSnapshot(nextWorkflow);
      }
      const legacySkillPreamble = buildSkillPreamble(selectedSkill, activeSkillDefs);
      // 真 Skill（磁盘 .claude/skills/*/SKILL.md）目录——只在绑了工作区时读，读取失败不影响主流程。
      let realSkillCatalogPreamble: string | null = null;
      if (effectiveWorkspace) {
        try {
          const realSkills = await loadClaudeCodeSkills(effectiveWorkspace);
          realSkillCatalogPreamble = buildSkillCatalogPreamble(realSkills);
        } catch {
          realSkillCatalogPreamble = null;
        }
      }
      skillPreamble = [legacySkillPreamble, realSkillCatalogPreamble].filter(Boolean).join("\n\n") || null;

      const currentProjectId =
        (convId ? conversationList.find((c) => c.id === convId)?.projectId : null) ?? null;
      const memoryPreambles = await buildChatMemoryPreambles({
        projectId: currentProjectId,
        text,
        pureMode,
        stopIfAborted,
      });
      if (memoryPreambles.aborted) return;
      projectMemoryPreamble = memoryPreambles.projectMemoryPreamble;
      crossProjectPreamble = memoryPreambles.crossProjectPreamble;

      const promptRuntime = await prepareChatPromptRuntime({
        messages: newMessages,
        effectiveWorkspace,
        primaryIsCli,
        projectMemoryPreamble,
        crossProjectPreamble,
        workspacePreamble,
        workflowPreamble,
        skillPreamble,
        model,
        smartRoutingEnabled: smart,
        summarizeModel: auxiliaryJudgeModel?.model ?? null,
        conversationId: convId,
        labels: {
          fileTooLarge: (name) => t("chat.attachments.fileTooLarge", { name }),
          contextTrimmed: (count) => t("chat.contextTrimmed", { count }),
        },
      });
      const outgoing = promptRuntime.messages;
      const compressionStats = promptRuntime.compressionStats;

      const turnImpliesWrite = impliesWriteIntent({ text, decision: cacheIntent });
      let finalContent = "";
      let streamingResult: Awaited<ReturnType<typeof runChatStreamRuntime>> | null = null;
      try {
        streamingResult = await runChatStreamRuntime({
          chain,
          initialMessages: outgoing,
          assistantId,
          controller,
          modelId: model.id,
          conversationId: convId,
          taskRole,
          actorRole,
          routingDecision,
          compressionStats,
          tools,
          pureMode,
          turnImpliesWrite,
          turnStartedAt,
          evalHarness: ({ content, actualToolCallCount, assistantMessageId, finishReason }) =>
            evaluateChatTurnHarness({
              conversationId: convId,
              content,
              sinceIso: turnStartedAt,
              actualToolCallCount,
              assistantMessageId,
              finishReason,
              judgeModel: auxiliaryJudgeModel?.model ?? null,
              onRowsLoaded: applyToolExecutionRows,
            }),
          labels: {
            harnessRetry: t("chat.harnessRetry"),
            intentNudgeRetry: t("chat.intentNudgeRetry"),
            switchedTo: (name) => t("chat.switchedTo", { name }),
          },
          setMessages,
          setSwitchNotice,
          setLastUsage,
          setHarnessNotice,
          setStreamActivityPhase,
        });
        if (streamingResult.aborted) {
          // 2026-07-16 review 修复：这是"优雅 abort"路径（runChatStreamRuntime 检测到
          // controller.signal.aborted 后正常 return，不抛异常），跟下面 catch 块里的
          // AbortError 异常路径是同一个用户动作（点停止）触发的两条不同代码路径，但只有
          // catch 块补了 persistAssistant——这里原来是裸 return，已经流出显示在 UI 上的
          // 部分内容从未落库，切会话再切回来 / 重启 app 后这条回复会整个消失。跟 catch 块
          // 保持同样的处理：落库已流出的部分内容，内容为空才落"已停止"占位。
          const partialContent = streamingResult.fullContent;
          prep.persistAssistant(partialContent, streamingResult.lastModelId);
          if (!partialContent) {
            setMessages((prev) =>
              prev.map((m) => (m.id === assistantId ? { ...m, content: t("chat.stopped") } : m)),
            );
          }
          return;
        }
        const finalized = await finalizeStreamedChatTurn({
          text,
          assistantId,
          assistantMessage: assistantMsg,
          streamingResult,
          conversationId: convId,
          cacheEligible,
          taskRole,
          shouldCompleteWorkflowNode,
          workflowSnapshot: activeTurnWorkflowSnapshot,
          workflowRunId: turnWorkflowRunId,
          controllerAborted: controller.signal.aborted,
          persistAssistant: prep.persistAssistant,
          setMessages,
          applyWorkflowSnapshot,
          conversationIdRef,
        });
        finalContent = finalized.finalContent;
        setHarnessNotice(null);
        prep.finalContent = finalContent;
        prep.finalAssistantMsg = finalized.finalAssistantMsg;
      } catch (err) {
        const partialContent = streamingResult?.fullContent ?? "";
        prep.persistAssistant(partialContent, model.id);
        setHarnessNotice(null);
        if ((err as Error).name === "AbortError") {
          if (!partialContent) {
            setMessages((prev) =>
              prev.map((m) => (m.id === assistantId ? { ...m, content: t("chat.stopped") } : m)),
            );
          }
          return;
        }
        const classified = classifyLlmError(err, t);
        const isCliError = typeof err === "object" && err !== null && "__cliKind" in err;
        const lowInfo =
          classified.category === "unknown" ||
          classified.category === "tool_budget_exhausted" ||
          isCliError;
        setStreamError(
          lowInfo && classified.technicalMessage
            ? `${classified.userMessage}（${classified.technicalMessage}）`
            : classified.userMessage,
        );
        setMessages((prev) => prev.filter((m) => m.id !== assistantId || m.content !== ""));
      } finally {
        setIsStreaming(false);
        setStreamActivityPhase("idle");
        abortRef.current = null;
        if (convId) {
          void toolExecutions.listByConversation(convId).then(applyToolExecutionRows).catch(() => {});
        }
      }
    }

    async function postStreamOrchestration(prep: StreamReadyTurn) {
      const finalContent = prep.finalContent;
      const finalAssistantMsg = prep.finalAssistantMsg;
      const {
        convId,
        effectiveWorkspace,
        turnIntentDecision,
        auxiliaryJudgeModel,
        taskRole,
        cacheIntent,
      } = prep;
      void runPostStreamOrchestrationRuntime({
        conversationId: convId,
        activeConversationId: conversationId,
        finalContent,
        finalAssistantMsg,
        pureMode,
        controller,
        text,
        taskRole,
        hasWorkspace: Boolean(effectiveWorkspace),
        intentDecision: turnIntentDecision ?? cacheIntent,
        newMessages,
        orchestrationState: orchestrationRef.current,
        availableModels: getAvailableModels(),
        credentials: getCredentials(),
        getApiKey,
        leaderModelId: getSelectedModelId(),
        applyOrchestration,
        setSelectedModelId,
        setMessages,
        tools: prep.tools,
        userTask: text,
        judgeModel: auxiliaryJudgeModel?.model ?? null,
        evalHarness: ({ content, startedAt, toolCallCount, finishReason, assistantMessageId, judgeModel }) =>
          evaluateChatTurnHarness({
            conversationId: convId,
            content,
            sinceIso: startedAt,
            actualToolCallCount: toolCallCount,
            assistantMessageId,
            finishReason,
            judgeModel,
            onRowsLoaded: applyToolExecutionRows,
          }),
        applyToolExecutionRows,
        chainAbortRef,
        setChainExecutedRoles,
        setChainSkippedRoles,
        setChainAbortedRole,
        setChainRunning,
        t,
      });
    }

  }

  function handleStop() {
    abortRef.current?.abort();
    chainAbortRef.current?.abort();
    abortRef.current = null;
    chainAbortRef.current = null;
    setPendingQueue([]);
    setIsStreaming(false);
    setStreamActivityPhase("idle");
    setChainRunning(false);
  }

  // handleSend 句柄镜像（队列 effect 读 ref.current 保证最新闭包）
  const handleSendRef = useRef(handleSend);
  handleSendRef.current = handleSend;

  usePendingSendDrain({
    drainingRef,
    isStreaming,
    pendingQueue,
    sendRef: handleSendRef,
    setPendingQueue,
  });

  return {
    abortRef,
    cacheNotice,
    debateParticipants,
    drainingRef,
    handleSend,
    handleStop,
    harnessNotice,
    lastUsage,
    messages,
    pendingQueue,
    persistNotice,
    setLastUsage,
    setMessages,
    setPendingQueue,
    setStreamElapsedMs,
    setStreamError,
    setHarnessNotice,
    setSwitchNotice,
    setCacheNotice,
    setPersistNotice,
    streamElapsedMs,
    streamActivityPhase,
    streamError,
    switchNotice,
  };
}
