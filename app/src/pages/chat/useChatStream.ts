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
import { currentNode, type OrchestrationState, type RoleId } from "@/lib/llm/orchestrator";
import { type TurnIntentDecision, type WorkflowSnapshot } from "@/lib/workflow/types";
import { type ToolConfirmRequest, type AskUserRequest } from "@/lib/llm/tools";
import {
  type ModelEndpoint,
  type StreamUsage,
} from "@/lib/llm/chat-fallback";
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
import { recordMemoriesUsed } from "@/lib/llm/playbook/feedback";
import type { ProjectMemory } from "@/lib/db/memory";
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
import { releaseTurnIfCurrent } from "@/pages/chat/turn-ownership";

type ChatUsage = StreamUsage;

export interface UseChatStreamOptions {
  // 顶层 state
  conversationId: string | null;
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
  requestAskUser: (req: AskUserRequest) => Promise<string | null>;

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
    conversationList,
    getSelectedModelId,
    setSelectedModelId,
    getAvailableModels,
    getCredentials,
    workspacePath,
    setWorkspacePath,
    permissionMode,
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
  const drainVersionRef = useRef(0);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [switchNotice, setSwitchNotice] = useState<string | null>(null);
  const [cacheNotice, setCacheNotice] = useState<string | null>(null);
  const [harnessNotice, setHarnessNotice] = useState<string | null>(null);
  // 阶段5 Playbook：本轮注入 prompt 的记忆条目（WorkPanel 赞踩列表数据源）
  const [usedPlaybookMemories, setUsedPlaybookMemories] = useState<ProjectMemory[]>([]);
  // 阶段5 Playbook：runPlaybookPipeline 后台跑完的次数计数——PlaybookPanel 拿它当 refetch 触发信号
  // （单纯累加值，不承载业务含义，用于让下游 useEffect 依赖数组变化）
  const [playbookPipelineTick, setPlaybookPipelineTick] = useState(0);
  const [persistNotice, setPersistNotice] = useState<string | null>(null);
  const [debateParticipants, setDebateParticipants] = useState<{ modelId: string; modelName: string }[] | null>(null);
  const [lastUsage, setLastUsage] = useState<ChatUsage | null>(null);
  const abortRef = useRef<AbortController | null>(null);

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
    if (!foundModel) {
      setStreamError(t("chat.noModels"));
      return;
    }
    if (isStreaming) return;
    const model: ModelListItem = foundModel;

