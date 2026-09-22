import type Database from "better-sqlite3";
import type { MessagePriority, PaginatedResult } from "../types.js";

/**
 * Read-side query helpers for the `messages` table. Kept separate from
 * `message.ts` (which owns message construction + persistence) so the
 * dashboard / history views don't pull the write-side dependencies.
 *
 * Extracted from `src/index.tsx` as part of the C1 pragmatic split —
 * see Plexus entity `entities:mtffs16vivxmu73os93x` for the full-split
 * follow-up.
 */

/** Raw row shape from the messages table. Column names differ from the
 *  public `Message` type (`from_agent` vs `from`), so we map on read. */
interface MessageRow {
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
}

/** Public shape returned by the view/API layer. */
export interface MessageView {
  id: string;
  from: string;
  to: string;
  type: string;
  payload: string;
  context: string;
  correlation_id: string | null;
  reply_to: string | null;
  priority: MessagePriority;
  ttl_seconds: number;
  created_at: string;
}

function rowToMessageView(row: MessageRow): MessageView {
  return {
    id: row.id,
    from: row.from_agent,
    to: row.to_agent,
    type: row.type,
    payload: row.payload,
    context: row.context,
    correlation_id: row.correlation_id,
    reply_to: row.reply_to,
    priority: row.priority as MessagePriority,
    ttl_seconds: row.ttl_seconds,
    created_at: row.created_at,
  };
}

export type MessageRouting = "direct" | "broadcast";

/** Escape LIKE metacharacters so user input matches literally. */
function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

/**
 * Free-text filter shared by both list queries: substring match on
 * payload and context (case-insensitive for ASCII via LIKE), exact match
 * on message id / thread id. Returns an SQL fragment + its bindings.
 */
function searchCondition(q: string): { sql: string; bindings: unknown[] } {
  const like = likePattern(q);
  return {
    sql: "(payload LIKE ? ESCAPE '\\' OR context LIKE ? ESCAPE '\\' OR id = ? OR correlation_id = ?)",
    bindings: [like, like, q, q],
  };
}

function participantCondition(agent: string): { sql: string; bindings: unknown[] } {
  return {
    sql: "(from_agent = ? COLLATE NOCASE OR to_agent = ? COLLATE NOCASE)",
    bindings: [agent, agent],
  };
}

export interface ListMessagesParams {
  limit: number;
  offset: number;
  /** Sender or recipient, case-insensitive. */
  agent?: string;
  /** Free-text search (see `searchCondition`). Whitespace-only = no filter. */
  q?: string;
  routing?: MessageRouting;
}

/** A message as the Log table shows it: everything but the payload. */
export type MessageListItem = Omit<MessageView, "payload">;

const ITEM_COLUMNS =
  "id, from_agent, to_agent, type, context, correlation_id, reply_to, priority, ttl_seconds, created_at";

/**
 * Paginated list of messages, newest first, without the payload column: the
 * Log table never shows a payload, and it refreshes every few seconds.
 * `SELECT *` read up to 50 bodies of up to 256 KB each, every time, to throw
 * them away. All filters are applied in SQL so pagination and totals stay
 * correct (C2 — the dashboard used to filter only the 50 rows of the current
 * page, and only by context). The search still reaches into payloads.
 */
