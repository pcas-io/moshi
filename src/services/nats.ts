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
import type {
  ConsumerSource,
  InboxPull,
  InboxPending,
  PulledMessage,
} from "./inbox.js";

export type { PulledMessage, InboxPull, InboxPending } from "./inbox.js";

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
// How long one JetStream API call may take. The nats.js default is 5 s, and
// one agent request makes three to five such calls: with a broker that had
// stopped answering, every request took 15 to 25 seconds (measured).
const JS_TIMEOUT_MS = 1500;
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

export { BrokerUnavailableError } from "./circuit-breaker.js";

export class NatsService {
  private nc!: NatsConnection;
  private js!: JetStreamClient;
  private jsm!: JetStreamManager;
  private kv!: KV;
  // Down until connect() has succeeded: a call before that fails fast
  // instead of dereferencing a client that does not exist yet.
  private readonly breaker = new CircuitBreaker({ coolDownMs: BREAKER_COOL_DOWN_MS, startDown: true });
  private readonly consumers = new ConsumerRegistry({
    info: (name) => this.jsm.consumers.info(STREAM_NAME, name),
    add: (config) => this.jsm.consumers.add(STREAM_NAME, config),
  });

  constructor(private url: string) {}

  /** Every broker call goes through here. */
  private guarded<T>(fn: () => Promise<T>): Promise<T> {
    return this.breaker.run(fn, isNatsOutage);
  }

  async connect(): Promise<void> {
    // C4: Resilient reconnect config. `reconnect: true` + infinite
    // attempts with 2s backoff means a transient NATS outage (restart,
    // network glitch) heals itself without any mesh-side intervention.
    // We intentionally do NOT set `waitOnFirstConnect: true` here —
    // first-connect retries are handled by the explicit loop in start(),
    // which gives us clearer startup logs and a bounded retry count.
    // A retried connect() (see start() in src/index.tsx) must not leak the
    // connection of an attempt that got as far as the socket.
    if (this.nc && !this.nc.isClosed()) await this.nc.close().catch(() => {});
    this.nc = await connect({
      servers: this.url,
      reconnect: true,
      maxReconnectAttempts: -1,
      reconnectTimeWait: 2000,
      pingInterval: 20_000,
      maxPingOut: 3,
      name: "moshi",
    });
    this.jsm = await this.nc.jetstreamManager({ timeout: JS_TIMEOUT_MS });
    this.js = this.nc.jetstream({ timeout: JS_TIMEOUT_MS });

    // Log NATS connection status events as structured JSON so we can see
    // reconnects, disconnects, and stale-connection warnings in the log
    // viewer. Runs as a detached async iterator; errors are suppressed to
    // prevent crashes if the iterator closes during shutdown.
    (async () => {
      try {
        for await (const s of this.nc.status()) {
          log("info", "nats status event", { event: s.type, data: String(s.data ?? "") });
          // Known outage: fail fast, no probes. Back up: close at once, and
          // trust no remembered consumer — the broker may be a fresh one.
          if (s.type === "disconnect" || s.type === "staleConnection") this.breaker.markDown();
          if (s.type === "reconnect") {
            this.consumers.clear();
            this.breaker.markUp();
          }
        }
      } catch {
        // Iterator closed — expected on graceful shutdown.
      }
    })();

    // Ensure stream exists
    try {
      await this.jsm.streams.info(STREAM_NAME);
    } catch {
      // Stream doesn't exist — create it
      await this.jsm.streams.add({
        name: STREAM_NAME,
        subjects: ["mesh.agents.>", "mesh.broadcast"],
        retention: RetentionPolicy.Limits,
        max_age: MAX_AGE_NS,
        max_bytes: MAX_BYTES,
        storage: StorageType.File,
        num_replicas: 1,
        duplicate_window: DUPLICATE_WINDOW_NS,
      });
    }

    // Ensure KV bucket exists (creates if not present)
    this.kv = await this.js.views.kv(KV_BUCKET, { ttl: KV_TTL_MS });
    this.breaker.markUp();
  }

  async publish(
    subject: string,
    data: Uint8Array,
    msgId: string,
  ): Promise<void> {
    await this.guarded(() => this.js.publish(subject, data, { msgID: msgId }));
  }

  /** `inboxKey` is `agents.inbox_key` — the agent's immutable address, not
   *  its display name. Subject and durable names derive from it. Asked of the
   *  broker once per key; throws when the broker cannot be asked. */
  async ensureConsumer(inboxKey: string): Promise<void> {
    await this.guarded(() => this.consumers.ensure(inboxKey));
  }

  /** Remove both durables. "Not found" is fine; an outage is reported, so the
   *  caller can log that the durables are still there. */
  async deleteConsumer(inboxKey: string): Promise<void> {
    this.consumers.forget(inboxKey);
    for (const name of [inboxConsumerName(inboxKey), broadcastConsumerName(inboxKey)]) {
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
  async pullInbox(inboxKey: string, limit: number): Promise<InboxPull> {
    return this.guarded(() => pullInbox(this.consumerSource(), inboxKey, limit));
  }

  /** Waiting-message count for `inboxKey` without consuming anything. */
  async inboxPending(inboxKey: string): Promise<InboxPending> {
    return this.guarded(() => inboxPending(this.consumerSource(), inboxKey));
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
    await this.guarded(() => this.kv.put(`agent.${agentName}`, value));
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
    );
    return result;
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

  async close(): Promise<void> {
    this.breaker.markDown();
    if (this.nc) await this.nc.drain();
  }
}
