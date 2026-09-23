// Who has read what. One row per message and reader in `message_reads`,
// written when mesh_receive hands a message out (migration 0010).
//
// Two things rest on it:
// - mesh_inbox: what was sent to an agent, with the moment it was handed out.
//   mesh_receive acks before its answer has reached the agent, and this is
//   where a message is found whose answer got lost.
// - "once per reader": a message that comes a second time under the same id
//   (the broker redelivers after a lost ack; a sender repeats a send whose
//   outcome it did not know, after the broker's duplicate window) is not
//   handed out again.

import type Database from "better-sqlite3";
import { FIELD_LIMITS } from "../types.js";

const MIGRATION = "0010_message_reads.sql";

/** When reads began to be recorded. What was stored before has no read rows
 *  and would all look unread. Null when it cannot be told: then nothing
 *  counts as "after". */
export function readsCutover(db: Database.Database): string | null {
  try {
    const row = db.prepare("SELECT applied_at FROM _migrations WHERE name = ?").get(MIGRATION) as
      | { applied_at: string }
      | undefined;
    return row?.applied_at ?? null;
  } catch {
    return null; // no migrations table: a database somebody built by hand
  }
}

/** Record that `readerKey` was handed these messages. Idempotent: the first
 *  time stays. Throws on a database error; the caller decides. */
export function markRead(db: Database.Database, ids: readonly string[], readerKey: string, now: Date = new Date()): void {
  if (ids.length === 0 || !readerKey) return;
  const insert = db.prepare("INSERT OR IGNORE INTO message_reads (message_id, reader_key, read_at) VALUES (?, ?, ?)");
  const at = now.toISOString();
  db.transaction(() => {
    for (const id of ids) insert.run(id, readerKey, at);
  })();
}

/** "Was this id handed to this reader before?" as one prepared question. */
export function readCheck(db: Database.Database, readerKey: string): (id: string) => boolean {
  const stmt = db.prepare("SELECT 1 FROM message_reads WHERE message_id = ? AND reader_key = ?");
  return (id) => stmt.get(id, readerKey) !== undefined;
}

export interface InboxRow {
  id: string;
  from_agent: string;
  to_agent: string;
  type: string;
  payload: string;
  context: string;
  correlation_id: string | null;
  reply_to: string | null;
  priority: string;
  ttl_seconds: number;
  created_at: string;
  read_at: string | null;
}

export interface InboxQuery {
  /** The reader's inbox key. */
  key: string;
  /** `agents.inbox_since`: from when on messages are for this agent. */
  since: string | null | undefined;
  limit: number;
  unreadOnly?: boolean;
}

// Direct mail by key, broadcasts (to_key '') by everyone but their sender.
// Both only from `since` on: the agent's own start, and never before reads
// were recorded. `to_key` is set by this code only: a row an older release
// wrote in a deploy overlap has NULL, and is left out of both halves (it has
// no reads and would look unread for ever).
const DIRECT = "m.to_key = @key AND m.created_at >= @since";
const BROADCASTS = "m.to_agent = 'broadcast' AND m.to_key = '' AND m.created_at >= @since AND (m.from_key IS NULL OR m.from_key != @key)";
const COLUMNS = "m.id, m.from_agent, m.to_agent, m.type, m.payload, m.context, m.correlation_id, m.reply_to, m.priority, m.ttl_seconds, m.created_at, r.read_at";
const READ_JOIN = "LEFT JOIN message_reads r ON r.message_id = m.id AND r.reader_key = @key";
/** How far `unread` counts. Above it the answer is `UNREAD_CAP + 1`, which
 *  reads as "more than this": an agent only acts on "is there any". */
export const UNREAD_CAP = 99;
/** The longest deadline a message can have. Nothing older is still due. */
const MAX_TTL_MS = FIELD_LIMITS.TTL_SECONDS_MAX * 1000;
/** Still deliverable: never handed out, and not past its deadline. The
 *  `strftime` cannot use an index, so `@oldestDue` prunes by created_at
 *  first: nothing older than the longest deadline can still be due. Without
 *  it the count walked a month of expired broadcasts before the first one
 *  that still counted. */
const STILL_DUE =
  "r.read_at IS NULL AND m.created_at >= @oldestDue AND CAST(strftime('%s', m.created_at) AS INTEGER) + m.ttl_seconds >= @nowSeconds";
/** Never handed out, deadline or no deadline: STILL_DUE plus what ran out
 *  before it was read. The same `@oldestDue` bound, for the same reason. */
