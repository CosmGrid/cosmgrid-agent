import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn().mockResolvedValue({ stdout: "ok", stderr: "", code: 0 }),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

const { getShellAdapter } = await import("../shell-adapter");

describe("shell adapter trusted ls", () => {
  it("invokes only run_authorized_ls with workspace and ordered operands", async () => {
    await getShellAdapter().runAuthorizedLs?.({
      workspacePath: "/workspace",
      operands: ["src", "package.json"],
    });
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    expect(mocks.invoke).toHaveBeenCalledWith("run_authorized_ls", {
      workspace: "/workspace",
      operands: ["src", "package.json"],
    });
    expect(mocks.invoke).not.toHaveBeenCalledWith("run_shell_args", expect.anything());
  });
});
