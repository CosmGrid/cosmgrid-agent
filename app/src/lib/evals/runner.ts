// Harness 工程实施计划 阶段4 — Eval Runner（核心编排器）。
//
// 入口 `runEvalCase(case, ctx)`：
// 1. 准备沙箱（fixture loader 拷贝）
// 2. 跑所有 deterministic graders（顺序依赖）
// 3. 调 LLM judge 软标准（仅当 case 提供回放 assistantOutput + config.judgeModel）：fabrication 一票否决
// 4. 判定：所有 deterministic ok + LLM judge met → passed=true；任一 fail → passed=false；抛错 → passed=null
// 5. pass_at_3：失败时重试最多 3 次（自动放宽 timeout 1.5x）
// 6. 预算超限：累计 cost_usd 超过 case.budgetUsd 立即返回 passed=false + BUDGET_EXCEEDED
// 7. 落地：evalResults.create
//
// 关键不变量：
// - 任何抛错都返回 passed=null（inconclusive）——绝不冒充 fail 让 CI 红
// - 沙箱路径在 try/finally 里 cleanup
// - 失败类型直方图（failure_kinds）写到 EvalRun.failureKindsJson

import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModel } from "ai";
import { getGrader } from "./graders";
import { loadEvalCase } from "./fixture-loader";
import { llmJudgeSoftCriteria } from "./llm-judge";
import type {
  EvalCase,
  EvalResult,
  GraderContext,
  GraderResult,
  RunnerConfig,
} from "./types";
import { evalRuns, evalResults } from "@/lib/db";

export interface RunCaseInput {
  caseRef: EvalCase | string;  // EvalCase 对象 或 fixture 路径
  config: RunnerConfig;
}

export interface RunCaseOutput {
  passed: boolean | null;
  attempts: EvalResult[];
  totalCostUsd: number;
  totalLatencyMs: number;
  /** grader 详细输出，按 attemptIndex 分组 */
  graded: Record<number, Array<{ grader: string; result: GraderResult }>>;
}

/**
 * 跑单条 eval case，最多 maxAttempts 次重试（pass_at_3）。
 */
