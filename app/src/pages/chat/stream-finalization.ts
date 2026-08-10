import type { Dispatch, SetStateAction } from "react";
import { toolExecutions, workflowRuns } from "@/lib/db";
import { writeCache } from "@/lib/llm/semantic-cache";
import type { StreamUsage } from "@/lib/llm/chat-fallback";
import { completeCurrentWorkflowNode, failCurrentWorkflowNode, markCurrentWorkflowNodeNeedsUser, repairCurrentWorkflowNode } from "@/lib/workflow/reducer";
import { verifyNodeOutcome, applyVerifyRepairLoop } from "@/lib/workflow/node-verifier";
import { verifyTask } from "@/lib/llm/evidence/task-verifier";
import { VERIFY_ACCEPTANCE_CRITERIA } from "@/lib/llm/evidence/verify-acceptance-criteria";
import { reportTaskOutcome, nodeOutcomeToTaskOutcome } from "@/lib/evals/task-outcome-reporter";
import type { VerificationResult } from "@/lib/llm/evidence/types";
import type { WorkflowSnapshot } from "@/lib/workflow/types";
import type { ChatMessage } from "@/pages/chat/types";

interface StreamingFinalizationResult {
  fullContent: string;
  lastModelId: string | null;
  lastResultModelId?: string;
  lastUsage?: StreamUsage;
  lastToolCallCount: number;
  /** Harness 工程实施计划阶段1：本轮最终 Harness 判定，供节点验收门控消费。 */
  harnessDirty: boolean;
}

type PersistAssistant = (
  content: string,
  modelId: string | null,
  usage?: { inputTokens: number; outputTokens: number },
  kind?: ChatMessage["kind"],
  toolCallCount?: number | null,
) => void;

export interface FinalizeStreamedChatTurnArgs {
  text: string;
  assistantId: string;
  assistantMessage: ChatMessage;
  streamingResult: StreamingFinalizationResult;
  conversationId: string | null;
  cacheEligible: boolean;
  taskRole: string;
  shouldCompleteWorkflowNode: boolean;
  workflowSnapshot: WorkflowSnapshot | null;
  workflowRunId: string | null;
  controllerAborted: boolean;
  persistAssistant: PersistAssistant;
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  applyWorkflowSnapshot: (snapshot: WorkflowSnapshot | null) => void;
  /**
   * 后台验收（runWorkflowVerificationInBackground）在 finalizeStreamedChatTurn 已经
   * resolve、isStreaming 已归位之后还会继续跑一段时间（toolExecutions 查询 + verifyTask）。
   * 这段时间内用户完全可能已经切换到另一个会话——而 applyWorkflowSnapshot 写的是
   * useOrchestration 里那个全局 workflowSnapshotRef/state，不按 conversationId 分片。
   * 不传这个 ref 校验的话，跑完的旧会话验收结果会直接覆盖用户当前正在看的新会话快照。
   */
  conversationIdRef: { current: string | null };
}

export interface FinalizedStreamedChatTurn {
  finalContent: string;
  finalAssistantMsg: ChatMessage;
}

