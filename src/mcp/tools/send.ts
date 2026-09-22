// mesh_send and mesh_reply: everything that puts a message into the stream.
//
// Both end in `deliver`, so that a message and a reply are checked, charged,
// sent, stored and answered the same way.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  MESSAGE_PRIORITIES,
  RECOMMENDED_MESSAGE_TYPES,
  DEFAULT_MESSAGE_TYPE,
  REPLY_MESSAGE_TYPE,
  MAX_PAYLOAD_BYTES,
  FIELD_LIMITS,
} from "../../types.js";
import type { Message, MessagePriority } from "../../types.js";
import { createMessage, sendAndPersistMessage, expiresAt, MESSAGE_ID_RE } from "../../services/message.js";
import type { SendResult } from "../../services/message.js";
import { existingThread } from "../../services/message-queries.js";
import { recordAttempt, ownAttempt, forgetAttempt, envelopeOf, payloadHash } from "../../services/attempts.js";
import { inboxKeyOf } from "../../services/agent.js";
import { ok, error, adminError, pendingCount } from "../shared.js";
import type { ToolContext, ToolResult } from "../shared.js";

const TYPE_LIST = RECOMMENDED_MESSAGE_TYPES.join(", ");
const BROADCAST = "broadcast";
const BROADCAST_SUBJECT = "mesh.broadcast";

function isRecommendedType(type: string): boolean {
  return (RECOMMENDED_MESSAGE_TYPES as readonly string[]).includes(type);
}

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

/** Which tool is sending, and what its "send this again" parameter is called.
 *  mesh_reply has a `message_id` already: the message it answers. */
const KINDS = {
  message: { noun: "message", param: "message_id" },
  reply: { noun: "reply", param: "resend_id" },
} as const;
type Kind = keyof typeof KINDS;

/**
 * What the sender is told when a send did not go through. Both texts start
 * with `nats_unavailable`, the word clients key on. They differ in what is
 * safe to do next.
 */
function undeliveredText(kind: Kind, id: string, reason: SendResult["error"]): string {
  const { noun, param } = KINDS[kind];
  if (reason === "delivery_unknown") {
    return `nats_unavailable: delivery of ${noun} ${id} could not be confirmed — the broker did not answer in time. ` +
      `It may still arrive. Send it again with ${param}="${id}": the recipient then gets it once. ` +
      `Without ${param} it can arrive twice.`;
  }
  return `nats_unavailable: ${noun} not delivered. Retry in a few seconds.`;
}

const resendField = (what: string) =>
  z
    .string()
    .regex(MESSAGE_ID_RE, "must be a message id (msg_…)")
    .optional()
    .describe(
      `Only to repeat a ${what} of yours: the id a failed or unconfirmed attempt named. ` +
        "Sent again under the same id, the recipient gets it once. Leave it out for anything new.",
    );

/** A message ready to go: checked, addressed, not yet charged or sent. */
interface Draft {
  to: string;
  /** The recipient's inbox key; "" for a broadcast. */
  toKey: string | null;
  subject: string;
  type: string;
  payload: string;
  context: string;
  correlation_id?: string | null;
  reply_to?: string | null;
  priority?: MessagePriority;
  ttl_seconds?: number;
}

interface StoredRow {
  from_agent: string;
  from_key: string | null;
  to_agent: string;
  type: string;
  payload: string;
  reply_to: string | null;
  ttl_seconds: number;
  correlation_id: string | null;
  created_at: string;
}

/** Whose a stored message is: by the sender's inbox key. Rows from before
 *  keys were stored fall back to the name. */
function isOwn(ctx: ToolContext, row: { from_agent: string; from_key: string | null }): boolean {
  if (row.from_key) return row.from_key === ctx.inboxKey;
  return row.from_agent.toLowerCase() === ctx.agentName.toLowerCase();
}

