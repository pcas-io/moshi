// The calls that are due: which message opens one, which join it, who takes
// it, and what an attempt's outcome does to it and to its hook.
//
// A delivery is open from the first matching message until a dispatcher
// takes it, thirty seconds later; everything for the same agent in between
// joins it (one OPEN delivery per agent, a unique index). Taking it closes it
// and leases it, in one transaction, so two processes on one volume (a deploy)
// never call the same hook for the same delivery at once. A lease runs out:
// a process that died with a call in flight leaves it to the next one, under
// the same `webhook-id`, which is what the receiver deduplicates on.
//
// Nothing here may throw into a send. `enqueue` is called after a message
// went out, and a hook is never a reason to tell a sender it failed.

import { ulid } from "ulidx";
import type Database from "better-sqlite3";
import type { Message, MessagePriority } from "../types.js";
import { MESSAGE_PRIORITIES } from "../types.js";
import { WEBHOOK_LIMITS, kindOf, intervalFor } from "./webhooks.js";
import { log } from "./logger.js";

/** From the first message to the call: one call for everything in between. */
export const BUNDLE_WINDOW_MS = 30_000;
export const MAX_ATTEMPTS = 3;
/** Wait before attempt 2 and before attempt 3. */
export const RETRY_DELAYS_MS = [10_000, 60_000] as const;
/** Failed deliveries in a row that switch a hook off. */
export const DISABLE_AFTER_FAILURES = 5;
/** A call takes at most 5 s (DELIVERY_TIMEOUT_MS) plus a DNS lookup. */
export const LEASE_MS = 30_000;
/** A body lists at most this many messages; `count` has the total. */
export const MAX_LISTED_MESSAGES = 20;

/** Only what a receiver may read: no payload, no context. Agent-controlled
 *  free text is cut down to what an identifier looks like, because the body
 *  ends up in a bot's prompt (Grok hands it over as `<webhook_event>`). */
export interface AnnouncedMessage {
  message_id: string;
  from: string;
  to: string;
  type: string;
  priority: MessagePriority;
  correlation_id: string | null;
  created_at: string;
}

export interface Claim {
  id: string;
  agentKey: string;
  attempt: number;
}

export type FailureOutcome = "retry" | "failed" | "disabled" | "gone";

const TYPE_SHAPE = /^[a-z0-9_.-]{1,32}$/;
const CORRELATION_SHAPE = /^[A-Za-z0-9_.:-]{1,64}$/;

/** A type the bot can read as a word, or "other". The message keeps its own. */
export function announcedType(type: string): string {
  return TYPE_SHAPE.test(type) ? type : "other";
}

const rank = (p: string): number => (MESSAGE_PRIORITIES as readonly string[]).indexOf(p);

interface HookFilter {
  agent_key: string;
  url: string;
  types: string | null;
  min_priority: MessagePriority;
  min_interval_seconds: number | null;
  last_call_at: number | null;
}

/** When a delivery opened now is due: after the bundle window, and not
 *  before the hook's interval since its last call has passed. */
function dueAt(hook: HookFilter, now: number): number {
  const interval = intervalFor(kindOf(hook.url), hook.min_interval_seconds) * 1000;
  return Math.max(now + BUNDLE_WINDOW_MS, (hook.last_call_at ?? 0) + interval);
}

function wants(hook: HookFilter, msg: Message): boolean {
  if (rank(msg.priority) < rank(hook.min_priority)) return false;
  if (hook.types === null) return true;
  const types = JSON.parse(hook.types) as string[];
  return types.includes(msg.type);
}

/**
 * Puts `msg` into the open delivery of every agent whose hook wants it, and
 * opens one where there is none. A direct message goes to its recipient's
 * hook, a broadcast to every hook that asked for broadcasts. Never to the
 * sender's own hook. Returns how many agents it was queued for.
 */
