import { describe, expect, it } from "vitest";
import {
  classifyStructuredParts,
  projectToolExecutionForAudit,
  projectWebFetchInput,
  projectStructuredParts,
} from "../web-fetch-privacy";

const sentinels = {
  userinfo: "URL_USERINFO_SENTINEL",
  query: "URL_QUERY_SENTINEL",
  fragment: "URL_FRAGMENT_SENTINEL",
  finalUrl: "URL_FINAL_SENTINEL",
  body: "URL_BODY_SENTINEL",
};

const rawUrl = `https://${sentinels.userinfo}:secret@example.test/path?token=${sentinels.query}#${sentinels.fragment}`;

describe("web_fetch privacy projector", () => {
  it("projects URL-bearing audit input/result to fixed metadata without URL or body sentinels", () => {
    const input = projectWebFetchInput({ url: rawUrl });
    const result = projectToolExecutionForAudit(
      {
        status: "success",
        summary: `https://example.test/${sentinels.finalUrl}`,
        output: `${sentinels.finalUrl}\n${sentinels.body}`,
        artifacts: [{ kind: "url", uri: `https://example.test/${sentinels.finalUrl}`, label: sentinels.finalUrl }],
        nextActions: [{ action: "retry", reason: sentinels.body, safe: true }],
        error: { code: "TOOL_HTTP_ERROR", rootCauseHint: sentinels.body, retryable: true },
        durationMs: 12,
        userConfirmed: false,
        reversible: false,
      },
      12,
    );

    expect(JSON.stringify(input)).not.toContain("SENTINEL");
    expect(JSON.stringify(result)).not.toContain("SENTINEL");
    expect(result).toMatchObject({ version: 1, toolName: "web_fetch", status: "success", durationMs: 12 });
    expect(result).not.toHaveProperty("output");
    expect(result).not.toHaveProperty("artifacts");
    expect(result).not.toHaveProperty("error");
  });

  it("classifies nested web_fetch and mixed sequences as withheld for the whole turn", () => {
    const parts = [
      { role: "user", content: "read this" },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "call-1", toolName: "web_fetch", input: { url: rawUrl } }],
      },
      {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "call-1", toolName: "web_fetch", result: { body: sentinels.body } }],
      },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ];

    expect(classifyStructuredParts(JSON.stringify(parts))).toMatchObject({ status: "withheld" });
  });

  it("keeps safe ordinary structured history and rejects malformed non-empty history", () => {
    const safe = JSON.stringify([
      { role: "user", content: "read" },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "call-1", toolName: "read", input: { file_path: "a.ts" } }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "call-1", toolName: "read", result: "ok" }] },
    ]);

    expect(classifyStructuredParts(safe)).toMatchObject({ status: "safe" });
    expect(classifyStructuredParts("{bad json")).toMatchObject({ status: "malformed" });
    expect(classifyStructuredParts(JSON.stringify([{ role: "assistant", providerSpecific: true }]))).toMatchObject({ status: "malformed" });
    for (const unknown of [
      [{ role: "assistant", content: [{ type: "unknown", value: "x" }] }],
      [{ role: "tool", content: [{ type: "text", text: "wrong role shape" }], extra: true }],
      [{ role: "assistant", content: [] }],
      [{ role: "assistant", content: [{ type: "tool-call", toolName: "read" }] }],
    ]) {
      expect(classifyStructuredParts(JSON.stringify(unknown))).toMatchObject({ status: "malformed" });
    }
    expect(classifyStructuredParts(projectStructuredParts("{bad")!)).toMatchObject({ status: "malformed" });
    const withheld = projectStructuredParts(JSON.stringify([{ role: "assistant", content: [{ type: "tool-call", toolCallId: "w", toolName: "web_fetch", input: { url: "https://x" } }] }]))!;
    expect(classifyStructuredParts(withheld)).toMatchObject({ status: "withheld" });
    expect(classifyStructuredParts(JSON.stringify({ version: 2, kind: "web_fetch_history", status: "withheld" }))).toMatchObject({ status: "malformed" });
    expect(classifyStructuredParts(JSON.stringify({ version: 1, kind: "web_fetch_history", status: "unknown" }))).toMatchObject({ status: "malformed" });
    const nestedMarker = [{ role: "assistant", content: [{ type: "tool-call", toolCallId: "r", toolName: "read", input: { nested: [{ kind: "web_fetch_history", version: 1, status: "withheld" }] } }] }];
    expect(classifyStructuredParts(JSON.stringify(nestedMarker))).toMatchObject({ status: "withheld" });
    const nestedMalformed = [{ role: "tool", content: [{ type: "tool-result", toolCallId: "r", toolName: "read", output: { nested: { kind: "web_fetch_history", version: 1, status: "unknown" } } }] }];
    expect(classifyStructuredParts(JSON.stringify(nestedMalformed))).toMatchObject({ status: "malformed" });
    const mixedPriority = [{ role: "assistant", content: [{ type: "tool-call", toolCallId: "r", toolName: "web_fetch", input: { nested: { kind: "web_fetch_history", version: 9, status: "withheld" } } }] }];
    expect(classifyStructuredParts(JSON.stringify(mixedPriority))).toMatchObject({ status: "malformed" });
  });
});
