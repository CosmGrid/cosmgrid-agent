import { describe, expect, it, vi } from "vitest";
import { requireCommandAuthorizationAsV2 } from "../confirm";
import type { ToolContext, ToolConfirmRequest } from "../types";

const request: ToolConfirmRequest = { toolName: "bash", summary: "run pwd" };

function commandContext(requestHumanConfirm: NonNullable<NonNullable<ToolContext["commandAuthorization"]>["requestHumanConfirm"]>): ToolContext {
  return {
    workspacePath: "/ws",
    commandAuthorization: { permissionMode: "confirm", requestHumanConfirm },
  };
}

describe("requireCommandAuthorizationAsV2", () => {
  it("遗留第四参数不能绕过真人确认：callback=false 仍调用一次并拒绝", async () => {
    const requestHumanConfirm = vi.fn().mockResolvedValue(false);

    const result = await Reflect.apply(
      requireCommandAuthorizationAsV2,
      undefined,
      [commandContext(requestHumanConfirm), request, "denied", true],
    );

    expect(requestHumanConfirm).toHaveBeenCalledTimes(1);
    expect(result?.status).toBe("denied");
  });
});
