import {
  connect,
  RetentionPolicy,
  StorageType,
} from "nats";
import type {
  NatsConnection,
  JetStreamClient,
  JetStreamManager,
  KV,
  StreamConfig,
} from "nats";
import { log } from "./logger.js";
import {
  pullInbox,
  inboxPending,
  inboxConsumerName,
  broadcastConsumerName,
  isConsumerNotFound,
} from "./inbox.js";
import { CircuitBreaker, BrokerUnavailableError } from "./circuit-breaker.js";
import { ConsumerRegistry } from "./consumers.js";
import { reconcileStream } from "./stream-config.js";
import type { WantedStream } from "./stream-config.js";
import type { EnsureOptions } from "./consumers.js";
import type {
  ConsumerSource,
  InboxPull,
  InboxStream,
  PullOptions,
  InboxPending,
  PulledMessage,
} from "./inbox.js";

export type { PulledMessage, InboxPull, InboxPending, PullOptions } from "./inbox.js";

const STREAM_NAME = "MESH_MESSAGES";
const KV_BUCKET = "mesh-presence";

// 7 days in nanoseconds
const MAX_AGE_NS = 7 * 24 * 60 * 60 * 1_000_000_000;
// 5 min duplicate window in nanoseconds
const DUPLICATE_WINDOW_NS = 300_000_000_000;
// 1 GB
const MAX_BYTES = 1_073_741_824;
// KV presence TTL: 600s in milliseconds
const KV_TTL_MS = 600_000;
// How long one JetStream API call that READS may take. The nats.js default is 5 s, and
// one agent request makes three to five such calls: with a broker that had
// stopped answering, every request took 15 to 25 seconds (measured).
const JS_TIMEOUT_MS = 1500;
// A publish gets more room. When it times out the outcome is UNKNOWN: the
// bytes may sit in the socket and be stored the moment the broker breathes
// again, while the sender is told "not delivered", writes no history row and
// sends the message a second time. 1.5 s made that likely for every stall
// between 1.5 and 5 s; main's 5 s default did not. The breaker still makes
// every send after the first one fail fast.
const PUBLISH_TIMEOUT_MS = 4000;
// The first connect. nats.js waits 20 s by default for a broker that accepts
// the socket and then says nothing.
const CONNECT_TIMEOUT_MS = 5000;
// close() must end: drain() against a broker that does not answer never does.
const DRAIN_TIMEOUT_MS = 3000;

/** What the stream is supposed to be. connect() makes the broker agree. */
const STREAM: WantedStream = {
  name: STREAM_NAME,
  subjects: ["mesh.agents.>", "mesh.broadcast"],
  retention: RetentionPolicy.Limits,
  storage: StorageType.File,
  max_age: MAX_AGE_NS,
  max_bytes: MAX_BYTES,
  duplicate_window: DUPLICATE_WINDOW_NS,
  num_replicas: 1,
};
// After an outage error, fail fast for this long before probing again.
const BREAKER_COOL_DOWN_MS = 5000;
// /health must answer even when the broker does not.
const PING_TIMEOUT_MS = 1000;

/** Errors that mean "the broker is not answering", as opposed to an answer
 *  that happens to be an error (consumer not found, wrong sequence, ...). */
const OUTAGE_CODES = new Set([
  "TIMEOUT",
  "503", // no responders: JetStream is not there
  "CONNECTION_CLOSED",
  "CONNECTION_DRAINING",
  "CONNECTION_REFUSED",
  "CONNECTION_TIMEOUT",
  "DISCONNECT",
]);

export function isNatsOutage(err: unknown): boolean {
  if (err instanceof BrokerUnavailableError) return true;
  const code = (err as { code?: unknown })?.code;
  return typeof code === "string" && OUTAGE_CODES.has(code);
}

/** For the presence bucket: "503 no responders" there means the BUCKET is
 *  gone, not the broker. Presence is a hint and must not switch delivery
 *  off, so that one code does not open the breaker. A timeout still does. */
function isKvOutage(err: unknown): boolean {
  return isNatsOutage(err) && (err as { code?: unknown })?.code !== "503";
}

/** What connect() hands to attach(). Tests hand in fakes. */
export interface NatsClients {
  nc: NatsConnection;
  js: JetStreamClient;
  jsm: JetStreamManager;
  kv: KV;
}

export { BrokerUnavailableError } from "./circuit-breaker.js";

