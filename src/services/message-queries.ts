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

/**
 * Paginated list of messages, newest first. Optional agent filter matches
 * either `from_agent` or `to_agent` case-insensitively.
 */
export function listMessages(
  db: Database.Database,
  params: { limit: number; offset: number; agent?: string },
): PaginatedResult<MessageView> {
  const { limit, offset, agent } = params;
  const conditions: string[] = [];
  const bindings: unknown[] = [];

  if (agent) {
    conditions.push("(from_agent = ? COLLATE NOCASE OR to_agent = ? COLLATE NOCASE)");
    bindings.push(agent, agent);
  }

  const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
  const rows = db
    .prepare(`SELECT * FROM messages${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .all(...bindings, limit, offset) as MessageRow[];

  const countRow = db
    .prepare(`SELECT COUNT(*) as total FROM messages${where}`)
    .get(...bindings) as { total: number } | undefined;

  const total = countRow?.total ?? 0;
  const data = rows.map(rowToMessageView);

  return {
    data,
    has_more: offset + data.length < total,
    total,
    limit,
    offset,
  };
}

interface ThreadSummary {
  thread_id: string;
  started_at: string;
  last_activity: string;
  message_count: number;
}

export interface ConversationThread {
  thread_id: string;
  started_at: string;
  last_activity: string;
  message_count: number;
  first_payload: string;
  first_context: string | null;
  participants: string[];
  messages: MessageView[];
}

/**
 * Paginated list of conversation threads, ordered by most-recent activity.
 * A thread is all messages sharing the same `correlation_id` (or the single
 * message itself if `correlation_id` is null — treated as a one-message
 * thread rooted on its own id).
 */
export function listConversations(
  db: Database.Database,
  params: { limit: number; offset: number },
): PaginatedResult<ConversationThread> {
  const { limit, offset } = params;

  // Count total threads
  const countRow = db
    .prepare(
      "SELECT COUNT(*) as total FROM (SELECT DISTINCT COALESCE(correlation_id, id) FROM messages)",
    )
    .get() as { total: number } | undefined;
  const total = countRow?.total ?? 0;

  // Get thread summaries (paginated)
  const summaries = db
    .prepare(
      `SELECT
        COALESCE(correlation_id, id) AS thread_id,
        MIN(created_at) AS started_at,
        MAX(created_at) AS last_activity,
        COUNT(*) AS message_count
      FROM messages
      GROUP BY COALESCE(correlation_id, id)
      ORDER BY MAX(created_at) DESC
      LIMIT ? OFFSET ?`,
    )
    .all(limit, offset) as ThreadSummary[];

  if (summaries.length === 0) {
    return { data: [], has_more: false, total, limit, offset };
  }

  // Fetch all messages for visible threads
  const placeholders = summaries.map(() => "?").join(",");
  const threadIds = summaries.map((s) => s.thread_id);
  const rows = db
    .prepare(
      `SELECT * FROM messages
      WHERE COALESCE(correlation_id, id) IN (${placeholders})
      ORDER BY created_at ASC`,
    )
    .all(...threadIds) as MessageRow[];

  // Group messages by thread
  const messagesByThread = new Map<string, MessageRow[]>();
  for (const row of rows) {
    const tid = row.correlation_id ?? row.id;
    if (!messagesByThread.has(tid)) messagesByThread.set(tid, []);
    messagesByThread.get(tid)!.push(row);
  }

  // Build conversation threads
  const data: ConversationThread[] = summaries.map((s) => {
    const msgs = messagesByThread.get(s.thread_id) ?? [];
    const participantSet = new Set<string>();
    for (const m of msgs) {
      participantSet.add(m.from_agent);
      participantSet.add(m.to_agent);
    }
    const first = msgs[0];
    return {
      thread_id: s.thread_id,
      started_at: s.started_at,
      last_activity: s.last_activity,
      message_count: s.message_count,
      first_payload: first?.payload ?? "",
      first_context: first?.context ?? null,
      participants: Array.from(participantSet),
      messages: msgs.map(rowToMessageView),
    };
  });

  return { data, has_more: offset + data.length < total, total, limit, offset };
}
