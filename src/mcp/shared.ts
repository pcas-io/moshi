// Shared plumbing for the MCP tool modules: the service bundle every tool
// receives, the JSON response helpers, the admin-identity guard and the
// best-effort inbox counter that every mutating tool appends to its reply.

import type Database from "better-sqlite3";
import type { InboxPull, InboxPending, PullOptions } from "../services/inbox.js";
import { ownBroadcastsBehind } from "../services/message.js";
import type { PublishAck } from "../services/message.js";
import type { AgentService } from "../services/agent.js";
import type { ActivityService } from "../services/activity.js";
import type { RateLimiter } from "../services/ratelimit.js";
import type { PresenceService } from "../services/presence.js";
import { log } from "../services/logger.js";

/** The slice of `NatsService` the tools depend on — narrow so tests can
 *  pass a plain object. */
export interface MeshNats {
  publish(subject: string, data: Uint8Array, msgId: string): Promise<PublishAck | void>;
  pullInbox(inboxKey: string, limit: number, opts?: PullOptions): Promise<InboxPull>;
  inboxPending(inboxKey: string): Promise<InboxPending>;
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
  /** The caller's NATS address token (`agents.inbox_key`). Everything that
   *  touches the inbox goes through it — never through `agentName`, which
   *  is a label and can be renamed. Empty for the admin, who has no inbox. */
  inboxKey: string;
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
 * What is waiting for the agent, out of what the broker says is waiting in
 * its two consumers. The broker counts an agent's own broadcasts as pending
 * for it: they reach its broadcast consumer like everybody else's.
 * mesh_receive never hands them out, so they are not "messages waiting for
 * you", and the agents' loops trigger on this number.
 */
export function waitingFor(
  ctx: ToolContext,
  counts: Pick<InboxPending, "total" | "broadcast" | "broadcastDeliveredSeq" | "stream">,
): number {
  // Without the stream's bounds nothing is subtracted: counting one too many
  // costs a receive that finds nothing, one too few hides mail.
  const own = counts.broadcast > 0 && counts.broadcastDeliveredSeq !== null && counts.stream
    ? ownBroadcastsBehind(ctx.db, ctx.inboxKey, counts.broadcastDeliveredSeq, counts.stream)
    : 0;
  return counts.total - Math.min(own, counts.broadcast);
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
    return waitingFor(ctx, await ctx.nats.inboxPending(ctx.inboxKey));
  } catch (err) {
    log("warn", "inbox pending count failed", {
      agent: ctx.agentName,
      err: String(err),
    });
    return null;
  }
}