export function registerSendTools(server: McpServer, ctx: ToolContext): void {
  const { nats, agents, activity, rateLimiter, agentName, inboxKey, db } = ctx;

  /**
   * A repeat of something that is delivered AND stored already: answered from
   * the history, nothing is sent and nothing is charged. Null when the id is
   * not in the history, which is the case this parameter exists for.
   */
  async function alreadyDelivered(kind: Kind, id: string, draft: Draft): Promise<ToolResult | null> {
    const row = db
      .prepare("SELECT from_agent, from_key, to_agent, type, payload, reply_to, ttl_seconds, correlation_id, created_at FROM messages WHERE id = ?")
      .get(id) as StoredRow | undefined;
    if (!row) return null;
    const { param } = KINDS[kind];
    if (!isOwn(ctx, row)) {
      return error(
        `${param} ${id} is not a message of yours. ${param} only repeats one of your own sends; ` +
          "to answer a message use mesh_reply, to continue its thread use correlation_id.",
      );
    }
    const same =
      row.to_agent.toLowerCase() === draft.to.toLowerCase() &&
      row.type === draft.type &&
      row.payload === draft.payload &&
      (row.reply_to ?? null) === (draft.reply_to ?? null);
    if (!same) {
      return error(
        `${param} ${id} was delivered already with different content (to, type or payload). ` +
          `Leave ${param} out to send a new message.`,
      );
    }
    return ok({
      id,
      to: row.to_agent,
      type: row.type,
      ...(row.correlation_id ? { correlation_id: row.correlation_id } : {}),
      ...(row.reply_to ? { reply_to: row.reply_to } : {}),
      created_at: row.created_at,
      expires_at: expiresAt(row),
      already_delivered: true,
      inbox_pending: await pendingCount(ctx),
      hint: "This message was delivered and stored before. Nothing was sent again.",
    });
  }

  /**
   * The repeat of a send that is not in the history: it has to be the
   * caller's own attempt, and the same message. The envelope is the first
   * attempt's, so that the recipient's copy and the history row agree.
   */
  function repeatOf(kind: Kind, id: string, draft: Draft): { msg: Message } | ToolResult {
    const { param } = KINDS[kind];
    const attempt = ownAttempt(db, id, inboxKey);
    if (!attempt) {
      return error(
        `${param} ${id} is not an id of a send of yours. It repeats one of your own sends whose delivery ` +
          "could not be confirmed, under the id that error named. Leave it out to send a new message.",
      );
    }
    const same =
      (attempt.to_key ? attempt.to_key === draft.toKey : attempt.to_agent === draft.to) &&
      attempt.type === draft.type &&
      attempt.payload_sha256 === payloadHash(draft.payload) &&
      (attempt.reply_to ?? null) === (draft.reply_to ?? null);
    if (!same) {
      return error(
        `${param} ${id} names a send with different content (to, type, payload or the message it answers). ` +
          `A repeat is the same message; leave ${param} out to send a new one.`,
      );
    }
    return { msg: envelopeOf(attempt, draft.payload) };
  }

  async function deliver(kind: Kind, draft: Draft, resendId: string | undefined, summary: string): Promise<ToolResult> {
    let msg: Message;
    if (resendId) {
      const before = await alreadyDelivered(kind, resendId, draft);
      if (before) return before;
      const repeat = repeatOf(kind, resendId, draft);
      if (!("msg" in repeat)) return repeat;
      msg = repeat.msg;
    } else {
      msg = createMessage({
        from: agentName,
        to: draft.to,
        type: draft.type,
        payload: draft.payload,
        context: draft.context,
        correlation_id: draft.correlation_id ?? undefined,
        reply_to: draft.reply_to ?? undefined,
        priority: draft.priority,
        ttl_seconds: draft.ttl_seconds,
      });
    }

    // Charged last: a send that was refused for what it says costs nothing.
    // By inbox key, so a rename does not hand out a fresh bucket.
    const rateCheck = rateLimiter.check(inboxKey);
    if (!rateCheck.allowed) {
      return error(`Rate limit exceeded. Wait ${rateCheck.retryAfterSeconds} seconds before retrying.`);
    }

    // The attempt, before the publish: what a repeat has to match.
    try {
      recordAttempt(db, msg, { fromKey: inboxKey, toKey: draft.toKey, subject: draft.subject });
    } catch (err) {
      return error(`The send could not be recorded (${String(err)}); nothing was sent. Retry in a moment.`);
    }

    // Dual-write: NATS first (delivery), DB second (history).
    // See Mesh-ADR-006. If NATS publish fails nothing is written to the
    // DB — no phantom-send. If the DB insert fails after NATS succeeds
    // the message is still delivered, and the sender is told about the gap.
    const result = await sendAndPersistMessage(nats, db, msg, draft.subject, inboxKey, draft.toKey);
    if (!result.delivered) {
      // A NEW send that was not sent: nothing to repeat, the record goes. An
      // unknown outcome, or a repeat the breaker refused, keeps it: the next
      // repeat has to find it.
      if (result.error === "nats_unavailable" && !resendId) forgetAttempt(db, msg.id);
      return error(undeliveredText(kind, msg.id, result.error));
    }
    if (result.persisted) forgetAttempt(db, msg.id);

    // A repeat the broker deduplicated sent nothing: it only wrote the row
    // that was missing. Logged as what it is, or the audit trail says a
    // message was sent twice.
    activity.logAsync({
      action: result.duplicate ? "message_stored" : "message_sent",
      entity_type: "message",
      entity_id: msg.id,
      summary: result.duplicate ? `${summary} (delivered earlier; history mended)` : summary,
      agent_name: agentName,
    });

    const { param } = KINDS[kind];
    const hints: string[] = [];
    if (result.duplicate) hints.push("An earlier attempt had arrived: the recipient has this message once.");
    if (!result.persisted) {
      hints.push(
        `Delivered, but the history could not store it: mesh_get, mesh_reply and mesh_history will not find ${msg.id}. ` +
          `Send it again with ${param}="${msg.id}" to store it; the recipient still gets it once.`,
      );
    }
    if (!isRecommendedType(draft.type) && kind === "message") {
      hints.push(`type "${draft.type}" is not a recommended type (${TYPE_LIST}) — delivered anyway.`);
    }

    return ok({
      id: msg.id,
      to: msg.to,
      type: msg.type,
      ...(msg.correlation_id ? { correlation_id: msg.correlation_id } : {}),
      ...(msg.reply_to ? { reply_to: msg.reply_to } : {}),
      created_at: msg.created_at,
      expires_at: expiresAt(msg),
      ...(result.duplicate ? { duplicate: true } : {}),
      ...(result.persisted ? {} : { history_gap: true }),
      inbox_pending: await pendingCount(ctx),
      ...(hints.length > 0 ? { hint: hints.join(" ") } : {}),
    });
  }

  // ── mesh_send ─────────────────────────────────────────────────
  server.tool(
    "mesh_send",
    "Send a message to another agent or broadcast to all agents. The context field is REQUIRED — describe your current project, task, and status so the recipient understands your situation. The reply carries expires_at (when delivery stops) and inbox_pending: how many messages are waiting for YOU.",
    {
      to: z.string().max(FIELD_LIMITS.AGENT_NAME).describe("Target agent name (see mesh_status), or 'broadcast' for all agents"),
      type: z
        .string()
        .max(FIELD_LIMITS.TYPE)
        .optional()
        .describe(`Message type, default "${DEFAULT_MESSAGE_TYPE}". Recommended: ${TYPE_LIST}. Other values are accepted.`),
      payload: z.string().max(MAX_PAYLOAD_BYTES).describe("Message content (max 256 KB)"),
      context: z.string().max(2048).describe("Your current project, task, and status (max 2048 chars) — REQUIRED for recipient to understand your situation"),
      correlation_id: z.string().trim().max(FIELD_LIMITS.ID).optional().describe("Continue an existing conversation: the correlation_id of a message you got, or the id of any message of the thread. It has to exist; leave it out to start a new thread. Spaces around it are dropped, an empty value counts as none."),
      priority: z.enum(MESSAGE_PRIORITIES).optional().describe("Message priority (low, normal, high)"),
      ttl_seconds: z
        .number()
        .int()
        .min(1)
        .max(FIELD_LIMITS.TTL_SECONDS_MAX)
        .optional()
        .describe("Delivery deadline in whole seconds, 1 to 604800 (default: 86400 = 24h). After expiry, mesh_receive drops the message — it remains in history until the 30-day DB rotation."),
      message_id: resendField("mesh_send"),
    },
    async (params) => {
      if (ctx.isAdmin) return adminError();

      const targetAgent = params.to === BROADCAST ? null : agents.getByName(params.to);
      if (params.to !== BROADCAST && (!targetAgent || !targetAgent.is_active)) {
        // A repeat of something that was delivered and stored is answered
        // from the history, whatever became of the recipient since.
        if (params.message_id) {
          const before = await alreadyDelivered("message", params.message_id, {
            to: params.to, toKey: null, subject: "", type: params.type?.trim() || DEFAULT_MESSAGE_TYPE, payload: params.payload, context: params.context,
          });
          if (before && !before.isError) return before;
          if (ownAttempt(db, params.message_id, inboxKey)) {
            return error(`Agent "${params.to}" was removed or deactivated after message ${params.message_id} was sent. Nothing can be sent to it now.`);
          }
        }
        return error(unavailableAgentError(params.to));
      }

      const wanted = params.correlation_id;
      const thread = wanted ? existingThread(db, wanted) : null;
      if (wanted && !thread) {
        return error(
          `correlation_id "${wanted}" is not a message or a thread in the history. ` +
            "Leave it out to start a new thread, or answer a message with mesh_reply.",
        );
      }

      const type = params.type?.trim() || DEFAULT_MESSAGE_TYPE;
      // The canonical name, not what the sender typed: history groups and
      // renames match on it, and "Tech-CIO" vs "tech-cio" split threads.
      const to = targetAgent?.name ?? params.to;
      return deliver(
        "message",
        {
          to,
          toKey: targetAgent ? inboxKeyOf(targetAgent) : "",
          subject: targetAgent ? inboxSubject(targetAgent) : BROADCAST_SUBJECT,
          type,
          payload: params.payload,
          context: params.context,
          correlation_id: thread,
          priority: params.priority,
          ttl_seconds: params.ttl_seconds,
        },
        params.message_id,
        `${agentName} → ${to} [${type}]`,
      );
    },
  );

  // ── mesh_reply ────────────────────────────────────────────────
  server.tool(
    "mesh_reply",
    "Reply to a specific message. Threading is automatic — the reply is linked to the original conversation thread. A reply to a message of your own goes to whoever that message was for.",
    {
      message_id: z.string().max(FIELD_LIMITS.ID).describe("ID of the message to reply to"),
      payload: z.string().max(MAX_PAYLOAD_BYTES).describe("Reply content (max 256 KB)"),
      context: z.string().max(2048).describe("Your current project, task, and status (max 2048 chars)"),
      type: z
        .string()
        .max(FIELD_LIMITS.TYPE)
        .optional()
        .describe(`Message type of the reply, default "${REPLY_MESSAGE_TYPE}" (e.g. review_result answering a review_request)`),
      resend_id: resendField("mesh_reply"),
    },
    async (params) => {
      if (ctx.isAdmin) return adminError();

      const original = db
        .prepare("SELECT id, from_agent, from_key, to_agent, correlation_id FROM messages WHERE id = ?")
        .get(params.message_id) as
        | { id: string; from_agent: string; from_key: string | null; to_agent: string; correlation_id: string | null }
        | undefined;

      if (!original) {
        return error(`Message not found: ${params.message_id}`);
      }

      // A reply goes to the other side of the message. For somebody else's
      // message that is its sender; for one's own (a follow-up) it is who
      // the message was for. It used to go to the sender in both cases: an
      // agent that added something to its own message wrote to itself.
      const other = isOwn(ctx, original) ? original.to_agent : original.from_agent;
      const toEveryone = other === BROADCAST;

      // Same guard as mesh_send. Without it a reply to a deleted or
      // deactivated agent was published to a subject nobody reads and
      // reported as delivered. A renamed agent is found under its new
      // name, because a rename rewrites the names in the history.
      const recipient = toEveryone ? null : agents.getByName(other);
      if (!toEveryone && (!recipient || !recipient.is_active)) {
        if (params.resend_id) {
          const before = await alreadyDelivered("reply", params.resend_id, {
            to: other, toKey: null, subject: "", type: params.type?.trim() || REPLY_MESSAGE_TYPE, payload: params.payload, context: params.context, reply_to: params.message_id,
          });
          if (before && !before.isError) return before;
          if (ownAttempt(db, params.resend_id, inboxKey)) {
            return error(`Agent "${other}" was removed or deactivated after reply ${params.resend_id} was sent. Nothing can be sent to it now.`);
          }
        }
        return error(unavailableAgentError(other));
      }

      const to = recipient?.name ?? BROADCAST;
      return deliver(
        "reply",
        {
          to,
          toKey: recipient ? inboxKeyOf(recipient) : "",
          subject: recipient ? inboxSubject(recipient) : BROADCAST_SUBJECT,
          type: params.type?.trim() || REPLY_MESSAGE_TYPE,
          payload: params.payload,
          context: params.context,
          correlation_id: original.correlation_id ?? original.id,
          reply_to: params.message_id,
        },
        params.resend_id,
        `${agentName} → ${to} [reply to ${params.message_id}]`,
      );
    },
  );
}
