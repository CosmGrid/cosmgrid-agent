import { describe, expect, it, vi } from "vitest";
import { releaseTurnIfCurrent } from "../turn-ownership";

describe("releaseTurnIfCurrent", () => {
  it("releases state when the finishing controller still owns the turn", () => {
    const controller = new AbortController();
    const ownerRef = { current: controller as AbortController | null };
    const release = vi.fn();

    expect(releaseTurnIfCurrent(ownerRef, controller, release)).toBe(true);
    expect(ownerRef.current).toBeNull();
    expect(release).toHaveBeenCalledOnce();
  });

  it("ignores stale cleanup after a newer controller has taken ownership", () => {
    const stale = new AbortController();
    const current = new AbortController();
    const ownerRef = { current };
    const release = vi.fn();

    expect(releaseTurnIfCurrent(ownerRef, stale, release)).toBe(false);
    expect(ownerRef.current).toBe(current);
    expect(release).not.toHaveBeenCalled();
  });
});
