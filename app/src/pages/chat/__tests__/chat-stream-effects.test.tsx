/** @vitest-environment jsdom */

import { act, createElement, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePendingSendDrain } from "../chat-stream-effects";
import type { PendingSend } from "../types";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function Harness(props: {
  pendingQueue: PendingSend[];
  drainingRef: { current: boolean };
  drainVersionRef: { current: number };
  send: (text: string) => Promise<void>;
  onError: (error: unknown) => void;
}) {
  const sendRef = useRef(props.send);
  sendRef.current = props.send;
  usePendingSendDrain({
    drainingRef: props.drainingRef,
    drainVersionRef: props.drainVersionRef,
    isStreaming: false,
    pendingQueue: props.pendingQueue,
    sendRef,
    setPendingQueue: vi.fn(),
    onError: props.onError,
  });
  return null;
}

describe("usePendingSendDrain", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
      .IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("reports a rejected send and releases the drain instead of leaking an unhandled rejection", async () => {
    const error = new Error("prepare turn failed");
    const drainingRef = { current: false };
    const drainVersionRef = { current: 0 };
    const onError = vi.fn();

    await act(async () => {
      root.render(createElement(Harness, {
        pendingQueue: [{ text: "hello" }],
        drainingRef,
        drainVersionRef,
        send: vi.fn().mockRejectedValue(error),
        onError,
      }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onError).toHaveBeenCalledWith(error);
    expect(drainingRef.current).toBe(false);
  });

  it("ignores a stale turn finishing after stop and a newer send has started", async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    const send = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const drainingRef = { current: false };
    const drainVersionRef = { current: 0 };
    const onError = vi.fn();

    await act(async () => {
      root.render(createElement(Harness, {
        pendingQueue: [{ text: "first" }], drainingRef, drainVersionRef, send, onError,
      }));
    });
    expect(drainingRef.current).toBe(true);

    drainVersionRef.current += 1;
    drainingRef.current = false;
    await act(async () => {
      root.render(createElement(Harness, {
        pendingQueue: [{ text: "second" }], drainingRef, drainVersionRef, send, onError,
      }));
    });
    expect(drainingRef.current).toBe(true);

    await act(async () => first.resolve());
    expect(drainingRef.current).toBe(true);

    await act(async () => second.resolve());
    expect(drainingRef.current).toBe(false);
    expect(onError).not.toHaveBeenCalled();
  });
});
