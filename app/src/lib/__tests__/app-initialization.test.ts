import { describe, expect, it, vi } from "vitest";
import { initializeApp } from "@/lib/app-initialization";

function dependencies() {
  return {
    initSchema: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    seedBuiltInTemplates: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    seedBuiltinSkills: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    warn: vi.fn(),
  };
}

describe("initializeApp", () => {
  it("returns an error when schema initialization fails", async () => {
    const deps = dependencies();
    const error = new Error("schema failed");
    deps.initSchema.mockRejectedValue(error);

    await expect(initializeApp(deps)).resolves.toEqual({ ok: false, error });
    expect(deps.seedBuiltInTemplates).not.toHaveBeenCalled();
    expect(deps.seedBuiltinSkills).not.toHaveBeenCalled();
    expect(deps.warn).not.toHaveBeenCalled();
  });

  it("returns an error when built-in template seeding fails", async () => {
    const deps = dependencies();
    const error = new Error("template failed");
    deps.seedBuiltInTemplates.mockRejectedValue(error);

    await expect(initializeApp(deps)).resolves.toEqual({ ok: false, error });
    expect(deps.seedBuiltinSkills).not.toHaveBeenCalled();
    expect(deps.warn).not.toHaveBeenCalled();
  });

  it("warns and continues when built-in skill seeding fails", async () => {
    const deps = dependencies();
    const error = new Error("skill failed");
    deps.seedBuiltinSkills.mockRejectedValue(error);

    await expect(initializeApp(deps)).resolves.toEqual({ ok: true });
    expect(deps.warn).toHaveBeenCalledWith(error);
  });

  it("returns success when schema and all seeds succeed", async () => {
    const deps = dependencies();

    await expect(initializeApp(deps)).resolves.toEqual({ ok: true });
    expect(deps.initSchema).toHaveBeenCalledOnce();
    expect(deps.seedBuiltInTemplates).toHaveBeenCalledOnce();
    expect(deps.seedBuiltinSkills).toHaveBeenCalledOnce();
    expect(deps.warn).not.toHaveBeenCalled();
  });
});
