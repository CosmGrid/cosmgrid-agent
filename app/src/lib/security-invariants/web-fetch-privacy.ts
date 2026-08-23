import type { ToolResultV2 } from "@/lib/llm/tools/result-contract";

export const WEB_FETCH_PRIVACY_VERSION = 1 as const;
export const WEB_FETCH_WITHHELD_MARKER = "web_fetch_history" as const;
const SAFE_WEB_FETCH_STATUSES = new Set<ToolResultV2["status"]>(["success", "warning", "error", "denied", "timeout"]);
const SAFE_WEB_FETCH_ERROR_CODES = new Set([
  "TOOL_DENIED", "TOOL_TIMEOUT", "TOOL_NETWORK_ERROR", "TOOL_HTTP_ERROR", "TOOL_INVALID_URL", "TOOL_INVALID_PARAMS",
  "TOOL_UNKNOWN_ERROR", "TOOL_CANCELLED", "TOOL_DOOM_LOOP",
]);

export type StructuredPartsStatus = "safe" | "withheld" | "malformed";

export interface StructuredPartsClassification {
  status: StructuredPartsStatus;
  parts?: unknown[];
}

export interface WebFetchAuditProjection {
  version: typeof WEB_FETCH_PRIVACY_VERSION;
  toolName: "web_fetch";
  status: ToolResultV2["status"];
  durationMs: number;
  userConfirmed: boolean;
  reversible: boolean;
  errorCode: string | null;
}

export interface WebFetchExecutionRowProjection {
  id: string;
  projectId: string | null;
  conversationId: string | null;
  messageId: string | null;
  toolName: "web_fetch";
  input: string;
  output: string;
  status: string;
  userConfirmed: boolean;
  reversible: boolean;
  durationMs: number;
  createdAt: string;
  resultJson: string | null;
  errorCode: string | null;
}

const WEB_FETCH_REDACTED_INPUT = JSON.stringify({
  version: WEB_FETCH_PRIVACY_VERSION,
  toolName: "web_fetch",
  redacted: true,
});

const WEB_FETCH_WITHHELD_PARTS = JSON.stringify({
  version: WEB_FETCH_PRIVACY_VERSION,
  kind: WEB_FETCH_WITHHELD_MARKER,
  status: "withheld",
});

const WEB_FETCH_MALFORMED_PARTS = JSON.stringify({
  version: WEB_FETCH_PRIVACY_VERSION,
  kind: WEB_FETCH_WITHHELD_MARKER,
  status: "malformed",
});

export function isProjectedWebFetchInput(input: string | null | undefined): boolean {
  if (!input) return false;
  try {
    const parsed = JSON.parse(input) as Record<string, unknown>;
    return parsed.version === WEB_FETCH_PRIVACY_VERSION
      && parsed.toolName === "web_fetch"
      && parsed.redacted === true;
  } catch {
    return false;
  }
}

export function projectWebFetchInput(_rawInput: unknown): string {
  return WEB_FETCH_REDACTED_INPUT;
}

export function projectToolExecutionForAudit(result: ToolResultV2, durationMs: number): WebFetchAuditProjection {
  return {
    version: WEB_FETCH_PRIVACY_VERSION,
    toolName: "web_fetch",
    status: SAFE_WEB_FETCH_STATUSES.has(result.status) ? result.status : "error",
    durationMs,
    userConfirmed: result.userConfirmed ?? false,
    reversible: result.reversible ?? false,
    errorCode: result.error?.code && SAFE_WEB_FETCH_ERROR_CODES.has(result.error.code) ? result.error.code : null,
  };
}

export function projectWebFetchExecutionRow(row: {
  id: string;
  projectId: string | null;
  conversationId: string | null;
  messageId: string | null;
  status: string;
  userConfirmed: boolean;
  reversible: boolean;
  durationMs: number;
  createdAt: string;
  errorCode: string | null;
}): WebFetchExecutionRowProjection {
  const projection: WebFetchAuditProjection = {
    version: WEB_FETCH_PRIVACY_VERSION,
    toolName: "web_fetch",
    status: SAFE_WEB_FETCH_STATUSES.has(row.status as ToolResultV2["status"]) ? row.status as ToolResultV2["status"] : "error",
    durationMs: row.durationMs,
    userConfirmed: row.userConfirmed,
    reversible: row.reversible,
    errorCode: row.errorCode && SAFE_WEB_FETCH_ERROR_CODES.has(row.errorCode) ? row.errorCode : null,
  };
  return {
    ...row,
    toolName: "web_fetch",
    input: WEB_FETCH_REDACTED_INPUT,
    output: "[web_fetch output withheld]",
    status: projection.status,
    errorCode: projection.errorCode,
    resultJson: JSON.stringify(projection),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function scanSensitiveMarkers(value: unknown): StructuredPartsStatus | null {
  const statuses: StructuredPartsStatus[] = [];
  const visit = (current: unknown): void => {
    if (Array.isArray(current)) {
      current.forEach(visit);
      return;
    }
    if (!isRecord(current)) return;
    if (current.kind === WEB_FETCH_WITHHELD_MARKER) {
      const valid = current.version === WEB_FETCH_PRIVACY_VERSION
        && !Object.keys(current).some((key) => !["version", "kind", "status"].includes(key))
        && (current.status === "withheld" || current.status === "malformed");
      statuses.push(valid ? current.status as StructuredPartsStatus : "malformed");
    } else if (current.toolName === "web_fetch") {
      statuses.push("withheld");
    }
    Object.values(current).forEach(visit);
  };
  visit(value);
  if (statuses.includes("malformed")) return "malformed";
  if (statuses.includes("withheld")) return "withheld";
  return null;
}

function isSupportedPart(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "text") return typeof value.text === "string";
  if (value.type === "tool-call") {
    return typeof value.toolCallId === "string"
      && typeof value.toolName === "string"
      && "input" in value;
  }
  if (value.type === "tool-result") {
      return typeof value.toolCallId === "string"
      && typeof value.toolName === "string"
      && ("result" in value || "output" in value);
  }
  return false;
}

function isSupportedMessage(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || !["user", "assistant", "tool", "system"].includes(String(value.role))) return false;
  if (typeof value.content === "string") return true;
  if (!Array.isArray(value.content) || value.content.length === 0 || !value.content.every(isSupportedPart)) return false;
  const types = value.content.map((part) => part.type);
  if (value.role === "assistant") return types.every((type) => type === "text" || type === "tool-call");
  if (value.role === "tool") return types.every((type) => type === "tool-result");
  return types.every((type) => type === "text");
}

export function classifyStructuredParts(raw: string | null | undefined): StructuredPartsClassification {
  if (!raw || raw.trim() === "") return { status: "safe" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: "malformed" };
  }
  const markerStatus = scanSensitiveMarkers(parsed);
  if (markerStatus) return { status: markerStatus };
  if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every(isSupportedMessage)) {
    return { status: "malformed" };
  }
  return { status: "safe", parts: parsed };
}

export function projectStructuredParts(raw: string | null | undefined): string | null {
  const classification = classifyStructuredParts(raw);
  if (!raw || raw.trim() === "") return null;
  if (classification.status === "safe") return raw;
  return classification.status === "withheld" ? WEB_FETCH_WITHHELD_PARTS : WEB_FETCH_MALFORMED_PARTS;
}

export function providerPartsFromStored(raw: string | null | undefined): unknown[] | null {
  const classification = classifyStructuredParts(raw);
  return classification.status === "safe" ? classification.parts ?? null : null;
}
