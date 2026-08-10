import { afterEach, describe, expect, it, vi } from "vitest";
import { createAbortScope } from "../abort-scope";

describe("createAbortScope", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("inherits an already-aborted parent immediately", () => {
    const parent = new AbortController();
    parent.abort("stopped");

    const scope = createAbortScope(parent.signal, 30_000);

    expect(scope.signal.aborted).toBe(true);
    expect(scope.signal.reason).toBe("stopped");
    scope.dispose();
  });

  it("propagates a later parent cancellation", () => {
    const parent = new AbortController();
    const scope = createAbortScope(parent.signal, 30_000);

    parent.abort("cancelled later");

    expect(scope.signal.aborted).toBe(true);
    expect(scope.signal.reason).toBe("cancelled later");
    scope.dispose();
  });

  it("aborts when the timeout expires", () => {
    vi.useFakeTimers();
    const scope = createAbortScope(undefined, 50);

    vi.advanceTimersByTime(50);

    expect(scope.signal.aborted).toBe(true);
    expect(scope.signal.reason).toBeInstanceOf(DOMException);
    expect((scope.signal.reason as DOMException).name).toBe("TimeoutError");
    scope.dispose();
  });

  it("dispose removes the parent listener and timeout", () => {
    vi.useFakeTimers();
    const parent = new AbortController();
    const scope = createAbortScope(parent.signal, 50);

    scope.dispose();
    parent.abort("too late");
    vi.advanceTimersByTime(50);

    expect(scope.signal.aborted).toBe(false);
  });
});
