import { describe, expect, it, vi } from "vitest";
import { createSequentialRequestQueue } from "../sequential-request-queue";

describe("createSequentialRequestQueue", () => {
  it("keeps consecutive requests in order without replacing the active resolver", async () => {
    const onCurrentChange = vi.fn();
    const queue = createSequentialRequestQueue<string, boolean>(onCurrentChange);

    const first = queue.request("first");
    const second = queue.request("second");

    expect(queue.current()).toBe("first");
    expect(onCurrentChange).toHaveBeenLastCalledWith("first");

    queue.resolveCurrent(true);
    await expect(first).resolves.toBe(true);
    expect(queue.current()).toBe("second");
    expect(onCurrentChange).toHaveBeenLastCalledWith("second");

    queue.resolveCurrent(false);
    await expect(second).resolves.toBe(false);
    expect(queue.current()).toBeNull();
    expect(onCurrentChange).toHaveBeenLastCalledWith(null);
  });

  it("resolves the active request and every queued request when stopped", async () => {
    const queue = createSequentialRequestQueue<string, boolean>(() => {});
    const first = queue.request("first");
    const second = queue.request("second");
    const third = queue.request("third");

    queue.resolveAll(false);

    await expect(Promise.all([first, second, third])).resolves.toEqual([false, false, false]);
    expect(queue.current()).toBeNull();
  });

  it("supports an explicit null cancellation value for unanswered questions", async () => {
    const queue = createSequentialRequestQueue<string, string | null>(() => {});
    const answer = queue.request("which option?");

    queue.resolveAll(null);

    await expect(answer).resolves.toBeNull();
  });
});