export function enqueue(db: Database.Database, msg: Message, fromKey: string, toKey: string | null, now: number = Date.now()): number {
  try {
    const hooks = (
      toKey === ""
        ? db
            .prepare(
              `SELECT h.agent_key, h.url, h.types, h.min_priority, h.min_interval_seconds, h.last_call_at
                 FROM agent_webhooks h JOIN agents a ON a.inbox_key = h.agent_key
                WHERE h.include_broadcasts = 1 AND h.state = 'active' AND a.is_active = 1 AND h.agent_key != ?`,
            )
            .all(fromKey)
        : toKey === null || toKey === fromKey
          ? []
          : db
              .prepare(
                `SELECT agent_key, url, types, min_priority, min_interval_seconds, last_call_at FROM agent_webhooks
                  WHERE agent_key = ? AND state = 'active'`,
              )
              .all(toKey)
    ) as HookFilter[];
    const targets = hooks.filter((h) => wants(h, msg));
    if (targets.length === 0) return 0;

    const openOne = db.prepare("SELECT id FROM webhook_deliveries WHERE agent_key = ? AND closed_at IS NULL");
    const create = db.prepare("INSERT INTO webhook_deliveries (id, agent_key, due_at, attempts, created_at) VALUES (?, ?, ?, 0, ?)");
    const add = db.prepare(
      `INSERT OR IGNORE INTO webhook_delivery_messages (delivery_id, message_id, from_agent, to_agent, type, priority, correlation_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const write = db.transaction(() => {
      for (const hook of targets) {
        let open = openOne.get(hook.agent_key) as { id: string } | undefined;
        if (!open) {
          open = { id: `wh_${ulid()}` };
          create.run(open.id, hook.agent_key, dueAt(hook, now), new Date(now).toISOString());
        }
        add.run(open.id, msg.id, msg.from, msg.to, msg.type, msg.priority, msg.correlation_id, msg.created_at);
      }
    });
    write.immediate();
    return targets.length;
  } catch (err) {
    log("error", "webhook enqueue failed", { message_id: msg.id, err: String(err) });
    return 0;
  }
}

/** Takes up to `limit` deliveries that are due and not leased by anybody. */
export function claimDue(db: Database.Database, limit: number, now: number = Date.now()): Claim[] {
  // Asked once a second by every process on the volume: a plain read first,
  // so that an idle mesh never takes the write lock for it.
  if (!db.prepare("SELECT 1 FROM webhook_deliveries WHERE due_at <= ? AND (lease_until IS NULL OR lease_until <= ?) LIMIT 1").get(now, now)) {
    return [];
  }
  const take = db.transaction(() => {
    const due = db
      .prepare(
        `SELECT d.id, d.agent_key, d.attempts FROM webhook_deliveries d
           JOIN agent_webhooks h ON h.agent_key = d.agent_key AND h.state = 'active'
          WHERE d.due_at <= ? AND (d.lease_until IS NULL OR d.lease_until <= ?)
          ORDER BY d.due_at LIMIT ?`,
      )
      .all(now, now, limit) as { id: string; agent_key: string; attempts: number }[];
    const lease = db.prepare(
      "UPDATE webhook_deliveries SET closed_at = COALESCE(closed_at, ?), lease_until = ?, attempts = attempts + 1 WHERE id = ?",
    );
    // The interval counts from here: the call is made now, whatever comes of it.
    const called = db.prepare("UPDATE agent_webhooks SET last_call_at = ? WHERE agent_key = ?");
    return due.map((d) => {
      lease.run(now, now + LEASE_MS, d.id);
      called.run(now, d.agent_key);
      return { id: d.id, agentKey: d.agent_key, attempt: d.attempts + 1 };
    });
  });
  return take.immediate();
}

/** What a delivery announces: the newest `MAX_LISTED_MESSAGES`, oldest first. */
export function announced(db: Database.Database, deliveryId: string): { count: number; messages: AnnouncedMessage[] } {
  const { count } = db.prepare("SELECT COUNT(*) AS count FROM webhook_delivery_messages WHERE delivery_id = ?").get(deliveryId) as { count: number };
  const rows = db
    .prepare(
      `SELECT message_id, from_agent, to_agent, type, priority, correlation_id, created_at FROM webhook_delivery_messages
        WHERE delivery_id = ? ORDER BY created_at DESC, message_id DESC LIMIT ?`,
    )
    .all(deliveryId, MAX_LISTED_MESSAGES) as {
      message_id: string; from_agent: string; to_agent: string; type: string; priority: MessagePriority; correlation_id: string | null; created_at: string;
    }[];
  const messages = rows.reverse().map((r) => ({
    message_id: r.message_id,
    from: r.from_agent,
    to: r.to_agent,
    type: announcedType(r.type),
    priority: r.priority,
    // A legacy thread can carry a free-form name: as text in a prompt it is
    // as good as a payload, so only an id-shaped one goes out.
    correlation_id: r.correlation_id !== null && CORRELATION_SHAPE.test(r.correlation_id) ? r.correlation_id : null,
    created_at: r.created_at,
  }));
  return { count, messages };
}

/** A delivery with nothing left to call (the agent was deactivated): gone. */
export function drop(db: Database.Database, claim: Claim): void {
  db.prepare("DELETE FROM webhook_deliveries WHERE id = ?").run(claim.id);
}

/**
 * The receiver is busy (429, or 503 with a time to come back) and said when
 * to come back: the delivery waits that long and keeps collecting. It is no
 * failure and costs no attempt: the receiver is there, only busy.
 */
export function recordDeferred(
  db: Database.Database,
  claim: Claim,
  waitSeconds: number,
  error: string,
  now: number = Date.now(),
): "deferred" | "gone" {
  const defer = db.transaction((): "deferred" | "gone" => {
    const moved = db
      .prepare("UPDATE webhook_deliveries SET due_at = ?, lease_until = NULL, attempts = MAX(attempts - 1, 0) WHERE id = ?")
      .run(now + waitSeconds * 1000, claim.id).changes;
    if (moved === 0) return "gone";
    db.prepare("UPDATE agent_webhooks SET last_error = ? WHERE agent_key = ?")
      .run(`${error.slice(0, WEBHOOK_LIMITS.ERROR - 40)} (busy, next try in ${waitSeconds} s)`, claim.agentKey);
    return "deferred";
  });
  return defer.immediate();
}

/** The delivery is done. A hook that was replaced meanwhile is left alone. */
export function recordSuccess(db: Database.Database, claim: Claim, now: number = Date.now()): void {
  const done = db.transaction(() => {
    if (db.prepare("DELETE FROM webhook_deliveries WHERE id = ?").run(claim.id).changes === 0) return;
    db.prepare("UPDATE agent_webhooks SET consecutive_failures = 0, last_success_at = ? WHERE agent_key = ?")
      .run(new Date(now).toISOString(), claim.agentKey);
  });
  done.immediate();
}

/**
 * One attempt failed. Another one follows if the error may pass and attempts
 * are left; otherwise the delivery is given up, and the fifth given-up
 * delivery in a row switches the hook off and drops what it still had queued.
 */
export function recordFailure(
  db: Database.Database,
  claim: Claim,
  failure: { retryable: boolean; error: string },
  now: number = Date.now(),
): FailureOutcome {
  const error = failure.error.slice(0, WEBHOOK_LIMITS.ERROR);
  const iso = new Date(now).toISOString();
  const record = db.transaction((): FailureOutcome => {
    const still = db.prepare("SELECT 1 FROM webhook_deliveries WHERE id = ?").get(claim.id);
    if (!still) return "gone";
    db.prepare("UPDATE agent_webhooks SET last_failure_at = ?, last_error = ? WHERE agent_key = ?").run(iso, error, claim.agentKey);
    if (failure.retryable && claim.attempt < MAX_ATTEMPTS) {
      db.prepare("UPDATE webhook_deliveries SET due_at = ?, lease_until = NULL WHERE id = ?")
        .run(now + RETRY_DELAYS_MS[claim.attempt - 1], claim.id);
      return "retry";
    }
    db.prepare("DELETE FROM webhook_deliveries WHERE id = ?").run(claim.id);
    const { consecutive_failures } = db
      .prepare("UPDATE agent_webhooks SET consecutive_failures = consecutive_failures + 1 WHERE agent_key = ? RETURNING consecutive_failures")
      .get(claim.agentKey) as { consecutive_failures: number };
    if (consecutive_failures < DISABLE_AFTER_FAILURES) return "failed";
    db.prepare("UPDATE agent_webhooks SET state = 'disabled', disabled_at = ? WHERE agent_key = ?").run(iso, claim.agentKey);
    db.prepare("DELETE FROM webhook_deliveries WHERE agent_key = ?").run(claim.agentKey);
    return "disabled";
  });
  return record.immediate();
}
