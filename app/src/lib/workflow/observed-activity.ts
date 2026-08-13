// 工作流"实际动作可视化"阶段1（2026-07-18）—— 观测层纯函数。
//
// 背景：右侧 ChainNodeGraph 的"当前位置"一直靠事前猜意图（intent/currentNodeId），经常跟
// AI 这一回合实际调了什么工具对不上。这里新增一个非权威的"观测字段"：回合结束时，根据
// 本轮真实调用的工具类型算出"这轮主要活动是读/写/命令"，只用于展示层加视觉态，
// **绝不**替代/影响 currentNode、node.status、run.status 等权威状态机。
//
// 规则（架构师评审定案，不要自由发挥扩大范围）：
//   - 只统计 status !== "denied" 的行（被拒的工具没真发生）。
//   - read-path → 归到 "read_project"；write-path → 归到 "execute"；
//     command（bash）→ 不细分 verify，也归到 "execute"（bash 区分不出测试/辅助命令，
//     解析命令字符串猜 verify 是被明确禁止的 whack-a-mole）；none → 忽略（remember/
//     todo_write/ask_user_question 等无观测意义）。
//   - dominant：write-path 是最强信号——本轮只要出现过写文件，dominant = "execute"；
//     否则若出现过 read-path，dominant = "read_project"；都没有（0 有效工具/纯对话/
//     只有 none 类工具）→ dominant = null。
//     注意：单独出现 command（bash）而没有 write-path/read-path 时，dominant 按此优先级
//     链落到 null——这是字面遵照架构师原始表述（"write-path 是最强信号...否则若有
//     read-path...都没有→null"，没有把 command 单列进 dominant 判定），command 只影响
//     `phases` 桶而不参与 dominant 的强弱排序。如后续想让"纯 bash 一轮"也点亮 execute
//     节点，需要架构师再拍板扩这条规则。
import { TOOL_NAME_SECURITY_KIND } from "@/lib/llm/capability-registry";
import type { WorkflowPhase } from "./types";

export interface ObservedToolRow {
  toolName: string;
  status: string;
}

export interface ObservedActivity {
  phases: WorkflowPhase[];
  dominant: WorkflowPhase | null;
}

/** phases 数组的输出顺序固定，不随输入行顺序变化，便于测试断言与展示层稳定渲染。 */
const PHASE_OUTPUT_ORDER: WorkflowPhase[] = ["read_project", "execute"];

export function deriveObservedActivity(rows: ObservedToolRow[]): ObservedActivity {
  let sawWritePath = false;
  let sawReadPath = false;
  const phaseSet = new Set<WorkflowPhase>();

  for (const row of rows) {
    if (row.status === "denied") continue; // 被拒的工具没真发生，排除

    const kind = TOOL_NAME_SECURITY_KIND[row.toolName];
    if (kind === "write-path") {
      sawWritePath = true;
      phaseSet.add("execute");
    } else if (kind === "command") {
      phaseSet.add("execute");
    } else if (kind === "read-path") {
      sawReadPath = true;
      phaseSet.add("read_project");
    }
    // kind === "none"（或未知工具名）：无观测意义，忽略
  }

  const dominant: WorkflowPhase | null = sawWritePath ? "execute" : sawReadPath ? "read_project" : null;

  return {
    phases: PHASE_OUTPUT_ORDER.filter((phase) => phaseSet.has(phase)),
    dominant,
  };
}
