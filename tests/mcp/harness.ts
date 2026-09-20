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
  /** Raw inbox per agent (lowercase) — what pullInbox hands out. */
  inboxes: Map<string, Uint8Array[]>;
  acked: number;
  failPublish: boolean;
  failPending: boolean;
  enqueue(agent: string, json: Record<string, unknown>): void;
  kv: Map<string, Record<string, unknown>>;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export function createFakeMeshNats(): FakeMeshNats {
  const self: FakeMeshNats = {
    published: [],
    inboxes: new Map(),
    acked: 0,
    failPublish: false,
    failPending: false,
    kv: new Map(),
    enqueue(agent, json) {
      const key = agent.toLowerCase();
      if (!self.inboxes.has(key)) self.inboxes.set(key, []);
      self.inboxes.get(key)!.push(enc.encode(JSON.stringify(json)));
    },
    async publish(subject, data, msgId) {
      if (self.failPublish) throw new Error("nats unavailable");
      self.published.push({ subject, msgId, json: JSON.parse(dec.decode(data)) });
      // Route direct messages into the recipient's fake inbox.
      const m = /^mesh\.agents\.(.+)\.inbox$/.exec(subject);
      if (m) {
        const key = m[1];
        if (!self.inboxes.has(key)) self.inboxes.set(key, []);
        self.inboxes.get(key)!.push(data);
      }
    },
    async pullInbox(agentName, limit) {
      const key = agentName.toLowerCase();
      const queue = self.inboxes.get(key) ?? [];
      const batch = queue.splice(0, limit);
      const messages: PulledMessage[] = batch.map((data) => ({
        data,
        ack: () => { self.acked++; },
      }));
      return { messages, remaining: queue.length, missing: false };
    },
    async inboxPending(agentName) {
      if (self.failPending) throw new Error("nats unavailable");
      const n = (self.inboxes.get(agentName.toLowerCase()) ?? []).length;
      return { inbox: n, broadcast: 0, total: n, missing: false };
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