// 2026-07-15 review 修复：原来这整段工作流验收（listByMessage/listByConversation 查询 +
// verifyTask 细对账 + workflowRuns.saveSnapshot）都在 finalizeStreamedChatTurn 的主 await
// 链路里，而调用方（useChatStream.ts）要等这个函数整个 resolve 才会把 isStreaming 置回
// false——用户看到的现象是：回复文字已经完整显示完了，但输入框/停止键仍然卡在"进行中"，
// 直到这串验收链跑完才解锁，会话历史越大这条延迟越明显（toolExecutions.listByConversation
// 无上限扫描）。
//
// 这段逻辑的所有产出（applyWorkflowSnapshot / reportTaskOutcome）都是通过参数里的回调
// 写回去的副作用，不影响 finalizeStreamedChatTurn 自己的返回值（finalContent/
// finalAssistantMsg 在这段逻辑跑之前就已经算好了）——可以安全地整段拆出去后台跑
// （fire-and-forget，不 await），不用等它跑完就让 isStreaming 归位。
async function runWorkflowVerificationInBackground(
  args: FinalizeStreamedChatTurnArgs,
  finalContent: string,
): Promise<void> {
  if (
    !(
      args.conversationId &&
      args.shouldCompleteWorkflowNode &&
      args.workflowSnapshot &&
      args.workflowRunId &&
      finalContent &&
      !args.controllerAborted
    )
  ) {
    return;
  }
  // 这段后台验收横跨多个 await（listByMessage/listByConversation/verifyTask/
  // saveSnapshot），跑完时用户完全可能已经切到别的会话。DB 落库（saveSnapshot）记录的是
  // 这个 workflow run 自己的真实结果，跟用户当前在看哪个会话无关，原样跑；但
  // applyWorkflowSnapshot 写的是全局 UI 状态，只在用户还停留在发起这轮验收的会话时才应用，
  // 否则会把旧会话验收完的快照糊到用户当前正在看的新会话上。
  const applySnapshotIfStillActive = (snapshot: WorkflowSnapshot | null) => {
    if (args.conversationIdRef.current === args.conversationId) {
      args.applyWorkflowSnapshot(snapshot);
    }
  };
  // 2026-07-16 review 修复：这里在跑上面一大段慢验收（toolExecutions 查询 + verifyTask）
  // 之前先记下这个 run 当时的 snapshot_version——如果这段时间内用户已经发了下一条消息、
  // prepareTurnWorkflow 更快推进了同一个 run，version 会被推高；下面的 saveSnapshot 调用
  // 带上这个 expectedVersion 做乐观锁比对，版本不匹配就放弃这次陈旧写入，不会把用户已经
  // 推进的新状态覆盖回旧状态。读失败（比如 DB 不可用）时 expectedVersion 为 undefined，
  // 退化成原有的无条件写入行为，不阻塞正常流程。
  const expectedVersion = await workflowRuns
    .getById(args.workflowRunId)
    .then((run) => run?.snapshotVersion)
    .catch(() => undefined);
  try {
      const currentNode = args.workflowSnapshot.nodes.find(
        (n) => n.id === args.workflowSnapshot!.currentNodeId,
      );
      // Harness 工程实施计划阶段1：本轮是否有工具被用户拒绝（denied），据此判定 needs_user，
      // 不能把"用户不同意写"当成"验收失败"处理。查失败不阻塞正常完成路径。
      const userDeniedPermission = await toolExecutions
        .listByMessage(args.assistantId)
        .then((rows) => rows.some((row) => row.status === "denied"))
        .catch(() => false);
      // Harness 工程实施计划阶段1：不再是"非空回复就完成"——先跑独立验收器，
      // 只有 passed 才真的把节点标 done；harnessDirty/无工具证据时 failed，
      // verify 阶段 failed 且未达修复上限时降级成 retryable 打回 execute 重来，
      // 写 workflow.node_failed_verification / node_repair_retry / node_blocked 事件。
      // 2026-07-14：outcome 从 const 改 let——细对账（verifyTask）在 verify 阶段判定
      // "fails" 时，会把这个粗筛结果就地降级成 retryable/blocked（见下方），复用同一套
      // MAX_REPAIR_ATTEMPTS 上限，不另开一条不受控的重试路径。
      let outcome = currentNode
        ? verifyNodeOutcome({
            phase: currentNode.phase,
            harnessDirty: args.streamingResult.harnessDirty,
            toolCallCount: args.streamingResult.lastToolCallCount,
            hasSummary: finalContent.length > 0,
            userDeniedPermission,
            repairAttempts: currentNode.repairAttempts ?? 0,
          })
        : null;

      // 阶段3：粗筛（verifyNodeOutcome）通过后再跑细对账（verifyTask）。
      // 错误降级策略：任何抛错都返回 status='inconclusive' + humanSummary 提示
      // "证据加载失败"——绝不因证据系统故障让用户回答"失败"。
      // 关键不变量：粗筛和细对账 failureCode 命名空间区分（粗筛：harness_dirty /
      // no_tool_evidence / empty_output；细对账：evidence_contradicts /
      // evidence_insufficient / evidence_truncated）。
      let verification: VerificationResult | undefined;
      let evidenceIds: string[] = [];
      if (currentNode && outcome?.status === "passed") {
        try {
          const allRows = await toolExecutions.listByConversation(args.conversationId ?? "");
          // StreamingFinalizationResult 暂未带 turnStartedAt；用"5 分钟前"作 sinceIso
          // 兜底窗口——同 selectRowsForMessage 默认窗口一致。
          const sinceIso = new Date(Date.now() - 5 * 60_000).toISOString();
          // 2026-07-14：只在 verify 阶段传真实的结构化验收标准（VERIFY_ACCEPTANCE_CRITERIA，
          // 三态判定见 structured-criteria.ts —— tests_pass 严格，lint/build 宽松，没跑不算错）。
          // 其它阶段仍传空数组：verifyTask 只跑声明 ↔ 证据对账，不跑结构化验收，
          // conflicts 仍能捕获模型自报数字与 bash 输出的不一致。
          verification = verifyTask({
            finalContent,
            execRows: allRows,
            assistantMessageId: args.assistantId,
            sinceIso,
            acceptanceCriteria: currentNode.phase === "verify" ? VERIFY_ACCEPTANCE_CRITERIA : [],
            workflowRef: { runId: args.workflowRunId, nodeId: currentNode.id },
          });
          evidenceIds = verification.decisionEvidenceIds;
        } catch {
          // 证据加载失败降级 inconclusive（不阻塞主流程）
          verification = {
            status: "inconclusive",
            metCriteria: [],
            failedCriteria: [],
            linkedClaims: [],
            conflicts: [],
            decidedAt: new Date().toISOString(),
            decisionEvidenceIds: [],
            humanSummary: "证据加载失败，请人工复核。",
          };
        }

        // 2026-07-14：真门控——只在 verify 阶段、且细对账判定 fails 时才把粗筛结果就地
        // 降级。inconclusive（证据看不清）故意不在这里触发重试，跟粗筛"看不清就不惩罚"
        // 的一贯原则一致；只有明确 fails（真的有验收标准没过）才打回。
        // failureCode 用独立命名空间（acceptance_criteria_failed），跟粗筛的
        // harness_dirty/no_tool_evidence/empty_output 区分开，方便从事件日志分辨
        // 是粗筛拦的还是细对账拦的。
        if (currentNode.phase === "verify" && verification?.status === "fails") {
          outcome = applyVerifyRepairLoop(
            {
              status: "failed",
              summary: verification.humanSummary,
              evidenceIds: verification.decisionEvidenceIds,
              artifactIds: outcome?.artifactIds ?? [],
              toolExecutionIds: outcome?.toolExecutionIds ?? [],
              failureCode: "acceptance_criteria_failed",
              retryHint: "根据验证结果修复真实问题（如修好 lint/测试失败）后再验证，不要只在文字里声称已修复。",
            },
            { phase: currentNode.phase, repairAttempts: currentNode.repairAttempts ?? 0 },
          );
        }
      }

      if (!outcome || outcome.status === "passed") {
        const nextWorkflow = completeCurrentWorkflowNode({
          snapshot: args.workflowSnapshot,
          summary: finalContent.slice(0, 1200),
          evidenceIds,
          verification,
        });
        const { applied } = await workflowRuns.saveSnapshot({
          runId: args.workflowRunId,
          snapshot: nextWorkflow,
          eventType: "workflow.node_completed",
          eventPayload: {
            nodeId: args.workflowSnapshot.currentNodeId,
            summaryPreview: finalContent.slice(0, 240),
            // Harness 工程实施计划阶段1 退出标准："所有节点完成事件都有 NodeOutcome"。
            // outcome 在没有 currentNode 时兜底为 null（极端边界），此时事件仍然落地，
            // 只是没有 outcome 字段可附。
            ...(outcome ? { outcome } : {}),
            ...(verification ? { verificationSummary: verification.humanSummary } : {}),
          },
          expectedVersion,
        });
        if (applied) applySnapshotIfStillActive(nextWorkflow);
      } else if (outcome.status === "retryable") {
        const nextWorkflow = repairCurrentWorkflowNode({ snapshot: args.workflowSnapshot, outcome });
        const { applied } = await workflowRuns.saveSnapshot({
          runId: args.workflowRunId,
          snapshot: nextWorkflow,
          eventType: "workflow.node_repair_retry",
          eventPayload: {
            nodeId: args.workflowSnapshot.currentNodeId,
            failureCode: outcome.failureCode,
            repairAttempts: (currentNode?.repairAttempts ?? 0) + 1,
            summaryPreview: finalContent.slice(0, 240),
          },
          expectedVersion,
        });
        if (applied) applySnapshotIfStillActive(nextWorkflow);
      } else if (outcome.status === "failed" || outcome.status === "blocked") {
        const nextWorkflow = failCurrentWorkflowNode({ snapshot: args.workflowSnapshot, outcome });
        const { applied } = await workflowRuns.saveSnapshot({
          runId: args.workflowRunId,
          snapshot: nextWorkflow,
          eventType: outcome.status === "blocked" ? "workflow.node_blocked" : "workflow.node_failed_verification",
          eventPayload: {
            nodeId: args.workflowSnapshot.currentNodeId,
            failureCode: outcome.failureCode,
            summaryPreview: finalContent.slice(0, 240),
          },
          expectedVersion,
        });
        if (applied) applySnapshotIfStillActive(nextWorkflow);
      } else if (outcome.status === "needs_user") {
        // 2026-07-15 review 修复：不落新事件（跟原设计一致，等用户下一步指示），但节点自己
        // 的 status 要如实改成 "waiting_user"，否则 WorkPanel 会一直把它渲染成"进行中"，
        // 跟真实"已经停下来等你"的状态对不上。不传 eventType 给 saveSnapshot，只落
        // snapshot_json（不写审计事件行），语义上仍然是"没有新事件"。
        const nextWorkflow = markCurrentWorkflowNodeNeedsUser({ snapshot: args.workflowSnapshot });
        const { applied } = await workflowRuns.saveSnapshot({
          runId: args.workflowRunId,
          snapshot: nextWorkflow,
          expectedVersion,
        });
        if (applied) applySnapshotIfStillActive(nextWorkflow);
      }

      // 阶段4：上报 task_outcomes（Eval Harness 11 指标聚合的源）
      if (args.conversationId && currentNode) {
        const taskOutcomeStatus = outcome?.status ?? "passed";  // outcome 为 null 时按 passed 兜底
        const mapped = nodeOutcomeToTaskOutcome(taskOutcomeStatus);
        void reportTaskOutcome({
          conversationId: args.conversationId,
          nodeId: currentNode.id,
          outcome: mapped.outcome,
          interventionKind: mapped.interventionKind ?? undefined,
          finalSummary: finalContent.slice(0, 200),
        });
      }
  } catch {
    // workflow 状态更新失败不影响正常回答
  }
}

