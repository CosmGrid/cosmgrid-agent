import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServerRow } from "@/lib/db/mcp";
import { callRemoteMcpTool, disposeRemoteMcpSessions, listRemoteMcpTools } from "../remote-client";

describe("remote MCP Streamable HTTP integration", () => {
  let httpServer: Server;
  let mcpServer: McpServer;
  let url: string;

  beforeAll(async () => {
    mcpServer = new McpServer({ name: "cosmgrid-test-server", version: "1.0.0" });
    mcpServer.registerTool(
      "echo",
      {
        description: "Echo input",
        inputSchema: { value: z.string() },
      },
      async ({ value }) => ({ content: [{ type: "text", text: `echo:${value}` }] }),
    );
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
    await mcpServer.connect(transport);

    httpServer = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = raw ? JSON.parse(raw) : undefined;
      await transport.handleRequest(request, response, body);
    });
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const address = httpServer.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    url = `http://127.0.0.1:${address.port}/mcp`;
  });

  afterAll(async () => {
    await disposeRemoteMcpSessions();
    await mcpServer.close();
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => error ? reject(error) : resolve());
    });
  });

  function server(): McpServerRow {
    return {
      id: "remote-integration",
      name: "integration",
      transport: "remote_http",
      url,
      command: null,
      args: [],
      env: {},
      headers: {},
      secretCredentialId: null,
      enabled: true,
      createdAt: "2026-07-09T00:00:00.000Z",
      updatedAt: "2026-07-09T00:00:00.000Z",
    };
  }

  it("negotiates, lists tools, and calls a tool", async () => {
    const tools = await listRemoteMcpTools(server());
    expect(tools.map((tool) => tool.name)).toContain("echo");

    const result = await callRemoteMcpTool(server(), "echo", { value: "hello" });
    expect(result.content).toContainEqual(expect.objectContaining({ type: "text", text: "echo:hello" }));
  }, 15_000);
});
