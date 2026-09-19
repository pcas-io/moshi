import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Message } from "../../types.js";
import {
  MESSAGE_PRIORITIES,
  RECOMMENDED_MESSAGE_TYPES,
  DEFAULT_MESSAGE_TYPE,
  REPLY_MESSAGE_TYPE,
  DEFAULT_PREVIEW_CHARS,
  MIN_PREVIEW_CHARS,
  MAX_PAYLOAD_BYTES,
} from "../../types.js";
import {
  createMessage,
  isMessageExpired,
  deserializeMessage,
  sendAndPersistMessage,
} from "../../services/message.js";
import { log } from "../../services/logger.js";
import { inboxKeyOf } from "../../services/agent.js";
import { ok, error, adminError, pendingCount } from "../shared.js";
import type { ToolContext } from "../shared.js";

const TYPE_LIST = RECOMMENDED_MESSAGE_TYPES.join(", ");

function isRecommendedType(type: string): boolean {
  return (RECOMMENDED_MESSAGE_TYPES as readonly string[]).includes(type);
}

const BROADCAST_SUBJECT = "mesh.broadcast";

/** The one place a direct-message subject is built. It takes the agent
 *  row, not a name: the address is the immutable inbox key. */
function inboxSubject(agent: { name: string; inbox_key?: string | null }): string {
  // Lower-cased like the consumer side (inbox.ts, nats.ts), so publisher and
  // filter can never disagree about the token.
  return `mesh.agents.${inboxKeyOf(agent).toLowerCase()}.inbox`;
}

function unavailableAgentError(name: string): string {
  return `Agent "${name}" not found. Use mesh_status to see available agents.`;
}

interface NameRow { id: string; from_agent: string; to_agent: string }

/** from/to as the history has them now. Missing ids (a history gap after a
 *  failed dual-write) simply keep what the envelope says. */
function currentNames(
  db: ToolContext["db"],
  ids: string[],
): Map<string, NameRow> {
  if (ids.length === 0) return new Map();
  const rows = db
    .prepare(
      `SELECT id, from_agent, to_agent FROM messages WHERE id IN (${ids.map(() => "?").join(",")})`,
    )
    .all(...ids) as NameRow[];
  return new Map(rows.map((r) => [r.id, r]));
}

/** Inbox view of a message: payload cut to `previewChars`, with enough
 *  metadata for the agent to decide whether `mesh_get` is worth a call. */
export function previewMessage(msg: Message, previewChars: number) {
  const length = msg.payload.length;
  const truncated = length > previewChars;
  return {
    ...msg,
    payload: truncated ? msg.payload.slice(0, previewChars) : msg.payload,
    payload_length: length,
    payload_truncated: truncated,
  };
}

