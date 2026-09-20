// The MCP endpoint: POST /mcp, stateless — one McpServer and one transport
// per request. Extracted from src/index.tsx so the route can be tested
// through the real app (tests/app/wiring.test.ts).
//
// Mount order in src/app.tsx is part of the contract:
//   mcpPostOnly (405 guard)  →  authMiddleware  →  this route (limit, handler)

import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type Database from "better-sqlite3";
import type { Env, AppVariables } from "../types.js";
import type { AgentService } from "../services/agent.js";
import type { ActivityService } from "../services/activity.js";
import type { RateLimiter } from "../services/ratelimit.js";
import type { PresenceService } from "../services/presence.js";
import type { MeshNats } from "../mcp/shared.js";
import { createMcpServer } from "../mcp/server.js";
import { log } from "../services/logger.js";

type HonoEnv = { Bindings: Env; Variables: AppVariables };

/** What the route needs from NATS: the tool surface plus consumer creation. */
export type McpRouteNats = MeshNats & {
  ensureConsumer(inboxKey: string, since?: string | null, opts?: { replaceLeftBehind?: boolean }): Promise<void>;
};

export interface McpRouteDeps {
  nats: McpRouteNats;
  agents: AgentService;
  activity: ActivityService;
  rateLimiter: RateLimiter;
  presence: PresenceService;
  db: Database.Database;
}

/**
 * Stateless, JSON responses. The Go CLI depends on both: it sends a bare
 * `tools/call` without `initialize` or a session id and reads one JSON body.
 * tests/mcp/wire-contract.test.ts pins that against this very function.
 */
export function createStatelessTransport(): WebStandardStreamableHTTPServerTransport {
  return new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless — new transport per request
    enableJsonResponse: true,
  });
}

// The limit lives on the route, behind the 405 guard and behind auth. Mounted
// app-wide in front of auth, as it once was, it let an anonymous client open a
// chunked POST, go quiet, and hold a connection (and up to 512 KB) for Node's
// five-minute request timeout: since hono 4.13 bodyLimit reads a chunked body
// to the end before it calls next(). tests/app/wiring.test.ts pins the order.
const mcpBodyLimit = bodyLimit({
  maxSize: 512 * 1024, // 512 KB — 256 KB payload + JSON-RPC envelope + headroom
  onError: (c) =>
    c.json(
      {
        jsonrpc: "2.0",
        error: { code: -32600, message: "Request body too large (max 512 KB)" },
        id: null,
      },
      413,
    ),
});

export function createMcpRoute({ nats, agents, activity, rateLimiter, presence, db }: McpRouteDeps): Hono<HonoEnv> {
  const mcp = new Hono<HonoEnv>();

  mcp.post("/mcp", mcpBodyLimit, async (c) => {
    const agent = c.get("agent");
    const agentName = agent?.name ?? "anonymous";
    const isAdmin = agent?.role === "admin";
    // The NATS address is the agent's immutable inbox key, read from its
    // record at auth time — never derived from the name here. A rename can
    // land between auth and this line, and a key guessed from a stale name
    // could be another agent's inbox (mesh_receive acks what it pulls).
    const inboxKey = isAdmin ? "" : agent?.inbox_key;
    if (inboxKey === undefined) {
      return c.json(
        { jsonrpc: "2.0", error: { code: -32000, message: "Unauthorized: no agent record for this identity." }, id: null },
        401,
      );
    }

    // Ensure NATS consumers exist for this agent. The admin identity has no
    // inbox by design (see ADMIN_NOT_AGENT_HINT), so no consumers for it.
    if (!isAdmin) {
      try {
        // From the agent's inbox_since: new durables start there. One that is
        // older was a predecessor's, and is replaced, but only for an agent
        // that came after that rule: an older one may have been reading from
        // an inherited durable all along.
        await nats.ensureConsumer(inboxKey, agent?.inbox_since, {
          replaceLeftBehind: agents.isAfterInboxCutover(agent?.inbox_since),
        });
      } catch {
        // Non-fatal — consumer creation may fail on first request, retry on next
      }
    }

    const server = createMcpServer({
      nats,
      agents,
      activity,
      rateLimiter,
      presence,
      db,
      agentName,
      inboxKey,
      isAdmin,
    });

    const transport = createStatelessTransport();

    await server.connect(transport);

    try {
      const response = await transport.handleRequest(c.req.raw);
      return response;
    } catch (err) {
      log("error", "mcp request failed", {
        agent: agentName,
        err: String(err),
        stack: (err as Error)?.stack,
      });
      return c.json(
        {
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        },
        500,
      );
    } finally {
      await transport.close();
      await server.close();
    }
  });

  return mcp;
}
