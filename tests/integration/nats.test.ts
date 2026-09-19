// Against a real JetStream broker — everything the fakes cannot show:
// durables, redelivery, the duplicate window, KV reads, consumer cleanup.
//
// Skipped unless MOSHI_TEST_NATS_URL is set. Run it with
//   npm run test:integration
// which starts a throwaway broker, points this variable at it and removes it
// again. The variable is deliberately NOT `NATS_URL`: EVERY TEST HERE
// DELETES THE STREAM AND THE PRESENCE BUCKET first, so it must never be
// pointed at a broker that holds anything. It only accepts loopback.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { connect as natsConnect } from "nats";
import type { NatsConnection, JetStreamManager } from "nats";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { initDatabase } from "../../src/services/db";
import { NatsService } from "../../src/services/nats";
import { AgentService, inboxKeyOf } from "../../src/services/agent";
import { ActivityService } from "../../src/services/activity";
import { PresenceService } from "../../src/services/presence";
import { RateLimiter } from "../../src/services/ratelimit";
import { createMcpServer } from "../../src/mcp/server";

const URL = process.env.MOSHI_TEST_NATS_URL;
const LOOPBACK = /^nats:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+$/;
const STREAM = "MESH_MESSAGES";
const CTX = "integration test";
const enc = new TextEncoder();
const dec = new TextDecoder();