export function registerMessagingTools(server: McpServer, ctx: ToolContext): void {
  const { nats, agents, activity, rateLimiter, agentName, inboxKey, db } = ctx;

  // ── mesh_send ─────────────────────────────────────────────────
  server.tool(
    "mesh_send",
    "Send a message to another agent or broadcast to all agents. The context field is REQUIRED — describe your current project, task, and status so the recipient understands your situation. The reply carries inbox_pending: how many messages are waiting for YOU.",
    {
      to: z.string().describe("Target agent name (see mesh_status), or 'broadcast' for all agents"),
      type: z
        .string()
        .optional()
        .describe(`Message type, default "${DEFAULT_MESSAGE_TYPE}". Recommended: ${TYPE_LIST}. Other values are accepted.`),
      payload: z.string().max(MAX_PAYLOAD_BYTES).describe("Message content (max 256 KB)"),
      context: z.string().max(2048).describe("Your current project, task, and status (max 2048 chars) — REQUIRED for recipient to understand your situation"),
      correlation_id: z.string().optional().describe("Thread ID to continue an existing conversation"),
      priority: z.enum(MESSAGE_PRIORITIES).optional().describe("Message priority (low, normal, high)"),
      ttl_seconds: z.number().optional().describe("Delivery deadline in seconds (default: 86400 = 24h). After expiry, mesh_receive silently drops the message — but it remains in history until the 30-day DB rotation."),
    },
    async (params) => {
      if (ctx.isAdmin) return adminError();

      const rateCheck = rateLimiter.check(agentName);
      if (!rateCheck.allowed) {
        return error(
          `Rate limit exceeded. Wait ${rateCheck.retryAfterSeconds} seconds before retrying.`,
        );
      }

      const targetAgent = params.to === "broadcast" ? null : agents.getByName(params.to);
      if (params.to !== "broadcast" && (!targetAgent || !targetAgent.is_active)) {
        return error(unavailableAgentError(params.to));
      }

      const type = params.type?.trim() || DEFAULT_MESSAGE_TYPE;
      const msg = createMessage({
        from: agentName,
        // The canonical name, not what the sender typed: history groups and
        // renames match on it, and "Tech-CIO" vs "tech-cio" split threads.
        to: targetAgent?.name ?? params.to,
        type,
        payload: params.payload,
        context: params.context,
        correlation_id: params.correlation_id,
        priority: params.priority,
        ttl_seconds: params.ttl_seconds,
      });

      // Dual-write: NATS first (delivery), DB second (history).
      // See Mesh-ADR-006. If NATS publish fails nothing is written to the
      // DB — no phantom-send. If the DB insert fails after NATS succeeds
      // the message is still delivered and we loud-log the history gap.
      const subject = targetAgent ? inboxSubject(targetAgent) : BROADCAST_SUBJECT;
      const result = await sendAndPersistMessage(nats, db, msg, subject);
      if (!result.delivered) {
        return error(
          `nats_unavailable: message not delivered. Retry in a few seconds.`,
        );
      }

      activity.logAsync({
        action: "message_sent",
        entity_type: "message",
        entity_id: msg.id,
        summary: `${agentName} → ${msg.to} [${type}]`,
        agent_name: agentName,
      });

      return ok({
        id: msg.id,
        to: msg.to,
        type: msg.type,
        created_at: msg.created_at,
        inbox_pending: await pendingCount(ctx),
        ...(isRecommendedType(type)
          ? {}
          : { hint: `type "${type}" is not a recommended type (${TYPE_LIST}) — delivered anyway.` }),
      });
    },
  );

  // ── mesh_receive ──────────────────────────────────────────────
  server.tool(
    "mesh_receive",
    "Check for new messages in your inbox. Returns unread messages from other agents and broadcasts — reading acknowledges them. Long payloads are cut to preview_chars (payload_truncated=true); fetch the full text with mesh_get.",
    {
      limit: z.number().min(1).max(50).optional().describe("Max messages to fetch (default: 10, max: 50)"),
      preview_chars: z
        .number()
        .int()
        .min(MIN_PREVIEW_CHARS)
        .max(MAX_PAYLOAD_BYTES)
        .optional()
        .describe(`Max payload characters per message (default ${DEFAULT_PREVIEW_CHARS}). Longer payloads are truncated and flagged; use mesh_get(message_id) for the full text.`),
    },
    async (params) => {
      if (ctx.isAdmin) return adminError();

      const limit = params.limit ?? 10;
      const previewChars = params.preview_chars ?? DEFAULT_PREVIEW_CHARS;

      // C4: NATS unavailability degrades gracefully — empty inbox plus a
      // hint so the caller knows to retry.
      let pull: Awaited<ReturnType<typeof nats.pullInbox>>;
      try {
        pull = await nats.pullInbox(inboxKey, limit);
      } catch (err) {
        log("warn", "nats pull failed in mesh_receive", {
          agent: agentName,
          err: String(err),
        });
        return ok({ messages: [], inbox_pending: null, hint: "nats_unavailable, retry shortly" });
      }

      const messages: ReturnType<typeof previewMessage>[] = [];
      let truncated = 0;

      for (const pm of pull.messages) {
        let msg: Message;
        try {
          msg = deserializeMessage(pm.data);
        } catch {
          pm.ack(); // unparseable — drop
          continue;
        }
        pm.ack();
        if (isMessageExpired(msg)) continue; // past its delivery deadline
        const view = previewMessage(msg, previewChars);
        if (view.payload_truncated) truncated++;
        messages.push(view);
      }

      if (messages.length === 0) {
        return ok({ messages: [], inbox_pending: pull.remaining, hint: "No new messages." });
      }

      // The JetStream copy froze the names at send time. A rename rewrites
      // the history, so take from/to from there: an agent that answers a
      // renamed sender by name would otherwise be told it does not exist.
      const current = currentNames(db, messages.map((m) => m.id));
      for (const m of messages) {
        const names = current.get(m.id);
        if (names) {
          m.from = names.from_agent;
          m.to = names.to_agent;
        }
      }

      return ok({
        messages,
        count: messages.length,
        inbox_pending: pull.remaining,
        ...(truncated > 0
          ? { hint: `${truncated} payload(s) truncated at preview_chars=${previewChars} — call mesh_get(message_id) for the full text.` }
          : {}),
      });
    },
  );

  // ── mesh_reply ────────────────────────────────────────────────
  server.tool(
    "mesh_reply",
    "Reply to a specific message. Threading is automatic — the reply is linked to the original conversation thread.",
    {
      message_id: z.string().describe("ID of the message to reply to"),
      payload: z.string().max(MAX_PAYLOAD_BYTES).describe("Reply content (max 256 KB)"),
      context: z.string().max(2048).describe("Your current project, task, and status (max 2048 chars)"),
      type: z
        .string()
        .optional()
        .describe(`Message type of the reply, default "${REPLY_MESSAGE_TYPE}" (e.g. review_result answering a review_request)`),
    },
    async (params) => {
      if (ctx.isAdmin) return adminError();

      const rateCheck = rateLimiter.check(agentName);
      if (!rateCheck.allowed) {
        return error(
          `Rate limit exceeded. Wait ${rateCheck.retryAfterSeconds} seconds before retrying.`,
        );
      }

      const original = db
        .prepare("SELECT id, from_agent, correlation_id FROM messages WHERE id = ?")
        .get(params.message_id) as
        | { id: string; from_agent: string; correlation_id: string | null }
        | undefined;

      if (!original) {
        return error(`Message not found: ${params.message_id}`);
      }

      // Same guard as mesh_send. Without it a reply to a deleted or
      // deactivated sender was published to a subject nobody reads and
      // reported as delivered. A renamed sender is found under its new
      // name, because a rename rewrites `from_agent` in the history.
      const recipient = agents.getByName(original.from_agent);
      if (!recipient || !recipient.is_active) {
        return error(unavailableAgentError(original.from_agent));
      }

      const threadRoot = original.correlation_id ?? original.id;
      const type = params.type?.trim() || REPLY_MESSAGE_TYPE;
      const msg = createMessage({
        from: agentName,
        to: recipient.name,
        type,
        payload: params.payload,
        context: params.context,
        correlation_id: threadRoot,
        reply_to: params.message_id,
      });

      // Dual-write: NATS first (delivery), DB second (history) — same
      // reliability semantics as mesh_send, see Mesh-ADR-006.
      const result = await sendAndPersistMessage(nats, db, msg, inboxSubject(recipient));
      if (!result.delivered) {
        return error(
          `nats_unavailable: reply not delivered. Retry in a few seconds.`,
        );
      }

      activity.logAsync({
        action: "message_sent",
        entity_type: "message",
        entity_id: msg.id,
        summary: `${agentName} → ${recipient.name} [reply to ${params.message_id}]`,
        agent_name: agentName,
      });

      return ok({
        id: msg.id,
        to: msg.to,
        type: msg.type,
        correlation_id: msg.correlation_id,
        reply_to: msg.reply_to,
        created_at: msg.created_at,
        inbox_pending: await pendingCount(ctx),
      });
    },
  );
}
