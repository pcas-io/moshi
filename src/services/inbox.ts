/**
 * Inbox pull logic on top of JetStream pull consumers — kept free of the
 * live `NatsService` so it can be unit-tested with fake consumers.
 *
 * Two consumers back one agent inbox: `agent-<key>` (direct messages) and
 * `agent-<key>-broadcast` (mesh.broadcast), where `<key>` is the agent's
 * immutable `inbox_key` — not its name, which can be renamed. Both are
 * consulted for every pull, and `limit` is shared across them (D5).
 *
 * The important efficiency rule (D1): a JetStream `fetch()` blocks until
 * `max_messages` arrive OR `expires` elapses. On an empty or half-empty
 * inbox that is a multi-second stall on every `mesh_receive`. So we read
 * the consumer info first — `num_pending` (never delivered) plus
 * `num_ack_pending` (delivered, unacked, waiting for redelivery) — and
 * only fetch when there is something to fetch, sized to what is there.
 */

export interface PulledMessage {
  data: Uint8Array;
  ack: () => void;
}

/** Minimal surface of a nats.js `Consumer` this module needs. */
export interface PullConsumer {
  info(cached?: boolean): Promise<{ num_pending: number; num_ack_pending: number }>;
  fetch(opts: { max_messages: number; expires: number }): Promise<
    AsyncIterable<{ data: Uint8Array; ack: () => void }>
  >;
}

/** Resolves a durable consumer by name. Throws a "consumer not found"
 *  error (see `isConsumerNotFound`) when it does not exist yet. */
export interface ConsumerSource {
  get(name: string): Promise<PullConsumer>;
}

export interface InboxPull {
  messages: PulledMessage[];
  /** Messages still waiting after this pull (best-effort snapshot). */
  remaining: number;
}

export interface InboxPending {
  inbox: number;
  broadcast: number;
  total: number;
}

/** Wait budget for a fetch that we already know has messages. */
const INBOX_FETCH_EXPIRES_MS = 2000;
const BROADCAST_FETCH_EXPIRES_MS = 1000;

export function inboxConsumerName(inboxKey: string): string {
  return `agent-${inboxKey.toLowerCase()}`;
}

export function broadcastConsumerName(inboxKey: string): string {
  return `agent-${inboxKey.toLowerCase()}-broadcast`;
}

/** nats.js surfaces a missing durable as a NatsError carrying the
 *  JetStream API error 10014 ("consumer not found"). Anything else — a
 *  broker outage, a timeout — must propagate so callers can degrade. */
export function isConsumerNotFound(err: unknown): boolean {
  const e = err as { api_error?: { err_code?: number }; message?: unknown };
  if (e?.api_error?.err_code === 10014) return true;
  return /consumer not found/i.test(String(e?.message ?? ""));
}

async function pendingOf(
  source: ConsumerSource,
  name: string,
): Promise<{ consumer: PullConsumer; pending: number } | null> {
  let consumer: PullConsumer;
  try {
    consumer = await source.get(name);
  } catch (err) {
    if (isConsumerNotFound(err)) return null;
    throw err;
  }
  const info = await consumer.info(false);
  return { consumer, pending: info.num_pending + info.num_ack_pending };
}

async function pullFrom(
  source: ConsumerSource,
  name: string,
  limit: number,
  expires: number,
): Promise<{ messages: PulledMessage[]; pending: number }> {
  const found = await pendingOf(source, name);
  if (!found || found.pending === 0 || limit <= 0) {
    return { messages: [], pending: found?.pending ?? 0 };
  }
  const batch = Math.min(limit, found.pending);
  const iter = await found.consumer.fetch({ max_messages: batch, expires });
  const messages: PulledMessage[] = [];
  for await (const m of iter) {
    messages.push({ data: m.data, ack: () => m.ack() });
  }
  return { messages, pending: found.pending };
}

/**
 * Pull up to `limit` messages for the inbox `inboxKey` — direct inbox
 * first, then broadcasts with whatever budget is left. Never blocks on an
 * empty consumer.
 */
export async function pullInbox(
  source: ConsumerSource,
  inboxKey: string,
  limit: number,
): Promise<InboxPull> {
  const inbox = await pullFrom(
    source,
    inboxConsumerName(inboxKey),
    limit,
    INBOX_FETCH_EXPIRES_MS,
  );
  const broadcast = await pullFrom(
    source,
    broadcastConsumerName(inboxKey),
    limit - inbox.messages.length,
    BROADCAST_FETCH_EXPIRES_MS,
  );
  const messages = [...inbox.messages, ...broadcast.messages];
  const remaining = Math.max(
    0,
    inbox.pending + broadcast.pending - messages.length,
  );
  return { messages, remaining };
}

/** Count waiting messages without pulling anything. */
export async function inboxPending(
  source: ConsumerSource,
  inboxKey: string,
): Promise<InboxPending> {
  const inbox = await pendingOf(source, inboxConsumerName(inboxKey));
  const broadcast = await pendingOf(source, broadcastConsumerName(inboxKey));
  const a = inbox?.pending ?? 0;
  const b = broadcast?.pending ?? 0;
  return { inbox: a, broadcast: b, total: a + b };
}
