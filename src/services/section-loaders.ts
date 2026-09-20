// Loaders for the dashboard sections that refresh themselves.
//
// Each live section has exactly one loader, used by the full page route and
// by its /fragments route. Same query string in, same data out: that is what
// keeps a refreshed section identical to the one the page rendered.

import type Database from "better-sqlite3";
import { LIMITS } from "../types.js";
import type { PaginatedResult } from "../types.js";
import {
  getThread,
  listConversationSummaries,
  listMessageItems,
  newestThreadId,
} from "./message-queries.js";
import type {
  ConversationSummary,
  ConversationThread,
  MessageListItem,
  MessageRouting,
} from "./message-queries.js";

type QueryReader = (key: string) => string | undefined;

function readOffset(get: QueryReader): number {
  const parsed = parseInt(get("offset") ?? "0", 10);
  return isNaN(parsed) || parsed < 0 ? 0 : parsed;
}
const readText = (get: QueryReader, key: string): string | undefined => get(key)?.trim() || undefined;

// ── Conversations ────────────────────────────────────────────────
export interface ConversationsQuery {
  offset: number;
  q?: string;
  agent?: string;
  /** `?id=` — the thread to open: its thread id, or the id of any of its messages. */
  id?: string;
}

export function readConversationsQuery(get: QueryReader): ConversationsQuery {
  // The id is trimmed like the rest: ids are stored trimmed (createMessage,
  // migration 0006), and a pasted one often has a space at its end.
  return { offset: readOffset(get), q: readText(get, "q"), agent: readText(get, "agent"), id: readText(get, "id") };
}

export function loadConversationList(
  db: Database.Database,
  query: ConversationsQuery,
): PaginatedResult<ConversationSummary> {
  return listConversationSummaries(db, {
    limit: LIMITS.PAGINATION_DEFAULT,
    offset: query.offset,
    q: query.q,
    agent: query.agent,
  });
}

export interface OpenThread {
  opened: ConversationThread | null;
  /** Set when `?id=` named something that does not exist (any more). */
  unknownId?: string;
}

/**
 * The thread the pane shows: the one `?id=` names — wherever in the history
 * it is, and also when the id is a reply's — else the first of the page.
 * An id that matches nothing opens NOTHING. It used to open the first thread
 * of the page without a word, which made every stale deep link lie.
 */
export function loadOpenThread(
  db: Database.Database,
  query: Pick<ConversationsQuery, "id">,
  list: PaginatedResult<ConversationSummary>,
): OpenThread {
  if (query.id) {
    const opened = getThread(db, query.id);
    return opened ? { opened } : { opened: null, unknownId: query.id };
  }
  const first = list.data[0];
  return { opened: first ? getThread(db, first.thread_id) : null };
}

/** The most recently active thread, whole. For Home's "Latest conversation". */
export function loadLatestThread(db: Database.Database): ConversationThread | null {
  // Not listConversationSummaries({ limit: 1 }): that groups the whole table
  // to find one id, and Home asks again on every refresh.
  const id = newestThreadId(db);
  return id ? getThread(db, id) : null;
}

// ── Log, Messages tab ────────────────────────────────────────────
export interface LogMessagesQuery {
  offset: number;
  q?: string;
  agent?: string;
  routing?: MessageRouting;
}

export function loadLogMessages(
  db: Database.Database,
  query: LogMessagesQuery,
): PaginatedResult<MessageListItem> {
  return listMessageItems(db, {
    limit: LIMITS.PAGINATION_DEFAULT,
    offset: query.offset,
    agent: query.agent,
    q: query.q,
    routing: query.routing,
  });
}

export { readOffset, readText };
export type { QueryReader };