    const controller = new AbortController();
    abortRef.current = controller;
    const isCurrentTurn = () =>
      abortRef.current === controller && !controller.signal.aborted;
    const cleanupStoppedTurn = () => releaseTurnIfCurrent(abortRef, controller, () => {
      setIsStreaming(false);
      setStreamActivityPhase("idle");
    });
    const stopIfAborted = () => {
      if (isCurrentTurn()) return false;
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
      if (stopIfAborted()) return null;
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
        onPersistenceFailure: () => {
          if (isCurrentTurn()) setPersistNotice(t("chat.persistFailed"));
        },
      });
      if (persistedTurn.aborted || stopIfAborted()) return null;
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
        applySnapshot: (snapshot) => {
          if (isCurrentTurn()) applyWorkflowSnapshot(snapshot);
        },
        abortSignal: controller.signal,
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
        isCurrentTurn,
        releaseTurnState: cleanupStoppedTurn,
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
        isCurrentTurn,
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
        if (!isCurrentTurn()) return;
        setStreamError(err instanceof Error ? err.message : t("chat.constructError"));
        cleanupStoppedTurn();
        return;
      }

      let workspacePreamble: string | null = null;
      let workflowPreamble: string | null = null;
      let skillPreamble: string | null = null;
      let projectMemoryPreamble: string | null = null;
      let crossProjectPreamble: string | null = null;
      // 2026-07-18 写权限双层重构：权限档不再被"检测到写意图"临时升级——resolveWriteGuardRuntime
      // 现在只做提示，不改权限档位本身，effectivePermissionMode 恒等于入参 permissionMode，
      // 后面直接用 permissionMode 即可，不再需要从返回值里取。
      await resolveWriteGuardRuntime({
        text,
        decision: cacheIntent,
        workspacePath: effectiveWorkspace,
        permissionMode,
        assistantId,
        labels: {
          noWorkspace: t("chat.writeGuardNotice.noWorkspace"),
          readOnly: t("chat.writeGuardNotice.readOnly"),
          dynamicModelPool: t("chat.workPanel.dynamicModelPool"),
        },
        setMessages,
      });
      if (stopIfAborted()) return;

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
      if (stopIfAborted()) return;
      const selectedSkill = selectSkillForTurn({
        text,
        workflowSnapshot: activeTurnWorkflowSnapshot,
        intentDecision: cacheIntent,
        activeSkills: activeSkillDefs,
      });

      const includeWriteTools = shouldExposeWriteTools(permissionMode);
      const workspaceRuntime = await prepareChatWorkspaceRuntime({
        workspacePath: effectiveWorkspace,
        primaryIsCli,
        includeWriteTools,
        conversationId: convId,
        assistantId,
        permissionMode,
        requestConfirm,
        requestAskUser,
        stopIfAborted,
        modelName: model.name,
        activeCaps,
      });
      if (workspaceRuntime.aborted) return;
      const tools = workspaceRuntime.tools;
      prep.tools = tools;
      workspacePreamble = workspaceRuntime.workspacePreamble;
      const desktopPath = workspaceRuntime.desktopPath;

      const desktopPlan = await readDesktopPlanForExecution({
        userText: text,
        desktopPath,
        fs: getFsAdapter(),
      });
      if (stopIfAborted()) return;
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
        if (stopIfAborted()) return;
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
        if (stopIfAborted()) return;
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
      // 阶段5 Playbook 断点③（2026-07-17 接线）：记录本轮注入的记忆（last_used_at 加权数据源），
      // 并把条目交给 WorkPanel 赞踩列表。旁路 fire-and-forget，失败不阻塞发送。
      setUsedPlaybookMemories(memoryPreambles.usedMemories);
      if (memoryPreambles.usedMemoryIds.length > 0) {
        void recordMemoriesUsed(memoryPreambles.usedMemoryIds);
      }

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
        abortSignal: controller.signal,
        labels: {
          fileTooLarge: (name) => t("chat.attachments.fileTooLarge", { name }),
          contextTrimmed: (count) => t("chat.contextTrimmed", { count }),
        },
        // 诊断可见性（2026-08-05）：长对话触发压缩时短暂显示「正在压缩历史」，让用户知道
        // 这一拍在干什么、不是卡死。stream-runtime 拿到首字后会把它切回 checking/streaming。
        onCompressStart: () => {
          if (isCurrentTurn()) setStreamActivityPhase("compressing");
        },
      });
      if (stopIfAborted()) return;
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
        if (streamingResult.aborted) return;
        const finalized = await finalizeStreamedChatTurn({
          text,
          assistantId,
          assistantMessage: assistantMsg,
          streamingResult,
          conversationId: convId,
          projectId: currentProjectId,
          // 阶段5 Playbook（2026-07-17 复检 MEDIUM 修复）：pipeline 后台跑完立刻通知 UI refetch，
          // 不用等用户发下一条消息才看到本轮产生的候选/裁决条目。
          onPlaybookMemoryChange: () => setPlaybookPipelineTick((tick) => tick + 1),
          cacheEligible,
          taskRole,
          shouldCompleteWorkflowNode,
          workflowSnapshot: activeTurnWorkflowSnapshot,
          workflowRunId: turnWorkflowRunId,
          controllerAborted: controller.signal.aborted,
          persistAssistant: prep.persistAssistant,
          setMessages,
          applyWorkflowSnapshot,
        });
        finalContent = finalized.finalContent;
        setHarnessNotice(null);
        prep.finalContent = finalContent;
        prep.finalAssistantMsg = finalized.finalAssistantMsg;
      } catch (err) {
        const partialContent = streamingResult?.fullContent ?? "";
        prep.persistAssistant(partialContent, model.id);
        if (abortRef.current === controller) setHarnessNotice(null);
        if ((err as Error).name === "AbortError") {
          if (!partialContent) {
            setMessages((prev) =>
              prev.map((m) => (m.id === assistantId ? { ...m, content: t("chat.stopped") } : m)),
            );
          }
          return;
        }
        // Stop 后新一轮可能已经接管 abortRef。旧轮的晚到错误不能覆盖新轮的全局错误状态。
        if (abortRef.current !== controller) return;
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
        const released = cleanupStoppedTurn();
        if (released && convId) {
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
    // 关键修复（2026-08-05，兜底 Stop）：原 handleStop 只重置了 isStreaming，没重置 drainingRef。
    // 某轮若因 await 挂死（确认弹窗没 resolve / 辅助 LLM 调用超时，B2/B3），drainingRef 永久卡
    // true，导致此后所有消息在 usePendingSendDrain 里被静默丢弃——"点停止也没用"。这里显式
    // 解锁闸门，配合 ChatPage 的 stopAll（同时 forceResolve 掉挂起的确认/追问），保证一键解开。
    drainVersionRef.current += 1;
    drainingRef.current = false;
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
    drainVersionRef,
    isStreaming,
    onError: (error) => {
      setStreamError(error instanceof Error ? error.message : t("chat.constructError"));
    },
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
    usedPlaybookMemories,
    playbookPipelineTick,
  };
}
