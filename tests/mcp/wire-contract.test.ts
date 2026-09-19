// The Go CLI's wire contract with the server.
//
// cli/client.go sends a bare `tools/call` — no `initialize`, no session id,
// no MCP-Protocol-Version header. That only works because the transport is
// stateless. Nothing else tests it, and it lives in SDK internals: an SDK
// upgrade that starts insisting on a handshake would break every installed
// binary while the rest of the suite stays green.

import { describe, it, expect } from "vitest";
import { createHarness } from "./harness";
import { createMcpServer } from "../../src/mcp/server";
import { createStatelessTransport } from "../../src/routes/mcp";

async function bareToolsCall(tool: string, args: Record<string, unknown>) {
  const h = createHarness();
  h.agents.create("cli-user");
  const server = createMcpServer({
    nats: h.nats, agents: h.agents, activity: h.activity, rateLimiter: h.rateLimiter,
    presence: h.presence, db: h.db, agentName: "cli-user", isAdmin: false,
  });
  // The route's own transport, not a copy of its options.
  const transport = createStatelessTransport();
  await server.connect(transport);
  // Exactly what cli/client.go builds.
  const res = await transport.handleRequest(new Request("http://moshi.test/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
  }));
  await transport.close();
  await server.close();
  return res;
}

describe("stateless /mcp wire contract (Go CLI)", () => {
  it("answers tools/call without a prior initialize", async () => {
    const res = await bareToolsCall("mesh_status", {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result?: { content: { text: string }[] } };
    const payload = JSON.parse(body.result!.content[0]!.text) as { agents: unknown[] };
    expect(Array.isArray(payload.agents)).toBe(true);
  });
});
