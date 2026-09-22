// The record of a send, made before it is published and removed once the
// history has the row (migration 0010, `send_attempts`).
//
// A send whose outcome is unknown (the broker did not answer) is repeated
// under its id, and the broker's duplicate window turns the two into one
// delivery. The repeat has to be the SENDER's, and it has to be the SAME
// message: without this record, any agent that had seen the id (a recipient
// of the late-arriving copy) could publish under it, the broker would
// deduplicate, and the history row would be written from the squatter's
// draft. The sender's own repeat was then refused for ever.
//
// Not an outbox: nothing here retries anything. A row is a fact about an
// attempt, and it is gone the moment the history knows the message.

import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { Message } from "../types.js";

export interface SendAttempt {
  message_id: string;
  from_key: string;
  from_agent: string;
  to_agent: string;
  to_key: string | null;
  subject: string;
  type: string;
  payload_sha256: string;
  context: string;
  correlation_id: string | null;
  reply_to: string | null;
  priority: string;
  ttl_seconds: number;
  created_at: string;
}

export function payloadHash(payload: string): string {
  return createHash("sha256").update(payload).digest("hex");
}

/** Records the attempt. Idempotent for a repeat of the same id. */
export function recordAttempt(db: Database.Database, msg: Message, where: { fromKey: string; toKey: string | null; subject: string }): void {
  db.prepare(
    `INSERT OR IGNORE INTO send_attempts
       (message_id, from_key, from_agent, to_agent, to_key, subject, type, payload_sha256, context, correlation_id, reply_to, priority, ttl_seconds, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id, where.fromKey, msg.from, msg.to, where.toKey, where.subject, msg.type, payloadHash(msg.payload),
    msg.context, msg.correlation_id, msg.reply_to, msg.priority, msg.ttl_seconds, msg.created_at,
  );
}

/** The caller's own attempt under this id, or null. Somebody else's is
 *  nobody's business: the answer is the same as for an id never seen. */
export function ownAttempt(db: Database.Database, id: string, fromKey: string): SendAttempt | null {
  const row = db.prepare("SELECT * FROM send_attempts WHERE message_id = ?").get(id) as SendAttempt | undefined;
  return row && row.from_key === fromKey ? row : null;
}

/** The message is in the history: the attempt has served. */
export function forgetAttempt(db: Database.Database, id: string): void {
  db.prepare("DELETE FROM send_attempts WHERE message_id = ?").run(id);
}

/** The envelope of the first attempt, rebuilt: what the recipient's copy
 *  says, whatever the repeat's call said. The payload is the caller's; its
 *  hash was checked against the record. */
export function envelopeOf(attempt: SendAttempt, payload: string): Message {
  return {
    id: attempt.message_id,
    from: attempt.from_agent,
    to: attempt.to_agent,
    type: attempt.type,
    payload,
    context: attempt.context,
    correlation_id: attempt.correlation_id,
    reply_to: attempt.reply_to,
    priority: attempt.priority as Message["priority"],
    ttl_seconds: attempt.ttl_seconds,
    created_at: attempt.created_at,
  };
}

/** Attempts older than the stream keeps a message: nothing can be repeated
 *  into a delivery any more, and the history row, if it ever came, came. */
export function rotateAttempts(db: Database.Database, retentionDays: number, now: number = Date.now()): number {
  const cutoff = new Date(now - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  return db.prepare("DELETE FROM send_attempts WHERE created_at < ?").run(cutoff).changes;
}
