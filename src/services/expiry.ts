// A message that ran out before anybody read it. The sender set a deadline
// (`ttl_seconds`), mesh_receive drops what is past it, and until now nobody
// was told: not the sender, not the operator.
//
// Two places notice it, and both end here:
// - mesh_receive, when the recipient polls and the message is dropped;
// - the hourly sweep, for a recipient that does not poll at all, which is
//   the case a sender most needs to hear about.
//
// One audit row per message, whoever notices first. Direct messages only: a
// broadcast has no one reader who missed it.

import type Database from "better-sqlite3";
import type { ActivityService } from "./activity.js";
import { readsCutover } from "./reads.js";

export const MESSAGE_EXPIRED = "message_expired";
/** mesh_receive handed a message out and could not record the read. The
 *  sweep leaves such a message alone: it did not expire unread. */
export const READ_NOT_RECORDED = "read_not_recorded";

/** At most this many rows per sweep. The next sweep takes the rest. */
const SWEEP_LIMIT = 500;

export interface ExpiredMessage {
  id: string;
  from: string;
  to: string;
  ttl_seconds: number;
}

function deadline(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400} d`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600} h`;
  if (seconds % 60 === 0) return `${seconds / 60} min`;
  return `${seconds} s`;
}

/**
 * Write the audit row for one expired message, unless it has one. The names
 * come from the history when the row is there (a rename rewrites them), from
 * the envelope otherwise. False when it was noted before.
 */
export function noteExpired(db: Database.Database, activity: Pick<ActivityService, "log">, msg: ExpiredMessage): boolean {
  // Check and write under one lock: two processes on one volume (a deploy
  // overlap, the sweep of one and a receive of the other) wrote two rows.
  // The unique index idx_activity_once holds the same rule in the schema.
  return db.transaction((): boolean => {
    const noted = db
      .prepare("SELECT 1 FROM activity_log WHERE entity_id = ? AND action = ?")
      .get(msg.id, MESSAGE_EXPIRED);
    if (noted) return false;
    const row = db.prepare("SELECT from_agent, to_agent FROM messages WHERE id = ?").get(msg.id) as
      | { from_agent: string; to_agent: string }
      | undefined;
    const from = row?.from_agent ?? msg.from;
    const to = row?.to_agent ?? msg.to;
    activity.log({
      action: MESSAGE_EXPIRED,
      entity_type: "message",
      entity_id: msg.id,
      summary: `${from} → ${to}: expired unread, its deadline was ${deadline(msg.ttl_seconds)}`,
      agent_name: from,
    });
    return true;
  }).immediate();
}

/**
 * Direct messages past their deadline that their recipient was never handed.
 * Only what was stored since reads are recorded: everything older has no
 * read rows and would all count.
 */
export function sweepExpiredUnread(
  db: Database.Database,
  activity: Pick<ActivityService, "log">,
  now: number = Date.now(),
): number {
  const cutover = readsCutover(db);
  if (cutover === null) return 0;
  const rows = db
    .prepare(
      `SELECT m.id, m.from_agent AS "from", m.to_agent AS "to", m.ttl_seconds
         FROM messages m
        WHERE m.to_key IS NOT NULL AND m.to_key != ''
          AND m.created_at >= ?
          AND CAST(strftime('%s', m.created_at) AS INTEGER) + m.ttl_seconds < ?
          AND NOT EXISTS (SELECT 1 FROM message_reads r WHERE r.message_id = m.id AND r.reader_key = m.to_key)
          AND NOT EXISTS (SELECT 1 FROM activity_log a WHERE a.entity_id = m.id AND a.action IN (?, ?))
        ORDER BY m.created_at ASC
        LIMIT ?`,
    )
    .all(cutover, Math.floor(now / 1000), MESSAGE_EXPIRED, READ_NOT_RECORDED, SWEEP_LIMIT) as ExpiredMessage[];
  let noted = 0;
  for (const row of rows) if (noteExpired(db, activity, row)) noted++;
  return noted;
}