export function listMessageItems(
  db: Database.Database,
  params: ListMessagesParams,
): PaginatedResult<MessageListItem> {
  const { limit, offset, agent, routing } = params;
  const q = params.q?.trim();
  const conditions: string[] = [];
  const bindings: unknown[] = [];

  if (agent) {
    const c = participantCondition(agent);
    conditions.push(c.sql);
    bindings.push(...c.bindings);
  }
  if (q) {
    const c = searchCondition(q);
    conditions.push(c.sql);
    bindings.push(...c.bindings);
  }
  if (routing === "broadcast") conditions.push("to_agent = 'broadcast'");
  if (routing === "direct") conditions.push("to_agent != 'broadcast'");

  const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
  const rows = db
    .prepare(`SELECT ${ITEM_COLUMNS} FROM messages${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(...bindings, limit, offset) as Omit<MessageRow, "payload">[];

  const countRow = db
    .prepare(`SELECT COUNT(*) as total FROM messages${where}`)
    .get(...bindings) as { total: number } | undefined;
  const total = countRow?.total ?? 0;

  const data: MessageListItem[] = rows.map((row) => ({
    id: row.id,
    from: row.from_agent,
    to: row.to_agent,
    type: row.type,
    context: row.context,
    correlation_id: row.correlation_id,
    reply_to: row.reply_to,
    priority: row.priority as MessagePriority,
    ttl_seconds: row.ttl_seconds,
    created_at: row.created_at,
  }));
  return { data, has_more: offset + data.length < total, total, limit, offset };
}

interface ThreadAggregate {
  thread_id: string;
  started_at: string;
  last_activity: string;
  message_count: number;
}

/** One row of the Conversations list. No message bodies except the first,
 *  which the row previews. */
export interface ConversationSummary {
  thread_id: string;
  started_at: string;
  last_activity: string;
  message_count: number;
  first_payload: string;
  first_context: string | null;
  /** In order of appearance: first sender, first recipient, then whoever
   *  joins. Titles and bubble sides depend on [0] and [1]. */
  participants: string[];
}

/** A whole thread, for the open pane. */
export interface ConversationThread extends ConversationSummary {
  messages: MessageView[];
}

export interface ListConversationsParams {
  limit: number;
  offset: number;
  /** Only threads with at least one message matching the search. */
  q?: string;
  /** Only threads the agent took part in (sender or recipient). */
  agent?: string;
}

/** Parties in order of appearance. `rows` must already be in thread order. */
function partiesInOrder(rows: ReadonlyArray<{ from_agent: string; to_agent: string }>): string[] {
  const seen = new Set<string>();
  for (const row of rows) {
    seen.add(row.from_agent);
    seen.add(row.to_agent);
  }
  return Array.from(seen);
}

/** Thread order, everywhere: by time, and by insertion when two messages
 *  share a millisecond (a reply is never stored before its root; ULIDs of the
 *  same millisecond are not ordered). List and open thread have to agree on
 *  who spoke first. */
const THREAD_ORDER = "created_at ASC, rowid ASC";

/**
 * Thread root for any message id: replies carry the root in
 * `correlation_id`, the root message carries none. Unknown ids fall back to
 * the id itself (the root may already be rotated out).
 */
export function resolveThreadRoot(db: Database.Database, messageId: string): string {
  const row = db
    .prepare("SELECT COALESCE(correlation_id, id) AS root FROM messages WHERE id = ?")
    .get(messageId) as { root: string } | undefined;
  return row?.root ?? messageId;
}

/**
 * The thread a `correlation_id` may join: the id as it is when a thread of
 * that name exists, the thread of the message when it is a message id, null
 * when the history knows neither. Same precedence as `getThread`: a thread
 * id wins over a message that happens to have the same id.
 *
 * mesh_send used to take any string. A made-up one opened a thread nobody
 * could have meant, and the id of a reply opened a second thread next to the
 * one the reply belongs to.
 */
export function existingThread(db: Database.Database, id: string): string | null {
  if (!id) return null;
  const named = db
    .prepare("SELECT 1 FROM messages WHERE (correlation_id = ? OR id = ?) AND COALESCE(correlation_id, id) = ? LIMIT 1")
    .get(id, id, id);
  if (named) return id;
  const row = db
    .prepare("SELECT COALESCE(correlation_id, id) AS root FROM messages WHERE id = ?")
    .get(id) as { root: string } | undefined;
  return row?.root ?? null;
}

/** The id of the thread the newest message belongs to, straight from the
 *  created_at index. Null on an empty table. */
export function newestThreadId(db: Database.Database): string | null {
  const row = db
    .prepare("SELECT COALESCE(correlation_id, id) AS thread_id FROM messages ORDER BY created_at DESC, rowid DESC LIMIT 1")
    .get() as { thread_id: string } | undefined;
  return row?.thread_id ?? null;
}

/**
 * Paginated list of conversation threads, ordered by most-recent activity.
 * A thread is all messages sharing the same `correlation_id` (or the single
 * message itself if `correlation_id` is null — treated as a one-message
 * thread rooted on its own id). Filters select whole threads: a thread
 * is included when ANY of its messages matches.
 *
 * Summaries only. The page refreshes itself every few seconds, and this used
 * to load every payload of every thread on the page each time.
 */
export function listConversationSummaries(
  db: Database.Database,
  params: ListConversationsParams,
): PaginatedResult<ConversationSummary> {
  const { limit, offset, agent } = params;
  const q = params.q?.trim();

  const matchConditions: string[] = [];
  const matchBindings: unknown[] = [];
  if (q) {
    const c = searchCondition(q);
    matchConditions.push(c.sql);
    matchBindings.push(...c.bindings);
  }
  if (agent) {
    const c = participantCondition(agent);
    matchConditions.push(c.sql);
    matchBindings.push(...c.bindings);
  }
  // Restrict to threads that contain a matching message.
  const threadFilter = matchConditions.length > 0
    ? ` WHERE COALESCE(correlation_id, id) IN (
        SELECT DISTINCT COALESCE(correlation_id, id) FROM messages
        WHERE ${matchConditions.join(" AND ")})`
    : "";

  const countRow = db
    .prepare(
      `SELECT COUNT(*) as total FROM (
        SELECT DISTINCT COALESCE(correlation_id, id) FROM messages${threadFilter})`,
    )
    .get(...matchBindings) as { total: number } | undefined;
  const total = countRow?.total ?? 0;

  const aggregates = db
    .prepare(
      `SELECT
        COALESCE(correlation_id, id) AS thread_id,
        MIN(created_at) AS started_at,
        MAX(created_at) AS last_activity,
        COUNT(*) AS message_count
      FROM messages${threadFilter}
      GROUP BY COALESCE(correlation_id, id)
      ORDER BY MAX(created_at) DESC
      LIMIT ? OFFSET ?`,
    )
    .all(...matchBindings, limit, offset) as ThreadAggregate[];

  if (aggregates.length === 0) {
    return { data: [], has_more: false, total, limit, offset };
  }

  // Who took part, and which message came first — names and ids only.
  // Through the two indexes (the OR form, like getThread), and sorted here:
  // `WHERE COALESCE(...) IN` cannot use an index, and an ORDER BY makes the
  // planner walk the whole created_at index instead. This runs on every
  // refresh of every open tab.
  const placeholders = aggregates.map(() => "?").join(",");
  const threadIds = aggregates.map((a) => a.thread_id);
  const skeleton = (db
    .prepare(
      `SELECT COALESCE(correlation_id, id) AS thread_id, id, from_agent, to_agent, created_at, rowid AS seq
      FROM messages
      WHERE (correlation_id IN (${placeholders}) OR id IN (${placeholders}))
        AND COALESCE(correlation_id, id) IN (${placeholders})`,
    )
    .all(...threadIds, ...threadIds, ...threadIds) as {
      thread_id: string; id: string; from_agent: string; to_agent: string; created_at: string; seq: number;
    }[])
    // THREAD_ORDER: by time, then by insertion.
    .sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.seq - b.seq));

  const byThread = new Map<string, typeof skeleton>();
  for (const row of skeleton) {
    if (!byThread.has(row.thread_id)) byThread.set(row.thread_id, []);
    byThread.get(row.thread_id)!.push(row);
  }

  // One body per thread: the first message, whole. The row preview parses it
  // as JSON, so it cannot be cut in SQL.
  const firstIds = aggregates
    .map((a) => byThread.get(a.thread_id)?.[0]?.id)
    .filter((id): id is string => Boolean(id));
  const firsts = new Map<string, { payload: string; context: string | null }>();
  if (firstIds.length > 0) {
    const rows = db
      .prepare(`SELECT id, payload, context FROM messages WHERE id IN (${firstIds.map(() => "?").join(",")})`)
      .all(...firstIds) as { id: string; payload: string; context: string | null }[];
    for (const row of rows) firsts.set(row.id, row);
  }

  const data: ConversationSummary[] = aggregates.map((a) => {
    const rows = byThread.get(a.thread_id) ?? [];
    const first = rows[0] ? firsts.get(rows[0].id) : undefined;
    return {
      thread_id: a.thread_id,
      started_at: a.started_at,
      last_activity: a.last_activity,
      message_count: a.message_count,
      first_payload: first?.payload ?? "",
      first_context: first?.context ?? null,
      participants: partiesInOrder(rows),
    };
  });

  return { data, has_more: offset + data.length < total, total, limit, offset };
}

/** Every message of the thread with exactly this id, in thread order. The OR
 *  form uses both indexes. The COALESCE check keeps out a message that merely
 *  HAS this id while belonging to another thread. */
function threadRows(db: Database.Database, threadId: string): MessageRow[] {
  return db
    .prepare(
      `SELECT * FROM messages
      WHERE (correlation_id = ? OR id = ?) AND COALESCE(correlation_id, id) = ?
      ORDER BY ${THREAD_ORDER}`,
    )
    .all(threadId, threadId, threadId) as MessageRow[];
}

/**
 * One whole thread, by its thread id or by the id of ANY of its messages —
 * also one that is far outside the first page of the list. Null when nobody
 * knows the id.
 *
 * A thread id wins. mesh_send used to accept any correlation_id, also the id
 * of someone's reply: a legacy thread "X" can name a thread AND a message of
 * another thread.
 * Every link the dashboard builds carries a thread id, so reading X as a
 * message first would open the other thread from X's own row, and the pinned
 * fragment would swap a different conversation into the pane.
 */
export function getThread(db: Database.Database, id: string): ConversationThread | null {
  if (!id) return null;
  let root = id;
  let rows = threadRows(db, id);
  if (rows.length === 0) {
    root = resolveThreadRoot(db, id);
    if (root === id) return null;
    rows = threadRows(db, root);
    if (rows.length === 0) return null;
  }

  const first = rows[0]!;
  const last = rows.reduce((latest, row) => (row.created_at > latest ? row.created_at : latest), first.created_at);
  return {
    thread_id: root,
    started_at: first.created_at,
    last_activity: last,
    message_count: rows.length,
    first_payload: first.payload,
    first_context: first.context ?? null,
    participants: partiesInOrder(rows),
    messages: rows.map(rowToMessageView),
  };
}