export class NatsService {
  private nc!: NatsConnection;
  private js!: JetStreamClient;
  private jsm!: JetStreamManager;
  private kv!: KV;
  // Down until connect() has succeeded: a call before that fails fast
  // instead of dereferencing a client that does not exist yet.
  private readonly breaker = new CircuitBreaker({ coolDownMs: BREAKER_COOL_DOWN_MS, startDown: true });
  private readonly consumers: ConsumerRegistry;

  /** Keys whose durables a delete could not remove (outage). They are
   *  removed before the key is ensured again: otherwise a new agent that is
   *  given the key of a deleted one reads the old one's mail. In memory only;
   *  a restart in between leaves the durables to the next delete. */
  private readonly pendingDeletes = new Set<string>();

  /** `consumerClockToleranceMs`: see ConsumerRegistry. Only tests change it. */
  constructor(private url: string, opts: { consumerClockToleranceMs?: number } = {}) {
    this.consumers = new ConsumerRegistry(
      {
        info: (name) => this.jsm.consumers.info(STREAM_NAME, name),
        add: (config) => this.jsm.consumers.add(STREAM_NAME, config),
        delete: (name) => this.jsm.consumers.delete(STREAM_NAME, name),
        update: (name, config) => this.jsm.consumers.update(STREAM_NAME, name, config),
      },
      { clockToleranceMs: opts.consumerClockToleranceMs },
    );
  }

  /** Every broker call goes through here. */
  private guarded<T>(fn: () => Promise<T>, isOutage: (err: unknown) => boolean = isNatsOutage): Promise<T> {
    return this.breaker.run(fn, isOutage);
  }

  async connect(): Promise<void> {
    // C4: Resilient reconnect config. `reconnect: true` + infinite
    // attempts with 2s backoff means a transient NATS outage (restart,
    // network glitch) heals itself without any mesh-side intervention.
    // We intentionally do NOT set `waitOnFirstConnect: true` here —
    // first-connect retries are handled by the loop in start(), which
    // retries for as long as it takes and logs every attempt.
    // A retried connect() must not leak the connection of an attempt that
    // got as far as the socket.
    if (this.nc && !this.nc.isClosed()) await this.nc.close().catch(() => {});
    const nc = await connect({
      servers: this.url,
      reconnect: true,
      maxReconnectAttempts: -1,
      reconnectTimeWait: 2000,
      pingInterval: 20_000,
      maxPingOut: 3,
      timeout: CONNECT_TIMEOUT_MS,
      name: "moshi",
    });
    // Remembered at once, so that the next attempt (or close()) can close it
    // if the setup below fails. It is NOT attached yet: no status loop, the
    // breaker stays down.
    this.nc = nc;
    const jsm = await nc.jetstreamManager({ timeout: JS_TIMEOUT_MS });
    const js = nc.jetstream({ timeout: JS_TIMEOUT_MS });

    // The stream: created when missing, brought in line when it differs.
    // Only "not found" is answered with a create (src/services/stream-config.ts).
    await reconcileStream(
      {
        info: (name) => jsm.streams.info(name) as unknown as Promise<{ config: Record<string, unknown>; state?: { messages?: number; bytes?: number; first_ts?: string } }>,
        add: (config) => jsm.streams.add(config as unknown as Partial<StreamConfig>),
        update: (name, config) => jsm.streams.update(name, config as unknown as Partial<StreamConfig>),
      },
      STREAM,
      log,
    );

    // Ensure KV bucket exists (creates if not present)
    const kv = await js.views.kv(KV_BUCKET, { ttl: KV_TTL_MS });
    this.attach({ nc, js, jsm, kv });
  }