const NEVER_READ = "r.read_at IS NULL AND m.created_at >= @oldestDue";

/** What was sent to an agent, newest first, and how much of it mesh_receive
 *  can still hand out. Two halves (each on its own index, each with its own
 *  LIMIT) joined by UNION ALL: one query over both used to walk every
 *  broadcast of the month. */
export function listInbox(
  db: Database.Database,
  q: InboxQuery,
  now: number = Date.now(),
): { rows: InboxRow[]; unread: number; neverHandedOut: number } {
  const cutover = readsCutover(db);
  if (!q.key || cutover === null) return { rows: [], unread: 0, neverHandedOut: 0 };
  const since = q.since && q.since > cutover ? q.since : cutover;
  const bind = {
    key: q.key,
    since,
    nowSeconds: Math.floor(now / 1000),
    oldestDue: new Date(now - MAX_TTL_MS).toISOString(),
  };
  const unreadOnly = q.unreadOnly ? " AND r.read_at IS NULL" : "";
  const half = (where: string) =>
    `SELECT * FROM (SELECT ${COLUMNS}, m.rowid AS rid FROM messages m ${READ_JOIN} WHERE ${where}${unreadOnly} ORDER BY m.created_at DESC, m.rowid DESC LIMIT @limit)`;

  const rows = db
    .prepare(`SELECT * FROM (${half(DIRECT)} UNION ALL ${half(BROADCASTS)}) ORDER BY created_at DESC, rid DESC LIMIT @limit`)
    .all({ ...bind, limit: q.limit }) as (InboxRow & { rid: number })[];
  // Bounded: the caller wants "how many are still due", and past the cap
  // "more than this". A full COUNT over a month of history cost 150 ms of
  // blocked event loop, and better-sqlite3 blocks every other request with it.
  const count = (where: string, due: string) =>
    (db.prepare(
      `SELECT COUNT(*) AS n FROM (SELECT 1 FROM messages m ${READ_JOIN} WHERE ${where} AND ${due}` +
        ` ORDER BY m.created_at DESC LIMIT ${UNREAD_CAP + 1})`,
    ).get(bind) as { n: number }).n;
  const both = (due: string) => Math.min(UNREAD_CAP + 1, count(DIRECT, due) + count(BROADCASTS, due));
  // Both are inbox-wide and bounded the same way. `never_handed_out` used to
  // be counted while mapping the returned page, so `limit` moved a number
  // documented as a property of the inbox: 17 unread and limit 10 answered
  // never_handed_out 10, and an agent that trusts the wording concludes seven
  // were already handed to it.
  return {
    rows: rows.map(({ rid: _rid, ...row }) => row),
    unread: both(STILL_DUE),
    neverHandedOut: both(NEVER_READ),
  };
}

/** What a sender can learn about a stored message: for a direct one when
 *  its recipient was handed it, for a broadcast how many agents were. Nothing
 *  for a row from before recipients were stored by key: it has no reads, and
 *  "unread" would be a guess. */
export type ReadState = { read_at: string | null } | { read_by: number } | Record<string, never>;

export function readStates(
  db: Database.Database,
  rows: readonly { id: string; to_agent: string; to_key?: string | null; created_at: string }[],
): Map<string, ReadState> {
  const states = new Map<string, ReadState>();
  const cutover = readsCutover(db);
  // Rows this code wrote carry a key ("" for a broadcast); older rows do not.
  const known = rows.filter((r) => cutover !== null && r.to_key !== null && r.to_key !== undefined);
  if (known.length === 0) return states;
  const reads = db
    .prepare(`SELECT message_id, reader_key, read_at FROM message_reads WHERE message_id IN (${known.map(() => "?").join(",")})`)
    .all(...known.map((r) => r.id)) as { message_id: string; reader_key: string; read_at: string }[];
  for (const row of known) {
    const mine = reads.filter((r) => r.message_id === row.id);
    states.set(
      row.id,
      row.to_key
        ? { read_at: mine.find((r) => r.reader_key === row.to_key)?.read_at ?? null }
        : { read_by: mine.length },
    );
  }
  return states;
}

/** Reads older than the history they belong to. By age, not by "its message
 *  is gone": a read without a history row is what keeps a repeated send from
 *  being handed out twice. */
export function rotateReads(db: Database.Database, retentionDays: number, now: number = Date.now()): number {
  const cutoff = new Date(now - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  return db.prepare("DELETE FROM message_reads WHERE read_at < ?").run(cutoff).changes;
}
