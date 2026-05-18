import {
  connect,
  AckPolicy,
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
// 30s ack wait in nanoseconds
const ACK_WAIT_NS = 30 * 1_000_000_000;

export interface PulledMessage {
  data: Uint8Array;
  ack: () => void;
}

export class NatsService {
  private nc!: NatsConnection;
  private js!: JetStreamClient;
  private jsm!: JetStreamManager;
  private kv!: KV;

  constructor(private url: string) {}

  async connect(): Promise<void> {
    // C4: Resilient reconnect config. `reconnect: true` + infinite
    // attempts with 2s backoff means a transient NATS outage (restart,
    // network glitch) heals itself without any mesh-side intervention.
    // We intentionally do NOT set `waitOnFirstConnect: true` here —
    // first-connect retries are handled by the explicit loop in start(),
    // which gives us clearer startup logs and a bounded retry count.
    this.nc = await connect({
      servers: this.url,
      reconnect: true,
      maxReconnectAttempts: -1,
      reconnectTimeWait: 2000,
      pingInterval: 20_000,
      maxPingOut: 3,
      name: "moshi",
    });
    this.jsm = await this.nc.jetstreamManager();
    this.js = this.nc.jetstream();

    // Log NATS connection status events as structured JSON so we can see
    // reconnects, disconnects, and stale-connection warnings in the log
    // viewer. Runs as a detached async iterator; errors are suppressed to
    // prevent crashes if the iterator closes during shutdown.
    (async () => {
      try {
        for await (const s of this.nc.status()) {
          log("info", "nats status event", { event: s.type, data: String(s.data ?? "") });
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
  }

  async publish(
    subject: string,
    data: Uint8Array,
    msgId: string,
  ): Promise<void> {
    await this.js.publish(subject, data, { msgID: msgId });
  }

  async ensureConsumer(agentName: string): Promise<void> {
    const normalizedName = agentName.toLowerCase();
    const inboxConsumer = `agent-${normalizedName}`;
    const broadcastConsumer = `agent-${normalizedName}-broadcast`;

    // Inbox consumer (lowercase subject for case-insensitive routing)
    try {
      await this.jsm.consumers.info(STREAM_NAME, inboxConsumer);
    } catch {
      await this.jsm.consumers.add(STREAM_NAME, {
        durable_name: inboxConsumer,
        filter_subject: `mesh.agents.${normalizedName}.inbox`,
        ack_policy: AckPolicy.Explicit,
        max_deliver: 5,
        ack_wait: ACK_WAIT_NS,
      });
    }

    // Broadcast consumer
    try {
      await this.jsm.consumers.info(STREAM_NAME, broadcastConsumer);
    } catch {
      await this.jsm.consumers.add(STREAM_NAME, {
        durable_name: broadcastConsumer,
        filter_subject: "mesh.broadcast",
        ack_policy: AckPolicy.Explicit,
        max_deliver: 5,
        ack_wait: ACK_WAIT_NS,
      });
    }
  }

  async deleteConsumer(agentName: string): Promise<void> {
    const normalizedName = agentName.toLowerCase();
    const inboxConsumer = `agent-${normalizedName}`;
    const broadcastConsumer = `agent-${normalizedName}-broadcast`;

    try {
      await this.jsm.consumers.delete(STREAM_NAME, inboxConsumer);
    } catch {
      // Ignore — consumer may not exist
    }

    try {
      await this.jsm.consumers.delete(STREAM_NAME, broadcastConsumer);
    } catch {
      // Ignore — consumer may not exist
    }
  }

  async pullMessages(
    agentName: string,
    limit: number,
  ): Promise<PulledMessage[]> {
    const results: PulledMessage[] = [];

    const normalizedName = agentName.toLowerCase();

    // Pull from inbox consumer
    try {
      const inboxConsumer = await this.js.consumers.get(
        STREAM_NAME,
        `agent-${normalizedName}`,
      );
      const inboxMessages = await inboxConsumer.fetch({
        max_messages: limit,
        expires: 2000,
      });
      for await (const msg of inboxMessages) {
        results.push({
          data: msg.data,
          ack: () => msg.ack(),
        });
      }
    } catch {
      // Consumer may not exist yet — skip
    }

    // Pull from broadcast consumer
    try {
      const broadcastConsumer = await this.js.consumers.get(
        STREAM_NAME,
        `agent-${normalizedName}-broadcast`,
      );
      const broadcastMessages = await broadcastConsumer.fetch({
        max_messages: limit,
        expires: 1000,
      });
      for await (const msg of broadcastMessages) {
        results.push({
          data: msg.data,
          ack: () => msg.ack(),
        });
      }
    } catch {
      // Consumer may not exist yet — skip
    }

    return results;
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
    const info = await this.jsm.streams.info(STREAM_NAME);
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
    await this.kv.put(`agent.${agentName}`, value);
  }

  async getPresence(): Promise<Map<string, unknown>> {
    const result = new Map<string, unknown>();

    const keys = await this.kv.keys();
    for await (const key of keys) {
      try {
        const entry = await this.kv.get(key);
        if (entry && entry.value.length > 0) {
          const decoded = new TextDecoder().decode(entry.value);
          const parsed = JSON.parse(decoded);
          // Strip "agent." prefix from key to get agentName
          const agentName = key.startsWith("agent.") ? key.slice(6) : key;
          result.set(agentName, parsed);
        }
      } catch {
        // Skip unparseable entries
      }
    }

    return result;
  }

  async ping(): Promise<boolean> {
    try {
      await this.nc.flush();
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.nc.drain();
  }
}