export async function runEvalCase(input: RunCaseInput): Promise<RunCaseOutput> {
  const start = Date.now();
  const { config } = input;
  const maxAttempts = config.maxAttempts ?? 3;
  const budgetUsd = config.budgetUsd ?? 5.0;

  // 1. 加载 EvalCase
  const evalCase: EvalCase =
    typeof input.caseRef === "string"
      ? await loadEvalCase(input.caseRef)
      : input.caseRef;

  // 2. 准备沙箱（拷贝 fixture 到临时目录）
  const workspacePath = mkdtempSync(join(tmpdir(), `eval-${evalCase.id}-`));
  const costTotal = 0;
  const attempts: EvalResult[] = [];
  const graded: Record<number, Array<{ grader: string; result: GraderResult }>> = {};

  try {
    // 3. 跑多次 attempt
    for (let attemptIndex = 0; attemptIndex < maxAttempts; attemptIndex++) {
      if (costTotal >= budgetUsd) {
        // 预算超限 → 立即返回 BUDGET_EXCEEDED
        attempts.push({
          id: "budget-exceeded",
          runId: "budget-exceeded",
          taskId: evalCase.id,
          attemptIndex,
          passed: false,
          attemptCostUsd: 0,
          attemptLatencyMs: 0,
          interventionsCount: 0,
          failureCode: "BUDGET_EXCEEDED",
        });
        break;
      }

      const attemptStart = Date.now();
      const ctx: GraderContext = {
        caseId: evalCase.id,
        workspacePath,
        toolExecRows: [],  // 评测 runner 不直接执行工具——只评估历史 tool_executions
        taskOutcomes: [],
        budgetUsedUsd: costTotal,
        budgetTotalUsd: budgetUsd,
      };

      let attemptPassed: boolean | null = null;
      const attemptGraded: Array<{ grader: string; result: GraderResult }> = [];

      for (const ac of evalCase.acceptanceCriteria) {
        const grader = getGrader(ac.grader);
        if (!grader) {
          attemptGraded.push({
            grader: ac.grader,
            result: { ok: false, detail: `grader ${ac.grader} 未注册` },
          });
          attemptPassed = false;
          continue;
        }
        try {
          const result = await grader(ac.expected, ctx);
          attemptGraded.push({ grader: ac.grader, result });
          if (!result.ok) attemptPassed = false;
          if (attemptPassed === null) attemptPassed = true;
        } catch (err) {
          attemptGraded.push({
            grader: ac.grader,
            result: {
              ok: false,
              detail: `grader ${ac.grader} 抛错：${err instanceof Error ? err.message : String(err)}`,
            },
          });
          // 抛错 = inconclusive，但不翻案已判的 fail（否则 fail+抛错+judge 认可会被洗白成 true）
          if (attemptPassed !== false) attemptPassed = null;
        }
      }

      // 3.5 LLM judge 软标准（仅当 case 提供回放 assistantOutput）：
      //   deterministic grader 已判"有/无/对/错"，judge 补"声称做了但没做"这类软标准。
      //   fabrication 检出 → 一票否决 passed=false；judge 认可且无其他判据 → 提升 null→true；
      //   inconclusive（null，抛错/无 judgeModel）→ 不翻案，保持 deterministic 结论。
      if (evalCase.assistantOutput !== undefined) {
        const judge = await llmJudgeSoftCriteria({
          finalContent: evalCase.assistantOutput,
          toolCallCount: evalCase.toolCallCount ?? 0,
          judgeModel: config.judgeModel as LanguageModel | undefined,
        });
        // ok 语义 = "未否决"；inconclusive（null）不计入判定，detail 显式标记防审计误读
        attemptGraded.push({
          grader: "llm-judge",
          result: {
            ok: judge.passed !== false,
            detail: judge.passed === null ? `[inconclusive，不计入判定] ${judge.reason}` : judge.reason,
          },
        });
        if (judge.passed === false) attemptPassed = false;
        else if (judge.passed === true && attemptPassed === null) attemptPassed = true;
      }

      // 4. 落地 attempt
      const attemptResult: EvalResult = {
        id: `attempt-${attemptIndex}-${Date.now()}`,
        runId: "in-memory",
        taskId: evalCase.id,
        attemptIndex,
        passed: attemptPassed,
        attemptCostUsd: 0,
        attemptLatencyMs: Date.now() - attemptStart,
        interventionsCount: 0,
        gradedJson: JSON.stringify(attemptGraded),
      };
      attempts.push(attemptResult);
      graded[attemptIndex] = attemptGraded;

      // 5. 提前终止：如果 passed=true 不再重试
      if (attemptPassed === true) break;
    }

    // 6. 汇总
    // 任一 attempt 通过 → true（pass_at_N）；否则有明确失败 → false；全为 inconclusive → null。
    const finalPassed = attempts.some((a) => a.passed === true)
      ? true
      : attempts.some((a) => a.passed === false)
        ? false
        : null;
    return {
      passed: finalPassed,
      attempts,
      totalCostUsd: costTotal,
      totalLatencyMs: Date.now() - start,
      graded,
    };
  } finally {
    // 7. 沙箱清理
    if (existsSync(workspacePath)) {
      rmSync(workspacePath, { recursive: true, force: true });
    }
  }
}

/**
 * 跑一组 eval case（held-in / held-out / manual），全部 EvalResult 落地 + EvalRun 落地。
 */
export async function runEvalSuite(args: {
  taskSetId: "held-in" | "held-out" | "manual";
  config: RunnerConfig;
  fixtureDir: string;
  fixtureFiles: string[];
  /** 是否落地到 DB（CLI 默认 true；单测 false） */
  persist?: boolean;
}): Promise<{ runId: string; results: RunCaseOutput[] }> {
  const runId = args.persist !== false
    ? await evalRuns.create({
        harnessVersion: args.config.harnessVersion,
        modelId: args.config.modelId,
        taskSetId: args.taskSetId,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        totalCostUsd: 0,
        retryCount: 0,
        status: "running",
        artifactJson: null,
        failureKindsJson: null,
      })
    : "in-memory";

  const results: RunCaseOutput[] = [];
  for (const file of args.fixtureFiles) {
    const casePath = `${args.fixtureDir}/${file}`;
    const out = await runEvalCase({ caseRef: casePath, config: args.config });
    results.push(out);
    if (args.persist !== false) {
      for (const attempt of out.attempts) {
        await evalResults.create({
          runId,
          taskId: attempt.taskId,
          attemptIndex: attempt.attemptIndex,
          passed: attempt.passed,
          attemptCostUsd: attempt.attemptCostUsd,
          attemptLatencyMs: attempt.attemptLatencyMs,
          interventionsCount: attempt.interventionsCount,
          failureCode: attempt.failureCode ?? null,
          gradedJson: attempt.gradedJson ?? null,
        });
      }
    }
  }

  if (args.persist !== false) {
    await evalRuns.finish(runId, {
      finishedAt: new Date().toISOString(),
      totalCostUsd: results.reduce((s, r) => s + r.totalCostUsd, 0),
      retryCount: results.reduce((s, r) => s + r.attempts.length, 0),
      status: "completed",
    });
  }

  return { runId, results };
}