  /**
   * Take a fully set-up connection into service: clients, status loop,
   * breaker up. connect() ends here, and only after stream and bucket exist.
   * The status loop used to start right after the socket came up, so a
   * half-made connection could report "reconnect" and mark the breaker up
   * while `kv` was still undefined.
   */
  attach(clients: NatsClients): void {
    const { nc } = clients;
    this.nc = nc;
    this.js = clients.js;
    this.jsm = clients.jsm;
    this.kv = clients.kv;
    this.consumers.clear();

    // Log NATS connection status events as structured JSON so we can see
    // reconnects, disconnects, and stale-connection warnings in the log
    // viewer. Runs as a detached async iterator; errors are suppressed to
    // prevent crashes if the iterator closes during shutdown.
    (async () => {
      try {
        for await (const s of nc.status()) {
          log("info", "nats status event", { event: s.type, data: String(s.data ?? "") });
          // Only the connection in service steers the breaker. A replaced
          // connection keeps emitting until it has closed.
          if (nc !== this.nc) continue;
          // Known outage: fail fast, no probes. Back up: close at once, and
          // trust no remembered consumer — the broker may be a fresh one.
          if (s.type === "disconnect" || s.type === "staleConnection") this.breaker.markDown();
          if (s.type === "reconnect") {
            this.consumers.clear();
            this.breaker.markUp();
            // It may be another broker than before: a new container, a new version.
            log("info", "nats reconnected", { server_version: this.serverVersion() });
          }
        }
      } catch {
        // Iterator closed — expected on graceful shutdown.
      }
    })();

    this.breaker.markUp();
  }

  /** Resolves with the stream sequence the broker stored the message under. */
  async publish(
    subject: string,
    data: Uint8Array,
    msgId: string,
  ): Promise<{ seq: number; duplicate: boolean }> {
    const ack = await this.guarded(() => this.js.publish(subject, data, { msgID: msgId, timeout: PUBLISH_TIMEOUT_MS }));
    return { seq: ack.seq, duplicate: ack.duplicate };
  }

  /** `inboxKey` is `agents.inbox_key` — the agent's immutable address, not
   *  its display name. Subject and durable names derive from it. Asked of the
   *  broker once per key; throws when the broker cannot be asked. */
  async ensureConsumer(inboxKey: string, since?: string | null, opts: EnsureOptions = {}): Promise<void> {
    const key = inboxKey.toLowerCase();
    if (this.pendingDeletes.has(key)) {
      // A delete the outage swallowed. Finish it first, or the durables of
      // the previous owner of this key hand their mail to the next one.
      await this.removeDurables(key);
      this.pendingDeletes.delete(key);
    }
    // Answered from memory: not a broker call, so not through the breaker.
    // Through it, a memory hit on a half-open breaker counted as a successful
    // probe and closed it while the broker was still away.
    if (this.consumers.has(key)) return;
    await this.guarded(() => this.consumers.ensure(key, since, opts));
  }

  /** Remove both durables. "Not found" is fine; an outage is reported, so the
   *  caller can log that the durables are still there, and the delete is
   *  finished before the key is used again. */
  async deleteConsumer(inboxKey: string): Promise<void> {
    const key = inboxKey.toLowerCase();
    this.consumers.forget(key);
    try {
      await this.removeDurables(key);
      this.pendingDeletes.delete(key);
    } catch (err) {
      this.pendingDeletes.add(key);
      throw err;
    }
  }

  private async removeDurables(key: string): Promise<void> {
    for (const name of [inboxConsumerName(key), broadcastConsumerName(key)]) {
      try {
        await this.guarded(() => this.jsm.consumers.delete(STREAM_NAME, name));
      } catch (err) {
        if (!isConsumerNotFound(err)) throw err;
      }
    }
  }

  private consumerSource(): ConsumerSource {
    return {
      get: (name: string) => this.js.consumers.get(STREAM_NAME, name),
    };
  }

  /**
   * Pull up to `limit` waiting messages (inbox + broadcast, shared limit).
   * Consults consumer info first so an empty inbox returns immediately
   * instead of blocking on the fetch deadline. Throws when the broker is
   * unreachable — callers degrade to "retry shortly".
   */
  async pullInbox(inboxKey: string, limit: number, opts: PullOptions = {}): Promise<InboxPull> {
    const pull = await this.guarded(() => pullInbox(this.consumerSource(), inboxKey, limit, opts));
    // A durable is gone although this process had ensured it (deleted by
    // hand, by another process, stream recreated). Look again next time: on
    // main every request did, and an agent must not sit in front of an
    // "empty" inbox until the next restart.
    if (pull.missing) this.consumers.forget(inboxKey);
    if (pull.remainingBroadcast > 0) pull.stream = await this.streamBounds();
    return pull;
  }

  /** Waiting-message count for `inboxKey` without consuming anything. */
  async inboxPending(inboxKey: string): Promise<InboxPending> {
    const pending = await this.guarded(() => inboxPending(this.consumerSource(), inboxKey));
    if (pending.missing) this.consumers.forget(inboxKey);
    if (pending.broadcast > 0) pending.stream = await this.streamBounds();
    return pending;
  }

