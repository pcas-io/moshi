// Against a real JetStream broker: what an agent finds in its inbox, and
// what inbox_pending tells it. The agents' loops trigger on that number.
//
// Skipped unless MOSHI_TEST_NATS_URL is set; run with
//   npm run test:integration
// EVERY TEST HERE DELETES THE STREAM AND THE PRESENCE BUCKET first. Loopback only.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { connect as natsConnect } from "nats";
import type { NatsConnection, JetStreamManager } from "nats";
import { StringCodec } from "nats";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type Database from "better-sqlite3";
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!URL)("an agent's inbox against a real JetStream broker", () => {
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
      // Emptied first, then deleted: on NATS 2.12 a stream that is deleted and
      // created again at once can come back with what the old one held.
      try { await jsm.streams.purge(name); } catch { /* not there yet */ }
      try { await jsm.streams.delete(name); } catch { /* not there yet */ }
    }
    // Tolerance 0: a test cannot wait out the five seconds two clocks may
    // differ by, and here both clocks are this machine's.
    nats = new NatsService(URL!, { consumerClockToleranceMs: 0 });
    await nats.connect();
  });

  afterEach(async () => {
    for (const n of extra.splice(0)) await n.close().catch(() => {});
    await nats?.close().catch(() => {});
    await admin?.close();
  });

  function stack(service: NatsService = nats, db: Database.Database = initDatabase(":memory:")) {
    const activity = new ActivityService(db);
    const agents = new AgentService(db, activity, service);
    const presence = new PresenceService(db, service);
    const rateLimiter = new RateLimiter(60);
    async function as(name: string) {
      const row = agents.getByName(name)!;
      // what the /mcp route does per request
      await service.ensureConsumer(inboxKeyOf(row), row.inbox_since, { replaceLeftBehind: agents.isAfterInboxCutover(row.inbox_since) });
      const server = createMcpServer({ nats: service, agents, activity, rateLimiter, presence, db, agentName: name, inboxKey: inboxKeyOf(row), isAdmin: false });
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
  const pending = async (call: Awaited<ReturnType<ReturnType<typeof stack>["as"]>>) => (await call("mesh_status")).json.inbox_pending;

  it("your own broadcast is not waiting for you and never comes back, while everybody else gets it", async () => {
    const { agents, as } = stack();
    agents.create("alpha");
    agents.create("beta");
    const alpha = await as("alpha");
    const beta = await as("beta");

    const sent = await alpha("mesh_send", { to: "broadcast", payload: "to all", context: CTX });
    expect(sent.json.inbox_pending).toBe(0);
    expect(await pending(alpha)).toBe(0);
    expect(await pending(beta)).toBe(1);

    await beta("mesh_send", { to: "broadcast", payload: "from beta", context: CTX });
    await alpha("mesh_send", { to: "broadcast", payload: "to all, again", context: CTX });
    expect(await pending(alpha)).toBe(1);
    const got = await alpha("mesh_receive", { limit: 1 });
    expect(payloads(got)).toEqual(["from beta"]);
    expect(got.json.inbox_pending).toBe(0);
    expect(payloads(await alpha("mesh_receive"))).toEqual([]);
    expect(payloads(await beta("mesh_receive"))).toEqual(["to all", "to all, again"]);
    expect(await pending(beta)).toBe(0);
  });

  it("a new agent finds nothing from before it existed, and everything since, also from before its first request", async () => {
    const { agents, as } = stack();
    agents.create("alpha");
    const alpha = await as("alpha");
    for (let i = 1; i <= 3; i++) await alpha("mesh_send", { to: "broadcast", payload: `old news ${i}`, context: CTX });

    await sleep(20);
    agents.create("newcomer"); // in the dashboard; its client has not connected yet
    await sleep(20);
    await alpha("mesh_send", { to: "newcomer", payload: "welcome", context: CTX });
    await alpha("mesh_send", { to: "broadcast", payload: "news", context: CTX });

    const newcomer = await as("newcomer"); // first request: only now do its durables get created
    expect(await pending(newcomer)).toBe(2);
    expect(payloads(await newcomer("mesh_receive"))).toEqual(["welcome", "news"]);
    expect(await pending(newcomer)).toBe(0);
  });

  it("revoke and reactivate hands out nothing a second time", async () => {
    const { agents, as } = stack();
    agents.create("alpha");
    const betaId = agents.create("beta").agent.id;
    const alpha = await as("alpha");
    let beta = await as("beta");
    await alpha("mesh_send", { to: "beta", payload: "read before the revoke", context: CTX });
    await alpha("mesh_send", { to: "broadcast", payload: "also read", context: CTX });
    expect(payloads(await beta("mesh_receive"))).toEqual(["read before the revoke", "also read"]);

    agents.revokeById(betaId, "admin");
    await sleep(50); // the durables go in the background
    agents.reactivate(betaId, "admin");
    beta = await as("beta");
    expect(await pending(beta)).toBe(0);
    expect(payloads(await beta("mesh_receive"))).toEqual([]);
    await alpha("mesh_send", { to: "beta", payload: "after the reactivation", context: CTX });
    expect(payloads(await beta("mesh_receive"))).toEqual(["after the reactivation"]);
  });

  it("the next agent with a name does not inherit the mail of a deleted one, even when the delete never reached the broker", async () => {
    const db = initDatabase(":memory:");
    const first = stack(nats, db);
    first.agents.create("alpha");
    first.agents.create("scout");
    const alpha = await first.as("alpha");
    await first.as("scout"); // its durables exist now
    await alpha("mesh_send", { to: "scout", payload: "for the OLD scout", context: CTX });

    // The delete happened during an outage: the row is gone, the durables are
    // not. Then the process restarted, and with it everything it remembered.
    db.prepare("DELETE FROM agents WHERE name = 'scout'").run();
    const restarted = new NatsService(URL!, { consumerClockToleranceMs: 0 });
    extra.push(restarted);
    await restarted.connect();
    const second = stack(restarted, db);

    await sleep(20);
    expect(inboxKeyOf(second.agents.create("scout").agent)).toBe("scout"); // the same address again
    const scout = await second.as("scout");
    expect(await pending(scout)).toBe(0);
    expect(payloads(await scout("mesh_receive"))).toEqual([]);

    const alphaAgain = await second.as("alpha");
    await alphaAgain("mesh_send", { to: "scout", payload: "for the NEW scout", context: CTX });
    expect(payloads(await scout("mesh_receive"))).toEqual(["for the NEW scout"]);
  });

  it("keeps the durables of an agent across a restart: nothing is replayed, nothing is lost", async () => {
    const db = initDatabase(":memory:");
    const first = stack(nats, db);
    first.agents.create("alpha");
    first.agents.create("beta");
    const alpha = await first.as("alpha");
    const beta = await first.as("beta");
    await alpha("mesh_send", { to: "beta", payload: "read", context: CTX });
    expect(payloads(await beta("mesh_receive"))).toEqual(["read"]);
    await alpha("mesh_send", { to: "beta", payload: "unread over the restart", context: CTX });

    const restarted = new NatsService(URL!, { consumerClockToleranceMs: 0 });
    extra.push(restarted);
    await restarted.connect();
    const betaAgain = await stack(restarted, db).as("beta");
    expect(payloads(await betaAgain("mesh_receive"))).toEqual(["unread over the restart"]);
  });

  it("drops what expired before it was read, says so, and leaves no phantom count behind", async () => {
    const { agents, as } = stack();
    agents.create("alpha");
    agents.create("beta");
    const alpha = await as("alpha");
    const beta = await as("beta");
    await alpha("mesh_send", { to: "beta", payload: "gone in a second", context: CTX, ttl_seconds: 1 });
    await alpha("mesh_send", { to: "broadcast", payload: "also gone", context: CTX, ttl_seconds: 1 });
    await alpha("mesh_send", { to: "beta", payload: "still good", context: CTX });
    await sleep(1200);
    const got = await beta("mesh_receive", { limit: 1 });
    expect(payloads(got)).toEqual(["still good"]);
    expect(got.json.expired_dropped).toBe(1); // the direct one; the broadcast side was not needed for limit 1
    const rest = await beta("mesh_receive");
    expect(payloads(rest)).toEqual([]);
    expect(rest.json.expired_dropped).toBe(1);
    expect(rest.json.inbox_pending).toBe(0);
    expect(rest.json.hint).toMatch(/expired/);
  });

  it("stores the broker's sequence with every message it sends", async () => {
    const { db, agents, as } = stack();
    agents.create("alpha");
    agents.create("beta");
    const alpha = await as("alpha");
    await alpha("mesh_send", { to: "beta", payload: "one", context: CTX });
    await alpha("mesh_send", { to: "broadcast", payload: "two", context: CTX });
    const rows = db.prepare("SELECT payload, stream_seq FROM messages ORDER BY stream_seq").all();
    expect(rows).toEqual([{ payload: "one", stream_seq: 1 }, { payload: "two", stream_seq: 2 }]);
  });

  it("does not let the history of a lost stream hide new broadcasts, before and after a receive", async () => {
    // The NATS volume is lost, the SQLite file is not: sequences start at 1
    // again while the old rows keep their higher ones for 30 days.
    const db = initDatabase(":memory:");
    const first = stack(nats, db);
    first.agents.create("alpha");
    first.agents.create("beta");
    const alpha = await first.as("alpha");
    const beta = await first.as("beta");
    for (let i = 1; i <= 6; i++) await alpha("mesh_send", { to: "broadcast", payload: `alpha old ${i}`, context: CTX });
    expect(payloads(await beta("mesh_receive"))).toHaveLength(6);

    await nats.close();
    await sleep(20);
    // Emptied first, then deleted, like every beforeEach in this suite: on
    // NATS 2.12 a stream that is deleted and created again at once can come
    // back holding what the old one held. That is not "the volume is lost",
    // which is what this case is about — and on a loaded runner it showed up
    // as seven waiting broadcasts where one was expected.
    await jsm.streams.purge(STREAM);
    await jsm.streams.delete(STREAM);
    const restarted = new NatsService(URL!, { consumerClockToleranceMs: 0 });
    extra.push(restarted);
    await restarted.connect();
    const second = stack(restarted, db);
    const alpha2 = await second.as("alpha");
    const beta2 = await second.as("beta");

    await beta2("mesh_send", { to: "broadcast", payload: "news 1", context: CTX });
    expect(await pending(alpha2)).toBe(1);
    await beta2("mesh_send", { to: "alpha", payload: "direct", context: CTX });
    await beta2("mesh_send", { to: "broadcast", payload: "news 2", context: CTX });
    expect(await pending(alpha2)).toBe(3);
    const got = await alpha2("mesh_receive", { limit: 2 });
    expect(payloads(got)).toEqual(["direct", "news 1"]);
    expect(got.json.inbox_pending).toBe(1);
    // And its own broadcasts into the NEW stream are still not counted.
    await alpha2("mesh_send", { to: "broadcast", payload: "alpha new", context: CTX });
    expect(await pending(alpha2)).toBe(1);
  });

  it("does not subtract own broadcasts that the stream's limits have already evicted", async () => {
    const { agents, as } = stack();
    agents.create("alpha");
    agents.create("beta");
    const alpha = await as("alpha");
    const beta = await as("beta");
    await alpha("mesh_send", { to: "broadcast", payload: "own 1", context: CTX });
    await alpha("mesh_send", { to: "broadcast", payload: "own 2", context: CTX });
    const info = await jsm.streams.info(STREAM);
    await jsm.streams.update(STREAM, { ...info.config, max_msgs: 1 }); // stands in for max_bytes
    await beta("mesh_send", { to: "broadcast", payload: "the only one left", context: CTX });
    expect(await pending(alpha)).toBe(1);
    expect(payloads(await alpha("mesh_receive"))).toEqual(["the only one left"]);
  });

  it("delivers a deleted agent's broadcast to the agent that was given its name", async () => {
    const { agents, as } = stack();
    const xavierId = agents.create("xavier").agent.id;
    const yaraId = agents.create("yara").agent.id;
    const xavier = await as("xavier");
    await as("yara");
    await xavier("mesh_send", { to: "broadcast", payload: "from the first xavier", context: CTX });
    agents.deleteById(xavierId, "admin");
    await sleep(50);
    agents.rename(yaraId, "xavier", "admin");
    const renamed = await as("xavier");
    expect(await pending(renamed)).toBe(1);
    expect(payloads(await renamed("mesh_receive"))).toEqual(["from the first xavier"]);
  });

  it("a body that is no message does not break the receive, nor cost the messages next to it a delivery", async () => {
    const { agents, as } = stack();
    agents.create("alpha");
    agents.create("beta");
    const alpha = await as("alpha");
    const beta = await as("beta");
    await admin.jetstream().publish("mesh.broadcast", StringCodec().encode("null")); // only a hand-made publish can do this
    await beta("mesh_send", { to: "broadcast", payload: "legitimate", context: CTX });
    const got = await alpha("mesh_receive");
    expect(got.json.hint ?? "").not.toMatch(/nats_unavailable/);
    expect(payloads(got)).toEqual(["legitimate"]);
    const consumer = await jsm.consumers.info(STREAM, "agent-alpha-broadcast");
    expect(consumer.num_ack_pending).toBe(0);
  });

  it("keeps the durable an agent from BEFORE the inbox_since rule has been reading from, however old it is", async () => {
    // Under the old code a re-created agent could inherit its predecessor's
    // durable and read from it for weeks. Replacing that one on the first
    // request after the deploy would hand it up to seven days of read mail.
    const db = initDatabase(":memory:");
    db.prepare("UPDATE _migrations SET applied_at = ? WHERE name = '0008_agent_inbox_since.sql'").run(new Date(Date.now() + 3600_000).toISOString());
    const { agents, as } = stack(nats, db);
    agents.create("alpha");
    await nats.ensureConsumer("scout"); // the inherited durables, older than the agent row
    await sleep(30);
    agents.create("scout");
    const alpha = await as("alpha");
    const before = (await jsm.consumers.info(STREAM, "agent-scout")).created;
    let scout = await as("scout");
    for (let i = 1; i <= 3; i++) await alpha("mesh_send", { to: "scout", payload: `read ${i}`, context: CTX });
    expect(payloads(await scout("mesh_receive"))).toHaveLength(3);

    // The deploy: a new process, which looks at the durables again.
    const restarted = new NatsService(URL!, { consumerClockToleranceMs: 0 });
    extra.push(restarted);
    await restarted.connect();
    scout = await stack(restarted, db).as("scout");
    expect((await jsm.consumers.info(STREAM, "agent-scout")).created).toBe(before);
    expect(await pending(scout)).toBe(0);
    expect(payloads(await scout("mesh_receive"))).toEqual([]);
  });
});

