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
 *
 * Not everything in a consumer is a message for its agent: its own
 * broadcasts come back to it (every agent's broadcast consumer reads
 * `mesh.broadcast`), and a message can be past its delivery deadline. The
 * caller says which ones those are (`drop`). They are acked here and do not
 * take a place in `limit`: the pull goes on until the limit is filled with
 * messages that count, or the consumer is empty.
 */

export interface PulledMessage {
  data: Uint8Array;
  ack: () => void;
}

/** Minimal surface of a nats.js `Consumer` this module needs. */
export interface PullConsumer {
  info(cached?: boolean): Promise<{
    num_pending: number;
    num_ack_pending: number;
    /** Stream sequence of the last message handed out. */
    delivered?: { stream_seq: number };
  }>;
  fetch(opts: { max_messages: number; expires: number }): Promise<
    AsyncIterable<{ data: Uint8Array; ack: () => void; /** stream sequence */ seq?: number }>
  >;
}

/** Resolves a durable consumer by name. Throws a "consumer not found"
 *  error (see `isConsumerNotFound`) when it does not exist yet. */
export interface ConsumerSource {
  get(name: string): Promise<PullConsumer>;
}

/** Which of the two consumers a message came out of. */
export type InboxSide = "inbox" | "broadcast";

export interface PullOptions {
  /** True for a message that is not one for this agent: acked, not returned,
   *  not counted against the limit. */
  drop?: (data: Uint8Array, side: InboxSide) => boolean;
}

/** See `StreamBounds` in message.ts. The pull itself knows consumers only;
 *  NatsService fills this in when broadcasts are waiting. */
export interface InboxStream { created: string; firstSeq: number; lastSeq: number }

export interface InboxPull {
  messages: PulledMessage[];
  /** Messages still waiting after this pull (best-effort snapshot). */
  remaining: number;
  /** The part of `remaining` that sits in the broadcast consumer. */
  remainingBroadcast: number;
  /** How far the broadcast consumer has read after this pull; null without
   *  one. See `InboxPending.broadcastDeliveredSeq`. */
  broadcastDeliveredSeq: number | null;
  /** The stream those sequences belong to; null when it was not asked. */
  stream: InboxStream | null;
  /** How many `drop` took out (and acked) on the way. */
  dropped: number;
  /** A durable of this inbox was not there. The caller remembers which keys
   *  it has ensured; this tells it to look again, instead of reporting an
   *  empty inbox for as long as the process lives. */
  missing: boolean;
}

export interface InboxPending {
  inbox: number;
  broadcast: number;
  total: number;
  /** Stream sequence up to which the broadcast consumer has handed out
   *  messages; null without one. `broadcast` still counts the agent's OWN
   *  broadcasts behind this point, and only the caller knows which those are. */
  broadcastDeliveredSeq: number | null;
  /** The stream that sequence belongs to; null when it was not asked. */
  stream: InboxStream | null;
  /** See `InboxPull.missing`. */
  missing: boolean;
}

/** How often one pull asks again after dropping messages. With the default
 *  limit of 10 that clears 250 stale messages per call; a consumer with more
 *  takes a few calls, and `remaining` says so. */
const MAX_PULL_ROUNDS = 25;

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
): Promise<{ consumer: PullConsumer; pending: number; deliveredSeq: number | null } | null> {
  let consumer: PullConsumer;
  try {
    consumer = await source.get(name);
  } catch (err) {
    if (isConsumerNotFound(err)) return null;
    throw err;
  }
  const info = await consumer.info(false);
  return {
    consumer,
    pending: info.num_pending + info.num_ack_pending,
    deliveredSeq: info.delivered?.stream_seq ?? null,
  };
}

/** nats.js ends a fetch with "503 no responders" when the durable is deleted
 *  between the info and the fetch. That is a consumer that vanished, not a
 *  broker that is gone — the info has just been answered. */
function isNoResponders(err: unknown): boolean {
  return (err as { code?: unknown })?.code === "503";
}

async function pullFrom(
  source: ConsumerSource,
  name: string,
  limit: number,
  expires: number,
  drop?: (data: Uint8Array) => boolean,
): Promise<{ messages: PulledMessage[]; pending: number; missing: boolean; dropped: number; deliveredSeq: number | null }> {
  const found = await pendingOf(source, name);
  if (!found) return { messages: [], pending: 0, missing: true, dropped: 0, deliveredSeq: null };

  // One look at the broker's counts, then own arithmetic. A second look would
  // count what was just handed out as "waiting for redelivery" (the caller
  // acks after the pull, and an ack is not processed the moment it is sent),
  // and the next fetch would sit out its deadline waiting for those.
  let available = found.pending;
  let deliveredSeq = found.deliveredSeq;
  const messages: PulledMessage[] = [];
  let dropped = 0;
  for (let round = 0; round < MAX_PULL_ROUNDS; round++) {
    // Never more than there is room for: a message that is fetched and then
    // not returned sits out the ack wait and uses up one of its deliveries.
    const want = Math.min(limit - messages.length, available);
    if (want <= 0) break;
    let fetched = 0;
    let droppedNow = 0;
    try {
      const iter = await found.consumer.fetch({ max_messages: want, expires });
      for await (const m of iter) {
        fetched++;
        if (typeof m.seq === "number" && m.seq > (deliveredSeq ?? 0)) deliveredSeq = m.seq;
        // Read once: nats.js builds `data` anew on every access, and the
        // caller may remember what it parsed by this very object.
        const data = m.data;
        if (drop?.(data)) {
          m.ack();
          droppedNow++;
        } else {
          messages.push({ data, ack: () => m.ack() });
        }
      }
    } catch (err) {
      if (!isNoResponders(err)) throw err;
      // What was already handed over stays handed over.
      return { messages, pending: 0, missing: true, dropped: dropped + droppedNow, deliveredSeq };
    }
    dropped += droppedNow;
    available = Math.max(0, available - fetched);
    // Less than asked for: the rest is waiting for redelivery, and the fetch
    // has already sat out its deadline for it. Nothing dropped: nothing to
    // make up for.
    if (fetched < want || droppedNow === 0) break;
  }
  return { messages, pending: available, missing: false, dropped, deliveredSeq };
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
  opts: PullOptions = {},
): Promise<InboxPull> {
  const { drop } = opts;
  const inbox = await pullFrom(
    source,
    inboxConsumerName(inboxKey),
    limit,
    INBOX_FETCH_EXPIRES_MS,
    drop && ((data) => drop(data, "inbox")),
  );
  const broadcast = await pullFrom(
    source,
    broadcastConsumerName(inboxKey),
    limit - inbox.messages.length,
    BROADCAST_FETCH_EXPIRES_MS,
    drop && ((data) => drop(data, "broadcast")),
  );
  return {
    messages: [...inbox.messages, ...broadcast.messages],
    // Each side reports what it still holds after its own fetches.
    remaining: inbox.pending + broadcast.pending,
    remainingBroadcast: broadcast.pending,
    broadcastDeliveredSeq: broadcast.deliveredSeq,
    stream: null,
    dropped: inbox.dropped + broadcast.dropped,
    missing: inbox.missing || broadcast.missing,
  };
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
  return {
    inbox: a,
    broadcast: b,
    total: a + b,
    broadcastDeliveredSeq: broadcast?.deliveredSeq ?? null,
    stream: null,
    missing: inbox === null || broadcast === null,
  };
}
