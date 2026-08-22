import { describe, expect, it, vi } from "vitest";
import { createStageChatConfirmationController } from "../stage-chat-confirmation";

describe("StageChat command confirmation", () => {
  it("连续两个确认按顺序展示并分别 resolve，不覆盖第一个 Promise", async () => {
    const shown: string[] = [];
    const controller = createStageChatConfirmationController((request) => {
      if (request) shown.push(request.summary);
    });
    const turn = controller.beginTurn(new AbortController().signal);
    const first = turn.requestConfirm({ toolName: "bash", summary: "first" });
    const second = turn.requestConfirm({ toolName: "bash", summary: "second" });

    expect(shown).toEqual(["first"]);
    controller.resolveCurrent(true);
    await expect(first).resolves.toBe(true);
    expect(shown).toEqual(["first", "second"]);
    controller.resolveCurrent(false);
    await expect(second).resolves.toBe(false);
  });

  it("stop 同时解除当前和排队确认 Promise", async () => {
    const controller = createStageChatConfirmationController(vi.fn());
    const turn = controller.beginTurn(new AbortController().signal);
    const first = turn.requestConfirm({ toolName: "bash", summary: "first" });
    const second = turn.requestConfirm({ toolName: "bash", summary: "second" });

    controller.invalidate();
    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(false);
  });

  it("失效后旧 turn 晚到请求直接 false，不重新入队", async () => {
    const shown: string[] = [];
    const controller = createStageChatConfirmationController((request) => {
      if (request) shown.push(request.summary);
    });
    const abort = new AbortController();
    const turn = controller.beginTurn(abort.signal);
    controller.invalidate();

    await expect(turn.requestConfirm({ toolName: "bash", summary: "late" })).resolves.toBe(false);
    expect(controller.current()).toBeNull();
    expect(shown).toEqual([]);
  });

  it("开始新 turn 后旧 turn 失效，新 turn 仍可连续确认", async () => {
    const controller = createStageChatConfirmationController(vi.fn());
    const oldTurn = controller.beginTurn(new AbortController().signal);
    controller.invalidate();
    const newTurn = controller.beginTurn(new AbortController().signal);

    await expect(oldTurn.requestConfirm({ toolName: "bash", summary: "old" })).resolves.toBe(false);
    const first = newTurn.requestConfirm({ toolName: "bash", summary: "new-1" });
    const second = newTurn.requestConfirm({ toolName: "bash", summary: "new-2" });
    controller.resolveCurrent(true);
    controller.resolveCurrent(false);
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(false);
  });

  it("signal 已 aborted 时晚到请求直接 false", async () => {
    const controller = createStageChatConfirmationController(vi.fn());
    const abort = new AbortController();
    const turn = controller.beginTurn(abort.signal);
    abort.abort();

    await expect(turn.requestConfirm({ toolName: "bash", summary: "aborted" })).resolves.toBe(false);
    expect(controller.current()).toBeNull();
  });

  it("旧请求已入队时开始新 turn 会先解除旧 Promise，再允许新请求成为 current", async () => {
    const controller = createStageChatConfirmationController(vi.fn());
    const oldTurn = controller.beginTurn(new AbortController().signal);
    const old = oldTurn.requestConfirm({ toolName: "bash", summary: "old" });
    const newTurn = controller.beginTurn(new AbortController().signal);

    await expect(old).resolves.toBe(false);
    expect(controller.current()).toBeNull();
    const next = newTurn.requestConfirm({ toolName: "bash", summary: "new" });
    expect(controller.current()?.summary).toBe("new");
    controller.resolveCurrent(true);
    await expect(next).resolves.toBe(true);
  });

  it("旧 turn finish 不能清掉新 turn，当前 turn finish 后晚到请求为 false", async () => {
    const controller = createStageChatConfirmationController(vi.fn());
    const oldTurn = controller.beginTurn(new AbortController().signal);
    const newTurn = controller.beginTurn(new AbortController().signal);
    const next = newTurn.requestConfirm({ toolName: "bash", summary: "new" });

    oldTurn.finish();
    expect(controller.current()?.summary).toBe("new");
    newTurn.finish();
    await expect(next).resolves.toBe(false);
    await expect(newTurn.requestConfirm({ toolName: "bash", summary: "late" })).resolves.toBe(false);
    expect(controller.current()).toBeNull();
  });

  it("isActive 只在当前 generation 且 signal 未 abort 时为严格 true", () => {
    const controller = createStageChatConfirmationController(vi.fn());
    const oldAbort = new AbortController();
    const oldTurn = controller.beginTurn(oldAbort.signal);
    expect(oldTurn.isActive()).toBe(true);
    const newTurn = controller.beginTurn(new AbortController().signal);
    expect(oldTurn.isActive()).toBe(false);
    expect(newTurn.isActive()).toBe(true);
    oldAbort.abort();
    expect(oldTurn.isActive()).toBe(false);
    newTurn.finish();
    expect(newTurn.isActive()).toBe(false);
  });
});