  /**
   * When the stream was created and which sequences it holds right now: what
   * a caller needs to tell which history rows are in it. Asked only while
   * broadcasts are waiting. Null when it cannot be had; the caller then
   * subtracts nothing, which is the safe direction.
   */
  private async streamBounds(): Promise<InboxStream | null> {
    try {
      const info = await this.guarded(() => this.jsm.streams.info(STREAM_NAME));
      return { created: String(info.created), firstSeq: info.state.first_seq, lastSeq: info.state.last_seq };
    } catch {
      return null;
    }
  }

  /**
   * Stream-state snapshot for the dashboard KPI strip. Reads
   * `MESH_MESSAGES` from JetStream and returns a small structured object
   * the v2 home page can show without leaking the raw nats.js types.
   * Errors (broker down, stream missing) bubble up — the caller should
   * fall back to nulls in that case.
   */
  async getStreamStats(): Promise<{
    name: string;
    bytes: number;
    messages: number;
    maxAgeSeconds: number;
    maxBytes: number;
  }> {
    const info = await this.guarded(() => this.jsm.streams.info(STREAM_NAME));
    return {
      name: STREAM_NAME,
      bytes: info.state.bytes,
      messages: info.state.messages,
      maxAgeSeconds: Math.round((info.config.max_age ?? 0) / 1_000_000_000),
      maxBytes: info.config.max_bytes ?? 0,
    };
  }

  async updatePresence(
    agentName: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    const value = JSON.stringify({ ...data, timestamp: new Date().toISOString() });
    await this.guarded(() => this.kv.put(`agent.${agentName}`, value), isKvOutage);
  }

  /**
   * Live-presence entries for the given agents, keyed by agent name.
   *
   * Reads each key directly instead of enumerating the bucket:
   * `kv.keys()` (ordered consumer, deliver-last-per-subject) stops one
   * message early on this server/client combination and never returned
   * the most recently touched agent — so the agent that had just called
   * the mesh always showed up as stale/offline. Direct gets are exact and
   * run in parallel; the set of agents is known from SQLite anyway.
   */
  async getPresence(agentNames: string[]): Promise<Map<string, unknown>> {
    const result = new Map<string, unknown>();
    const decoder = new TextDecoder();
    // One guarded unit: an outage on any key is an outage, and it has to
    // reach the breaker (and the caller, which degrades to SQLite) instead of
    // being mistaken for "this agent is not live".
    await this.guarded(() =>
      Promise.all(
        agentNames.map(async (agentName) => {
          try {
            const entry = await this.kv.get(`agent.${agentName}`);
            if (entry && entry.operation === "PUT" && entry.value.length > 0) {
              result.set(agentName, JSON.parse(decoder.decode(entry.value)));
            }
          } catch (err) {
            if (isNatsOutage(err)) throw err;
            // Missing or unparseable entry — treated as not live
          }
        }),
      ),
      isKvOutage,
    );
    return result;
  }

  /** The version the connected broker announced (INFO), or null. For the
   *  log: the broker is internal, and an image tag says what was asked for,
   *  not what runs. */
  serverVersion(): string | null {
    const version = (this.nc as { info?: { version?: unknown } } | undefined)?.info?.version;
    return typeof version === "string" && version.length > 0 ? version : null;
  }

  /** Is the broker answering? Bounded: `nc.flush()` alone waits for a broker
   *  that has stopped answering for as long as it takes. */
  async ping(): Promise<boolean> {
    try {
      await this.guarded(() => {
        let timer: ReturnType<typeof setTimeout>;
        const deadline = new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(Object.assign(new Error("ping timed out"), { code: "TIMEOUT" })),
            PING_TIMEOUT_MS,
          );
        });
        return Promise.race([this.nc.flush(), deadline]).finally(() => clearTimeout(timer));
      });
      return true;
    } catch {
      return false;
    }
  }

  /** Never rejects and always ends: shutdown() goes on to close the database
   *  and exit. drain() rejects on a connection that is already closed, and
   *  never settles against a broker that does not answer. */
  async close(): Promise<void> {
    this.breaker.markDown();
    const nc = this.nc;
    if (!nc || nc.isClosed()) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => { timer = setTimeout(resolve, DRAIN_TIMEOUT_MS); });
    await Promise.race([nc.drain().catch(() => {}), deadline]);
    clearTimeout(timer);
    if (!nc.isClosed()) await nc.close().catch(() => {});
  }
}
