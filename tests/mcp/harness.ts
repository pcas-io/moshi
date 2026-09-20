// Test harness: a real McpServer with in-memory SQLite and fake NATS,
// driven through the SDK Client over an InMemoryTransport — so tool
// schemas, admin guards and response shapes are exercised end-to-end.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type Database from "better-sqlite3";
import { initDatabase } from "../../src/services/db";
import { AgentService } from "../../src/services/agent";
import { ActivityService } from "../../src/services/activity";
import { RateLimiter } from "../../src/services/ratelimit";
import { PresenceService } from "../../src/services/presence";
import type { NatsPresenceBackend } from "../../src/services/presence";
import type { MeshNats } from "../../src/mcp/shared";
import type { PulledMessage } from "../../src/services/inbox";
import { createMcpServer } from "../../src/mcp/server";

export interface FakeMeshNats extends MeshNats, NatsPresenceBackend {
  published: { subject: string; msgId: string; json: Record<string, unknown> }[];
  acked: number;
  failPublish: boolean;
  failPending: boolean;
  /** The stream's bounds cannot be had (the broker did not answer that one). */
  withoutBounds: boolean;
  /** Put a direct message for `agent` into the stream without a sender tool call. */
  enqueue(agent: string, json: Record<string, unknown>): void;
  /** Put a raw body on any subject, the way only a hand-made publish can. */
  enqueueRaw(subject: string, body: string): void;
  /** The NATS volume is lost: a new, empty stream whose sequences start at 1
   *  again, and new durables. The history in SQLite is a different volume. */
  resetStream(): void;
  kv: Map<string, Record<string, unknown>>;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * One stream with sequence numbers, and per inbox key two read positions —
 * the direct inbox and `mesh.broadcast` — like the two durables of a real
 * agent. Everybody's broadcast position starts at the beginning, so a
 * broadcast reaches every agent including its sender: that is the broker's
 * behaviour the tools have to cope with.
 */
export function createFakeMeshNats(): FakeMeshNats {
  let stream: { seq: number; subject: string; data: Uint8Array }[] = [];
  let created = new Date().toISOString();
  const positions = new Map<string, { inbox: number; broadcast: number }>();
  const positionOf = (key: string) => {
    const k = key.toLowerCase();
    if (!positions.has(k)) positions.set(k, { inbox: 0, broadcast: 0 });
    return positions.get(k)!;
  };
  const append = (subject: string, data: Uint8Array) => {
    const seq = stream.length + 1;
    stream.push({ seq, subject, data });
    return seq;
  };
  const waiting = (key: string, side: "inbox" | "broadcast") => {
    const subject = side === "inbox" ? `mesh.agents.${key.toLowerCase()}.inbox` : "mesh.broadcast";
    const from = positionOf(key)[side];
    return stream.filter((m) => m.subject === subject && m.seq > from);
  };
  const bounds = () => ({ created, firstSeq: stream.length ? 1 : 0, lastSeq: stream.length });

  const self: FakeMeshNats = {
    published: [],
    acked: 0,
    failPublish: false,
    failPending: false,
    withoutBounds: false,
    kv: new Map(),
    enqueue(agent, json) {
      append(`mesh.agents.${agent.toLowerCase()}.inbox`, enc.encode(JSON.stringify(json)));
    },
    enqueueRaw(subject, body) {
      append(subject, enc.encode(body));
    },
    resetStream() {
      stream = [];
      positions.clear();
      created = new Date().toISOString();
    },
    async publish(subject, data, msgId) {
      if (self.failPublish) throw new Error("nats unavailable");
      self.published.push({ subject, msgId, json: JSON.parse(dec.decode(data)) });
      return { seq: append(subject, data), duplicate: false };
    },
    async pullInbox(inboxKey, limit, opts = {}) {
      const messages: PulledMessage[] = [];
      let dropped = 0;
      for (const side of ["inbox", "broadcast"] as const) {
        for (const m of waiting(inboxKey, side)) {
          if (messages.length >= limit) break;
          positionOf(inboxKey)[side] = m.seq;
          if (opts.drop?.(m.data, side)) { self.acked++; dropped++; continue; }
          messages.push({ data: m.data, ack: () => { self.acked++; } });
        }
      }
      const remainingBroadcast = waiting(inboxKey, "broadcast").length;
      return {
        messages,
        remaining: waiting(inboxKey, "inbox").length + remainingBroadcast,
        remainingBroadcast,
        broadcastDeliveredSeq: positionOf(inboxKey).broadcast,
        stream: self.withoutBounds ? null : bounds(),
        dropped,
        missing: false,
      };
    },
    async inboxPending(inboxKey) {
      if (self.failPending) throw new Error("nats unavailable");
      const inbox = waiting(inboxKey, "inbox").length;
      const broadcast = waiting(inboxKey, "broadcast").length;
      return { inbox, broadcast, total: inbox + broadcast, broadcastDeliveredSeq: positionOf(inboxKey).broadcast, stream: self.withoutBounds ? null : bounds(), missing: false };
    },
    async updatePresence(agentName, data) {
      self.kv.set(agentName, { ...data, timestamp: new Date().toISOString() });
    },
    async getPresence(agentNames: string[]) {
      return new Map<string, unknown>([...self.kv].filter(([k]) => agentNames.includes(k)));
    },
  };
  return self;
}

export interface Harness {
  db: Database.Database;
  agents: AgentService;
  activity: ActivityService;
  presence: PresenceService;
  nats: FakeMeshNats;
  rateLimiter: RateLimiter;
  /** Connect an MCP client acting as `agentName`. */
  connect(agentName: string, opts?: { isAdmin?: boolean }): Promise<Client>;
}

export function createHarness(): Harness {
  const db = initDatabase(":memory:");
  const activity = new ActivityService(db);
  const agents = new AgentService(db, activity);
  const nats = createFakeMeshNats();
  const presence = new PresenceService(db, nats);
  const rateLimiter = new RateLimiter(60);

  return {
    db, agents, activity, presence, nats, rateLimiter,
    async connect(agentName, opts = {}) {
      const server = createMcpServer({
        nats, agents, activity, rateLimiter, presence, db,
        agentName,
        isAdmin: opts.isAdmin ?? false,
      });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client({ name: "test-client", version: "0.0.0" });
      await client.connect(clientTransport);
      return client;
    },
  };
}

export interface ToolCall {
  isError: boolean;
  text: string;
  json: Record<string, unknown>;
}

/** Call a tool and decode the JSON text payload (or the error text). */
export async function callTool(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolCall> {
  const res = (await client.callTool({ name, arguments: args })) as {
    content: { type: string; text?: string }[];
    isError?: boolean;
  };
  const text = res.content[0]?.text ?? "";
  let json: Record<string, unknown> = {};
  if (!res.isError) {
    try { json = JSON.parse(text) as Record<string, unknown>; } catch { json = {}; }
  }
  return { isError: Boolean(res.isError), text, json };
}