describe.skipIf(!URL)("against a real JetStream broker", () => {
  let admin: NatsConnection;
  let jsm: JetStreamManager;
  let nats: NatsService;
  const extra: NatsService[] = [];

  beforeEach(async () => {
    if (!LOOPBACK.test(URL!)) {
      throw new Error(`MOSHI_TEST_NATS_URL must be a loopback broker, these tests delete its stream (got ${URL})`);
    }
    admin = await natsConnect({ servers: URL });
    jsm = await admin.jetstreamManager();
    for (const name of [STREAM, "KV_mesh-presence"]) {
      try { await jsm.streams.delete(name); } catch { /* not there yet */ }
    }
    nats = new NatsService(URL!);
    await nats.connect();
  });

  afterEach(async () => {
    for (const n of extra.splice(0)) await n.close().catch(() => {});
    await nats.close().catch(() => {});
    await admin.close();
  });

  const consumers = async (): Promise<string[]> => {
    const names: string[] = [];
    for await (const c of jsm.consumers.list(STREAM)) names.push(c.name);
    return names.sort();
  };
  const message = (id: string, payload: string) =>
    enc.encode(JSON.stringify({ id, from: "x", to: "y", type: "info", payload, context: CTX, created_at: new Date().toISOString(), ttl_seconds: 3600 }));

  describe("NatsService", () => {
    it("connects a second time without recreating what is there", async () => {
      await nats.publish("mesh.agents.k1.inbox", message("m1", "kept"), "m1");
      const second = new NatsService(URL!);
      extra.push(second);
      await second.connect();
      const info = await jsm.streams.info(STREAM);
      expect(info.config.subjects).toEqual(["mesh.agents.>", "mesh.broadcast"]);
      expect(info.state.messages).toBe(1);
    });

    it("creates one durable pair per inbox key, however often it is asked", async () => {
      await nats.ensureConsumer("Scout");
      await nats.ensureConsumer("Scout");
      await nats.ensureConsumer("scout");
      expect(await consumers()).toEqual(["agent-scout", "agent-scout-broadcast"]);
    });

    it("counts a waiting message, hands it over once, and the count drops after the ack", async () => {
      await nats.ensureConsumer("k1");
      await nats.publish("mesh.agents.k1.inbox", message("m1", "hello"), "m1");
      expect(await nats.inboxPending("k1")).toMatchObject({ inbox: 1, broadcast: 0, total: 1 });

      const pull = await nats.pullInbox("k1", 10);
      expect(pull.messages.map((m) => JSON.parse(dec.decode(m.data)).payload)).toEqual(["hello"]);
      for (const m of pull.messages) m.ack();
      await nats.ping(); // flush the acks
      expect((await nats.inboxPending("k1")).total).toBe(0);
      expect((await nats.pullInbox("k1", 10)).messages).toEqual([]);
    });

    it("keeps another agent's mail out of this inbox", async () => {
      await nats.ensureConsumer("k1");
      await nats.ensureConsumer("k2");
      await nats.publish("mesh.agents.k2.inbox", message("m1", "for k2"), "m1");
      expect((await nats.inboxPending("k1")).total).toBe(0);
      expect((await nats.inboxPending("k2")).total).toBe(1);
    });

    it("stores a repeated message id once", async () => {
      await nats.publish("mesh.agents.k1.inbox", message("dup", "once"), "dup");
      await nats.publish("mesh.agents.k1.inbox", message("dup", "once"), "dup");
      expect((await jsm.streams.info(STREAM)).state.messages).toBe(1);
    });

    it("answers an empty inbox at once instead of waiting out the fetch deadline", async () => {
      await nats.ensureConsumer("k1");
      const t0 = performance.now();
      const pull = await nats.pullInbox("k1", 10);
      expect(pull.messages).toEqual([]);
      expect(performance.now() - t0).toBeLessThan(1000); // was about 3 s before the short-circuit
    });

    it("reads presence per agent: exactly who was asked for, the last writer included", async () => {
      for (const name of ["a", "b", "c"]) await nats.updatePresence(name, {});
      const seen = await nats.getPresence(["a", "c", "nobody"]);
      expect([...seen.keys()].sort()).toEqual(["a", "c"]); // "c" wrote last; kv.keys() used to drop it
    });

    it("removes both durables on cleanup and does not mind a second call", async () => {
      await nats.ensureConsumer("k1");
      await nats.deleteConsumer("k1");
      await nats.deleteConsumer("k1");
      expect(await consumers()).toEqual([]);
    });

    it("reports the broker as reachable, and as gone after close", async () => {
      const probe = new NatsService(URL!);
      await probe.connect();
      expect(await probe.ping()).toBe(true);
      await probe.close();
      expect(await probe.ping()).toBe(false);
    });
  });

  describe("the MCP tools over a real broker", () => {
    function stack() {
      const db = initDatabase(":memory:");
      const activity = new ActivityService(db);
      const agents = new AgentService(db, activity, nats);
      const presence = new PresenceService(db, nats);
      const rateLimiter = new RateLimiter(60);
      async function as(name: string) {
        const row = agents.getByName(name)!;
        await nats.ensureConsumer(inboxKeyOf(row)); // what the /mcp route does per request
        const server = createMcpServer({ nats, agents, activity, rateLimiter, presence, db, agentName: name, inboxKey: inboxKeyOf(row), isAdmin: false });
        const [a, b] = InMemoryTransport.createLinkedPair();
        await server.connect(b);
        const client = new Client({ name: "integration", version: "0" });
        await client.connect(a);
        return async (tool: string, args: Record<string, unknown> = {}) => {
          const res = (await client.callTool({ name: tool, arguments: args })) as { content: { text?: string }[]; isError?: boolean };
          const text = res.content[0]?.text ?? "";
          return { isError: Boolean(res.isError), text, json: (res.isError ? {} : JSON.parse(text)) as Record<string, any> };
        };
      }
      return { db, agents, as };
    }
    const payloads = (r: { json: Record<string, any> }) => (r.json.messages as { payload: string }[]).map((m) => m.payload);

    it("a rename keeps unread mail, replays nothing that was read, and retires the old name", async () => {
      const { agents, as } = stack();
      agents.create("alpha");
      const betaId = agents.create("beta").agent.id;
      const alpha = await as("alpha");
      const beta = await as("beta");

      await alpha("mesh_send", { to: "broadcast", payload: "b1", context: CTX });
      expect(payloads(await beta("mesh_receive"))).toEqual(["b1"]);

      await alpha("mesh_send", { to: "beta", payload: "sent before the rename", context: CTX });
      expect(agents.rename(betaId, "gamma", "admin")).toBe(true);

      const gamma = await as("gamma");
      expect(payloads(await gamma("mesh_receive"))).toEqual(["sent before the rename"]);

      expect((await alpha("mesh_send", { to: "gamma", payload: "to the new name", context: CTX })).isError).toBe(false);
      expect(payloads(await gamma("mesh_receive"))).toEqual(["to the new name"]);
      expect((await alpha("mesh_send", { to: "beta", payload: "x", context: CTX })).isError).toBe(true);

      // One consumer pair per agent, still keyed by the original address.
      expect(await consumers()).toEqual(["agent-alpha", "agent-alpha-broadcast", "agent-beta", "agent-beta-broadcast"]);
    });

    it("mail that waited through a rename shows the current name, and the reply reaches the renamed sender", async () => {
      const { agents, as } = stack();
      agents.create("alpha");
      const betaId = agents.create("beta").agent.id;
      const alpha = await as("alpha");
      const beta = await as("beta");

      const question = await beta("mesh_send", { to: "alpha", payload: "question", context: CTX });
      expect(agents.rename(betaId, "delta", "admin")).toBe(true);

      const waiting = await alpha("mesh_receive");
      expect((waiting.json.messages as { from: string }[]).map((m) => m.from)).toEqual(["delta"]);

      const reply = await alpha("mesh_reply", { message_id: question.json.id, payload: "answer", context: CTX });
      expect(reply.isError, reply.text).toBe(false);
      expect(reply.json.to).toBe("delta");
      const delta = await as("delta");
      expect(payloads(await delta("mesh_receive"))).toEqual(["answer"]);
    });

    it("reports inbox_pending from the broker on every reply", async () => {
      const { agents, as } = stack();
      agents.create("alpha");
      agents.create("beta");
      const alpha = await as("alpha");
      const beta = await as("beta");
      await alpha("mesh_send", { to: "beta", payload: "one", context: CTX });
      await alpha("mesh_send", { to: "beta", payload: "two", context: CTX });
      expect((await beta("mesh_status")).json.inbox_pending).toBe(2);
      const got = await beta("mesh_receive", { limit: 1 });
      expect(payloads(got)).toEqual(["one"]);
      expect(got.json.inbox_pending).toBe(1);
    });

    it("removes an agent's durables when it is revoked or deleted", async () => {
      const { agents, as } = stack();
      const a = agents.create("alpha").agent.id;
      const b = agents.create("beta").agent.id;
      await as("alpha");
      await as("beta");
      expect(await consumers()).toHaveLength(4);
      agents.revokeById(a, "admin");
      agents.deleteById(b, "admin");
      await expect.poll(consumers, { timeout: 3000 }).toEqual([]); // cleanup is fire-and-forget
    });
  });
});
