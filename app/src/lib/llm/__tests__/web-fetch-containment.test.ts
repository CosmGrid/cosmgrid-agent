import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function collectStrings(value: unknown, output: string[] = []): string[] {
  if (typeof value === "string") {
    output.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, output);
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) collectStrings(item, output);
  }
  return output;
}

describe("main capability web fetch containment", () => {
  it("所有 capability JSON 都不授予 URL fetch 权限", () => {
    const capabilitiesUrl = new URL("../../../../src-tauri/capabilities/", import.meta.url);
    const capabilityFiles = readdirSync(capabilitiesUrl).filter((file) => file.endsWith(".json"));

    expect(capabilityFiles.length).toBeGreaterThan(0);
    for (const file of capabilityFiles) {
      const capability = JSON.parse(readFileSync(new URL(file, capabilitiesUrl), "utf8")) as unknown;
      const strings = collectStrings(capability);
      expect(strings, file).not.toContain("allow-fetch-url-backend");
      expect(strings, file).not.toContain("allow-fetch-url-rendered");
    }
  });
});
