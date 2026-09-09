// Shared plumbing for the MCP tool modules: the service bundle every tool
// receives, the JSON response helpers, the admin-identity guard and the
// best-effort inbox counter that every mutating tool appends to its reply.

import type Database from "better-sqlite3";
import type { InboxPull, InboxPending } from "../services/inbox.js";
import type { AgentService } from "../services/agent.js";
import type { ActivityService } from "../services/activity.js";
import type { RateLimiter } from "../services/ratelimit.js";
import type { PresenceService } from "../services/presence.js";
import { log } from "../services/logger.js";

/** The slice of `NatsService` the tools depend on — narrow so tests can
 *  pass a plain object. */
export interface MeshNats {
  publish(subject: string, data: Uint8Array, msgId: string): Promise<void>;
  pullInbox(agentName: string, limit: number): Promise<InboxPull>;
  inboxPending(agentName: string): Promise<InboxPending>;
}

export interface ToolContext {
  nats: MeshNats;
  agents: AgentService;
  activity: ActivityService;
  rateLimiter: RateLimiter;
  presence: PresenceService;
  db: Database.Database;
  /** Authenticated identity of this request. */
  agentName: string;
  /** True when the request authenticated with the admin token. The admin
   *  is an operator identity, not an agent: it has no inbox, no roster
   *  entry and cannot be addressed — see `adminError`. */
  isAdmin: boolean;
}

export type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: true;
};

export function ok(data: unknown): ToolResult {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

export function error(message: string): ToolResult {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true as const,
  };
}

export const ADMIN_NOT_AGENT_HINT =
  "admin_token_is_not_an_agent: this MCP connection authenticated with the " +
  "admin token, which is an operator identity without an inbox — it does not " +
  "appear in mesh_status and nobody can send to it. Create an agent in the " +
  "dashboard (/agents → + New Agent), put its bt_… token into this MCP " +
  "server's Authorization header and reconnect. mesh_status, mesh_history " +
  "and mesh_get keep working with the admin token.";

export function adminError(): ToolResult {
  return error(ADMIN_NOT_AGENT_HINT);
}

/**
 * Waiting-message count for the calling agent, appended to tool replies
 * so agents learn about pending mail without a blind `mesh_receive`
 * (A4). `null` when the identity has no inbox (admin) or NATS is down —
 * never throws, never delays the primary result.
 */
export async function pendingCount(ctx: ToolContext): Promise<number | null> {
  if (ctx.isAdmin) return null;
  try {
    return (await ctx.nats.inboxPending(ctx.agentName)).total;
  } catch (err) {
    log("warn", "inbox pending count failed", {
      agent: ctx.agentName,
      err: String(err),
    });
    return null;
  }
}