export async function finalizeStreamedChatTurn(
  args: FinalizeStreamedChatTurnArgs,
): Promise<FinalizedStreamedChatTurn> {
  const finalContent = args.streamingResult.fullContent;
  args.setMessages((prev) =>
    prev.map((message) =>
      message.id === args.assistantId
        ? { ...message, toolCallCount: args.streamingResult.lastToolCallCount }
        : message,
    ),
  );
  args.persistAssistant(
    finalContent,
    args.streamingResult.lastModelId,
    args.streamingResult.lastUsage,
    undefined,
    args.streamingResult.lastToolCallCount,
  );

  // fire-and-forget：不 await，回复文字显示完、消息落库后就能让调用方把 isStreaming
  // 归位，工作流验收/审计在后台继续跑，跑完后通过 args.applyWorkflowSnapshot/setMessages
  // 这些回调自己更新状态。
  void runWorkflowVerificationInBackground(args, finalContent);

  if (args.cacheEligible && finalContent && !args.controllerAborted) {
    void Promise.resolve(
      writeCache(
        args.text,
        finalContent,
        args.streamingResult.lastResultModelId ?? args.streamingResult.lastModelId ?? "",
        args.taskRole,
      ),
    ).catch(() => {});
  }

  return {
    finalContent,
    finalAssistantMsg: { ...args.assistantMessage, content: finalContent },
  };
}
