// mesh_receive and mesh_inbox: the two ways an agent looks at its mail.
//
// mesh_receive takes messages out of the broker: what it returns is acked,
// and the ack is sent before the answer has reached the agent. mesh_inbox
// takes nothing out: it reads the history, and shows for every message when
// mesh_receive handed it out. A message whose answer got lost is found there.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Message } from "../../types.js";
import { DEFAULT_PREVIEW_CHARS, MIN_PREVIEW_CHARS, MAX_PAYLOAD_BYTES } from "../../types.js";
import { isMessageExpired, deserializeMessage, expiresAt } from "../../services/message.js";
import type { InboxSide } from "../../services/inbox.js";
import { markRead, readCheck, listInbox } from "../../services/reads.js";
import { noteExpired, READ_NOT_RECORDED } from "../../services/expiry.js";
import { log } from "../../services/logger.js";
import { ok, adminError, pendingCount, waitingFor } from "../shared.js";
import type { ToolContext } from "../shared.js";

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
export function previewMessage<T extends { payload: string }>(msg: T, previewChars: number) {
  const length = msg.payload.length;
  const truncated = length > previewChars;
  return {
    ...msg,
    payload: truncated ? msg.payload.slice(0, previewChars) : msg.payload,
    payload_length: length,
    payload_truncated: truncated,
  };
}

const previewCharsField = z
  .number()
  .int()
  .min(MIN_PREVIEW_CHARS)
  .max(MAX_PAYLOAD_BYTES)
  .optional()
  .describe(`Max payload characters per message (default ${DEFAULT_PREVIEW_CHARS}). Longer payloads are truncated and flagged; use mesh_get(message_id) for the full text.`);

