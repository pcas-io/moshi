import { ulid } from "ulidx";
import type Database from "better-sqlite3";
import { publishMessageEvent } from "./message-events.js";
import type { Message, MessagePriority } from "../types";
import { MAX_PAYLOAD_BYTES, MAX_CONTEXT_LENGTH, DEFAULT_TTL_SECONDS } from "../types";
import { log } from "./logger.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function createMessage(params: {
  from: string;
  to: string;
  type: string;
  payload: string;
  context: string;
  correlation_id?: string;
  reply_to?: string;
  priority?: MessagePriority;
  ttl_seconds?: number;
}): Message {
  if (params.context.length > MAX_CONTEXT_LENGTH) {
    throw new Error(
      `Context exceeds maximum length of ${MAX_CONTEXT_LENGTH} chars (got ${params.context.length})`,
    );
  }

  const payloadBytes = encoder.encode(params.payload);
  if (payloadBytes.byteLength > MAX_PAYLOAD_BYTES) {
    throw new Error(
      `Payload exceeds maximum size of ${MAX_PAYLOAD_BYTES} bytes (got ${payloadBytes.byteLength})`,
    );
  }

  return {
    id: `msg_${ulid()}`,
    from: params.from,
    to: params.to,
    type: params.type,
    payload: params.payload,
    context: params.context,
    correlation_id: params.correlation_id ?? null,
    reply_to: params.reply_to ?? null,
    priority: params.priority ?? "normal",
    ttl_seconds: params.ttl_seconds ?? DEFAULT_TTL_SECONDS,
    created_at: new Date().toISOString(),
  };
}

/**
 * Checks whether a message has passed its delivery deadline.
 *
 * `ttl_seconds` is a **delivery deadline**, not a data-lifetime guarantee:
 *
 * - After expiry, `mesh_receive` silently acks and drops the message
 *   (see src/mcp/tools/messaging.ts:156) — an expired message will never
 *   be delivered to a recipient that wasn't polling fast enough.
 * - Expired messages **remain in SQLite** until the retention-based
 *   rotation (`rotateMessages(MESSAGE_RETENTION_DAYS)`, default 30 days)
 *   sweeps them away. They are visible via `mesh_history` until then.
 * - NATS JetStream enforces an independent 7-day MAX_AGE on the underlying
 *   stream (see src/services/nats.ts:18), which is a hard upper bound
 *   regardless of any per-message ttl_seconds.
 *
 * This separation is intentional: the bus semantics (delivery) and the
 * audit-trail semantics (history/compliance) are decoupled.
 */
export function isMessageExpired(msg: Message): boolean {
  const createdMs = new Date(msg.created_at).getTime();
  const expiresMs = createdMs + msg.ttl_seconds * 1000;
  return Date.now() > expiresMs;
}

export function serializeMessage(msg: Message): Uint8Array {
  return encoder.encode(JSON.stringify(msg));
}

export function deserializeMessage(data: Uint8Array): Message {
  return JSON.parse(decoder.decode(data)) as Message;
}

/**
 * Inserts a message row into the `messages` table. Throws on duplicate id
 * or any other SQLite error — the caller decides how to handle it.
 *
 * Kept separate from `sendAndPersistMessage` so the caller in tooling code
 * can reuse just the DB layer (e.g. tests, backfill scripts).
 */
export function persistMessage(db: Database.Database, msg: Message): void {
  db.prepare(
    `INSERT INTO messages (id, from_agent, to_agent, type, payload, context, correlation_id, reply_to, priority, ttl_seconds, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.from,
    msg.to,
    msg.type,
    msg.payload,
    msg.context,
    msg.correlation_id,
    msg.reply_to,
    msg.priority,
    msg.ttl_seconds,
    msg.created_at,
  );
}

/**
 * Minimal NATS surface needed by `sendAndPersistMessage`. Matches the
 * real `NatsService.publish` signature so a live service can be passed
 * directly, while tests can use a plain object with a `publish` spy.
 */
export interface NatsPublisher {
  publish(subject: string, data: Uint8Array, msgId: string): Promise<void>;
}

export interface SendResult {
  /**
   * True if the message was successfully handed to NATS. This is the
   * authoritative "did delivery happen" bit — callers should return
   * success to their clients when this is true, regardless of `persisted`.
   */
  delivered: boolean;
  /**
   * True if the message was successfully inserted into the SQLite history
   * table. `delivered=true && persisted=false` is a rare history-gap
   * scenario and is logged loudly (level=error, "CRITICAL" prefix).
   */
  persisted: boolean;
  /** Error code when `delivered=false`. Currently only `"nats_unavailable"`. */
  error?: "nats_unavailable";
}

/**
 * Dual-write order for mesh messages: NATS first, DB second.
 *
 * Rationale (see Mesh-ADR-006 in Plexus): NATS is the source-of-truth
 * for delivery, SQLite is a read-replica for history/audit. Publishing
 * NATS first means a failed publish leaves no row in the DB — no
 * "phantom-send" in `mesh_history`. If NATS succeeds but the DB insert
 * fails afterwards, the message IS delivered (that's what mattered) and
 * we log a CRITICAL event so the gap is observable.
 */
export async function sendAndPersistMessage(
  nats: NatsPublisher,
  db: Database.Database,
  msg: Message,
  subject: string,
): Promise<SendResult> {
  // 1. NATS publish FIRST — this IS the delivery act.
  try {
    await nats.publish(subject, serializeMessage(msg), msg.id);
  } catch (err) {
    log("error", "nats publish failed in sendAndPersistMessage", {
      msg_id: msg.id,
      from: msg.from,
      to: msg.to,
      subject,
      err: String(err),
    });
    return { delivered: false, persisted: false, error: "nats_unavailable" };
  }

  // 2. DB insert SECOND — read-replica for history. A failure here means
  // the message was delivered but is missing from history. Log loudly
  // ("CRITICAL" prefix) so the gap is visible, but return delivered=true
  // because the caller should see a successful send.
  try {
    persistMessage(db, msg);
  } catch (err) {
    log("error", "CRITICAL: message delivered but history insert failed", {
      msg_id: msg.id,
      from: msg.from,
      to: msg.to,
      err: String(err),
    });
    return { delivered: true, persisted: false };
  }

  // 3. Notify in-process subscribers (v2 dashboard SSE). Best-effort —
  // listener failures are swallowed inside publishMessageEvent so they
  // can never affect the send result.
  publishMessageEvent(msg);

  return { delivered: true, persisted: true };
}
