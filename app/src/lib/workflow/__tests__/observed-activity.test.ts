import { describe, expect, it } from "vitest";
import { deriveObservedActivity } from "../observed-activity";

describe("deriveObservedActivity", () => {
  it("纯 read：phases=[read_project]，dominant=read_project", () => {
    const result = deriveObservedActivity([
      { toolName: "read", status: "success" },
      { toolName: "grep", status: "success" },
    ]);
    expect(result).toEqual({ phases: ["read_project"], dominant: "read_project" });
  });

  it("read+write：write 是最强信号，dominant=execute，phases 含两者", () => {
    const result = deriveObservedActivity([
      { toolName: "read", status: "success" },
      { toolName: "write", status: "success" },
    ]);
    expect(result).toEqual({ phases: ["read_project", "execute"], dominant: "execute" });
  });

  it("read+write+bash：bash 不改变 dominant（write 仍最强），phases 仍只有两桶（bash 也归 execute，去重）", () => {
    const result = deriveObservedActivity([
      { toolName: "read", status: "success" },
      { toolName: "write", status: "success" },
      { toolName: "bash", status: "success" },
    ]);
    expect(result).toEqual({ phases: ["read_project", "execute"], dominant: "execute" });
  });

  it("0 工具：phases=[]，dominant=null", () => {
    const result = deriveObservedActivity([]);
    expect(result).toEqual({ phases: [], dominant: null });
  });

  it("全部 denied：等价于 0 有效工具，phases=[]，dominant=null", () => {
    const result = deriveObservedActivity([
      { toolName: "write", status: "denied" },
      { toolName: "read", status: "denied" },
      { toolName: "bash", status: "denied" },
    ]);
    expect(result).toEqual({ phases: [], dominant: null });
  });

  it("只有 none 类工具（remember/todo_write/ask_user_question）：无观测意义，dominant=null", () => {
    const result = deriveObservedActivity([
      { toolName: "remember", status: "success" },
      { toolName: "todo_write", status: "success" },
      { toolName: "ask_user_question", status: "success" },
    ]);
    expect(result).toEqual({ phases: [], dominant: null });
  });

  it("部分行 denied、部分成功：只统计未被拒的行", () => {
    const result = deriveObservedActivity([
      { toolName: "write", status: "denied" },
      { toolName: "read", status: "success" },
    ]);
    expect(result).toEqual({ phases: ["read_project"], dominant: "read_project" });
  });

  it("只有 bash（无 write/无 read）：phases 含 execute，但 dominant 按优先级链落到 null（字面遵照架构定案，未把 command 计入 dominant 强弱排序）", () => {
    const result = deriveObservedActivity([{ toolName: "bash", status: "success" }]);
    expect(result).toEqual({ phases: ["execute"], dominant: null });
  });

  it("未知工具名（不在静态表里）：视同无观测意义，不抛错", () => {
    const result = deriveObservedActivity([{ toolName: "some_future_tool", status: "success" }]);
    expect(result).toEqual({ phases: [], dominant: null });
  });
});