export function registerReceiveTools(server: McpServer, ctx: ToolContext): void {
  const { nats, agents, activity, agentName, inboxKey, db } = ctx;

  // ── mesh_receive ──────────────────────────────────────────────
  server.tool(
    "mesh_receive",
    "Check for new messages in your inbox. Returns unread messages from other agents and broadcasts — reading acknowledges them. Long payloads are cut to preview_chars (payload_truncated=true); fetch the full text with mesh_get. If an answer of this tool ever got lost, mesh_inbox still shows what it handed out.",
    {
      limit: z.number().int().min(1).max(50).optional().describe("Max messages to fetch (default: 10, max: 50)"),
      preview_chars: previewCharsField,
    },
    async (params) => {
      if (ctx.isAdmin) return adminError();

      const limit = params.limit ?? 10;
      const previewChars = params.preview_chars ?? DEFAULT_PREVIEW_CHARS;

      // Not everything in the two consumers is a message for this agent.
      // What is not gets acked inside the pull and does not take a place in
      // `limit`, so the agent never reads "No new messages" next to an
      // inbox_pending above zero.
      const kept = new Map<Uint8Array, Message>();
      const keptIds = new Set<string>();
      const ranOut: Message[] = [];
      let expired = 0;
      const senderNow = db.prepare("SELECT from_agent, from_key FROM messages WHERE id = ?");
      // Whose a broadcast is: by the sender's inbox key, which the history
      // row carries. A name proves little: it can be given to another agent
      // after a delete, and a rename rewrites only part of the history. Rows
      // from before keys were stored, and messages without a row (a publish
      // that landed while the history insert failed), fall back to the name.
      const isOwn = (msg: Message): boolean => {
        const row = senderNow.get(msg.id) as { from_agent: string; from_key: string | null } | undefined;
        if (row?.from_key) return row.from_key === inboxKey;
        return (row?.from_agent ?? msg.from).toLowerCase() === agentName.toLowerCase();
      };
      // Handed to this agent before? The broker delivers again when an ack
      // got lost, and a sender may repeat a send under the same id after the
      // broker's duplicate window. Once per reader either way.
      let readBefore: (id: string) => boolean = () => false;
      try {
        readBefore = readCheck(db, inboxKey);
      } catch (err) {
        log("warn", "reads cannot be asked in mesh_receive, nothing is taken for read", { agent: agentName, err: String(err) });
      }
      const drop = (data: Uint8Array, side: InboxSide): boolean => {
        let msg: Message;
        try {
          msg = deserializeMessage(data);
        } catch {
          return true; // unparseable
        }
        // Parses, but is no message (a hand-made publish of `null` or `42`).
        if (msg === null || typeof msg !== "object" || typeof msg.id !== "string" || typeof msg.created_at !== "string") return true;
        try {
          // Own before expired: an agent's own short-lived broadcast is not
          // "mail that expired before you read it".
          if (side === "broadcast" && isOwn(msg)) return true;
          // The same message a second time: in this pull, or in an earlier one.
          if (keptIds.has(msg.id) || readBefore(msg.id)) return true;
          if (isMessageExpired(msg)) {
            expired++;
            if (side === "inbox") ranOut.push(msg);
            return true; // past its delivery deadline
          }
        } catch (err) {
          // Cannot judge it (the history lookup failed): hand it out. A rule
          // that throws would abandon the whole batch unacked.
          log("warn", "drop rule failed in mesh_receive, keeping the message", { agent: agentName, msg_id: msg.id, err: String(err) });
        }
        kept.set(data, msg);
        keptIds.add(msg.id);
        return false;
      };

      // C4: NATS unavailability degrades gracefully — empty inbox plus a
      // hint so the caller knows to retry.
      let pull: Awaited<ReturnType<typeof nats.pullInbox>>;
      try {
        pull = await nats.pullInbox(inboxKey, limit, { drop });
      } catch (err) {
        log("warn", "nats pull failed in mesh_receive", {
          agent: agentName,
          err: String(err),
        });
        return ok({ messages: [], inbox_pending: null, hint: "nats_unavailable, retry shortly" });
      }

      const messages: ReturnType<typeof previewMessage<Message>>[] = [];
      let truncated = 0;

      for (const pm of pull.messages) {
        // Parsed already when `drop` looked at it. Never trust that alone: a
        // message that is acked here and not returned is lost.
        let msg = kept.get(pm.data);
        if (!msg) {
          try {
            msg = deserializeMessage(pm.data);
          } catch {
            pm.ack(); // unparseable — drop
            continue;
          }
        }
        pm.ack();
        const view = previewMessage(msg, previewChars);
        if (view.payload_truncated) truncated++;
        messages.push(view);
      }

      // The messages above are acked: whatever fails from here on, they are
      // returned. Everything below is bookkeeping and is allowed to fail.
      const handedOut = messages.map((m) => m.id);
      try {
        try {
          markRead(db, handedOut, inboxKey);
        } catch {
          // Once more: a lock held by a backup or the other container passes.
          await new Promise((r) => setTimeout(r, 50));
          markRead(db, handedOut, inboxKey);
        }
      } catch (err) {
        log("error", "reads could not be recorded in mesh_receive", { agent: agentName, count: handedOut.length, err: String(err) });
        // Say so per message, or the hourly sweep calls them expired unread.
        for (const id of handedOut) {
          try {
            activity.log({ action: READ_NOT_RECORDED, entity_type: "message", entity_id: id, summary: `${agentName} was handed ${id}; the read could not be stored`, agent_name: agentName });
          } catch {
            // The same database. Nothing more to do here.
          }
        }
      }
      for (const msg of ranOut) {
        try {
          noteExpired(db, activity, msg);
        } catch (err) {
          log("warn", "an expired message could not be noted", { agent: agentName, msg_id: msg.id, err: String(err) });
        }
      }

      // The count every other reply carries, from the pull's own numbers:
      // asking the broker again right now would still count what was just
      // acked (an ack is not processed the moment it is sent).
      let stillWaiting: number | null = null;
      try {
        stillWaiting = waitingFor(ctx, {
          total: pull.remaining,
          broadcast: pull.remainingBroadcast,
          broadcastDeliveredSeq: pull.broadcastDeliveredSeq,
          stream: pull.stream,
        });
      } catch (err) {
        log("warn", "inbox pending count failed in mesh_receive", { agent: agentName, err: String(err) });
      }
      const expiredNote = expired > 0 ? { expired_dropped: expired } : {};

      if (messages.length === 0) {
        return ok({
          messages: [],
          inbox_pending: stillWaiting,
          ...expiredNote,
          hint: expired > 0
            ? `No new messages. ${expired} message(s) had expired before you read them (ttl_seconds) and were dropped.`
            : "No new messages.",
        });
      }

      // The JetStream copy froze the names at send time. A rename rewrites
      // the history, so take from/to from there: an agent that answers a
      // renamed sender by name would otherwise be told it does not exist.
      let current = new Map<string, NameRow>();
      try {
        current = currentNames(db, messages.map((m) => m.id));
      } catch (err) {
        log("warn", "name lookup failed in mesh_receive, names as sent", { agent: agentName, err: String(err) });
      }
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
        inbox_pending: stillWaiting,
        ...expiredNote,
        ...(truncated > 0
          ? { hint: `${truncated} payload(s) truncated at preview_chars=${previewChars} — call mesh_get(message_id) for the full text.` }
          : {}),
      });
    },
  );

  // ── mesh_inbox ────────────────────────────────────────────────
  server.tool(
    "mesh_inbox",
    "Look at what was sent to you without taking anything out: your latest messages and broadcasts from the history, newest first, each with read_at — when mesh_receive handed it to you, or null — and expired: true when it ran out before you read it. Use it when an answer of mesh_receive got lost, or to see what expired before you read it. It acknowledges nothing; new mail still arrives through mesh_receive. unread counts what mesh_receive can still hand out (100 means 'at least a hundred'); never_handed_out counts what expired unread as well; inbox_pending is what the broker holds right now.",
    {
      limit: z.number().int().min(1).max(50).optional().describe("Max messages to return (default: 10, max: 50)"),
      unread_only: z.boolean().optional().describe("Only what mesh_receive has not handed to you yet, expired ones included (default: false)"),
      preview_chars: previewCharsField,
    },
    { readOnlyHint: true },
    async (params) => {
      if (ctx.isAdmin) return adminError();

      const previewChars = params.preview_chars ?? DEFAULT_PREVIEW_CHARS;
      const me = agents.getByName(agentName);
      const { rows, unread } = listInbox(db, {
        key: inboxKey,
        since: me?.inbox_since,
        limit: params.limit ?? 10,
        unreadOnly: params.unread_only === true,
      });

      const now = Date.now();
      let neverHandedOut = 0;
      let deliverable = 0;
      const messages = rows.map((row) => {
        const expires = expiresAt(row);
        const ranOut = row.read_at === null && expires !== null && Date.parse(expires) < now;
        if (row.read_at === null) {
          neverHandedOut++;
          if (!ranOut) deliverable++;
        }
        return previewMessage(
          {
            id: row.id,
            from: row.from_agent,
            to: row.to_agent,
            type: row.type,
            payload: row.payload,
            context: row.context,
            correlation_id: row.correlation_id,
            reply_to: row.reply_to,
            priority: row.priority,
            ttl_seconds: row.ttl_seconds,
            created_at: row.created_at,
            read_at: row.read_at,
            expires_at: expires,
            // Never handed out and past its deadline: it will not arrive.
            ...(ranOut ? { expired: true } : {}),
          },
          previewChars,
        );
      });

      void deliverable;
      return ok({
        messages,
        count: messages.length,
        // What mesh_receive can still hand out, in the whole inbox. Rows that
        // ran out unread are not among them: an agent that loops on this
        // number would otherwise spin on a message that never arrives.
        unread,
        never_handed_out: neverHandedOut,
        inbox_pending: await pendingCount(ctx),
        ...(messages.length === 0
          ? { hint: params.unread_only ? "Nothing unread in your inbox." : "Nothing in your inbox yet." }
          : {}),
      });
    },
  );
}
