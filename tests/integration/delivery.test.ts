// The delivery core against a real JetStream broker: a send whose outcome
// nobody knows and its repeat, a delivery the history did not take, a
// deadline that runs out, and a message the broker gives up on.
//
// Needs MOSHI_TEST_NATS_URL and MOSHI_TEST_NATS_CONTAINER, both set by
//   npm run test:integration
// EVERY TEST HERE DELETES THE STREAM AND THE PRESENCE BUCKET first. Loopback only.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
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
import { recordDeadLetter, MESSAGE_DEAD_LETTER } from "../../src/services/dead-letter";
import { sweepExpiredUnread, MESSAGE_EXPIRED } from "../../src/services/expiry";

const URL = process.env.MOSHI_TEST_NATS_URL;
const CONTAINER = process.env.MOSHI_TEST_NATS_CONTAINER;
if (process.env.MOSHI_TEST_NATS_REQUIRED === "1" && (!URL || !CONTAINER)) {
  throw new Error("MOSHI_TEST_NATS_REQUIRED is set but MOSHI_TEST_NATS_URL or MOSHI_TEST_NATS_CONTAINER is empty");
}
const LOOPBACK = /^nats:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+$/;
const STREAM = "MESH_MESSAGES";
const CTX = "delivery integration test";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const docker = (...args: string[]) => execFileSync("docker", args, { stdio: "ignore" });
const idIn = (text: string) => /msg_[0-9A-HJKMNP-TV-Z]{26}/.exec(text)?.[0] ?? "";

describe.skipIf(!URL || !CONTAINER)("the delivery core against a real JetStream broker", () => {
  let admin: NatsConnection;
  let jsm: JetStreamManager;
  const services: NatsService[] = [];
  let paused = false;
  const pause = () => { docker("pause", CONTAINER!); paused = true; };
  const unpause = () => { if (paused) { docker("unpause", CONTAINER!); paused = false; } };

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
  });

  afterEach(async () => {
    unpause(); // never leave the broker frozen for the next test
    for (const n of services.splice(0)) await n.close().catch(() => {});
    await admin?.close();
  });

  async function stack(opts: ConstructorParameters<typeof NatsService>[1] = {}) {
    const nats = new NatsService(URL!, { consumerClockToleranceMs: 0, ...opts });
    services.push(nats);
    await nats.connect();
    const db = initDatabase(":memory:");
    const activity = new ActivityService(db);
    const agents = new AgentService(db, activity, nats);
    const presence = new PresenceService(db, nats);
    const rateLimiter = new RateLimiter(60);
    async function as(name: string) {
      const row = agents.getByName(name)!;
      await nats.ensureConsumer(inboxKeyOf(row), row.inbox_since, { replaceLeftBehind: agents.isAfterInboxCutover(row.inbox_since) });
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
    agents.create("alpha");
    agents.create("beta");
    return { nats, db, activity, agents, alpha: await as("alpha"), beta: await as("beta") };
  }
  const payloads = (r: { json: Record<string, any> }) => (r.json.messages as { payload: string }[]).map((m) => m.payload);
  const auditRows = (db: ReturnType<typeof initDatabase>, action: string) =>
    db.prepare("SELECT entity_id, agent_name, summary FROM activity_log WHERE action = ? ORDER BY rowid").all(action) as { entity_id: string; agent_name: string; summary: string }[];
  const streamMessages = async () => (await jsm.streams.info(STREAM)).state.messages;

  it("a send into a frozen broker is repeated under its id, and arrives once", async () => {
    const { db, alpha, beta } = await stack();
    pause();
    const first = await alpha("mesh_send", { to: "beta", payload: "important", context: CTX });
    expect(first.isError).toBe(true);
    expect(first.text).toContain("could not be confirmed");
    const id = idIn(first.text);
    expect(first.text).toContain(`message_id="${id}"`);
    expect(db.prepare("SELECT COUNT(*) AS n FROM messages").get()).toEqual({ n: 0 });

    unpause();
    // The breaker answers for the broker for five more seconds.
    let again = await alpha("mesh_send", { to: "beta", payload: "important", context: CTX, message_id: id });
    for (let i = 0; again.isError && i < 40; i++) {
      await sleep(500);
      again = await alpha("mesh_send", { to: "beta", payload: "important", context: CTX, message_id: id });
    }
    expect(again.isError, again.text).toBe(false);
    expect(again.json.id).toBe(id);
    // The bytes of the first attempt sat in the socket and were stored the
    // moment the broker breathed again: that is the case this is for.
    expect(again.json.duplicate).toBe(true);
    expect(await streamMessages()).toBe(1);

    expect(payloads(await beta("mesh_receive"))).toEqual(["important"]);
    expect((await beta("mesh_receive")).json.messages).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM messages WHERE id = ?").get(id)).toEqual({ n: 1 });
    expect((await beta("mesh_get", { message_id: id })).isError).toBe(false);
    expect((await beta("mesh_reply", { message_id: id, payload: "got it", context: CTX })).isError).toBe(false);
  }, 60_000);

  it("a delivery the history did not take is mended by its repeat, without a second delivery", async () => {
    const { db, alpha, beta } = await stack();
    db.exec("CREATE TRIGGER no_history BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END");
    const sent = await alpha("mesh_send", { to: "beta", payload: "delivered anyway", context: CTX });
    expect(sent.isError, sent.text).toBe(false);
    expect(sent.json.history_gap).toBe(true);
    db.exec("DROP TRIGGER no_history");

    const again = await alpha("mesh_send", { to: "beta", payload: "delivered anyway", context: CTX, message_id: sent.json.id });
    expect(again.isError, again.text).toBe(false);
    expect(again.json.duplicate).toBe(true);
    expect(again.json.history_gap).toBeUndefined();
    expect(await streamMessages()).toBe(1);
    const row = db.prepare("SELECT stream_seq, to_key FROM messages WHERE id = ?").get(sent.json.id);
    expect(row).toEqual({ stream_seq: 1, to_key: "beta" });
    expect(payloads(await beta("mesh_receive"))).toEqual(["delivered anyway"]);
  });

  it("a deadline that runs out is told to the sender beforehand and noted afterwards", async () => {
    const { db, activity, alpha, beta } = await stack();
    const polled = await alpha("mesh_send", { to: "beta", payload: "read too late", context: CTX, ttl_seconds: 1 });
    expect(Date.parse(polled.json.expires_at)).toBe(Date.parse(polled.json.created_at) + 1000);
    await sleep(1300);

    const got = await beta("mesh_receive");
    expect(got.json.messages).toEqual([]);
    expect(got.json.expired_dropped).toBe(1);
    expect(got.json.inbox_pending).toBe(0);
    expect(auditRows(db, MESSAGE_EXPIRED).map((r) => [r.entity_id, r.agent_name])).toEqual([[polled.json.id, "alpha"]]);

    // And for a recipient that does not poll at all: the hourly sweep.
    const never = await alpha("mesh_send", { to: "beta", payload: "never read", context: CTX, ttl_seconds: 1 });
    await sleep(2100);
    expect(sweepExpiredUnread(db, activity)).toBe(1);
    expect(auditRows(db, MESSAGE_EXPIRED).map((r) => r.entity_id)).toEqual([polled.json.id, never.json.id]);
    const inbox = await beta("mesh_inbox", { unread_only: true });
    expect(inbox.json.messages.map((m: { id: string; expired?: boolean }) => [m.id, m.expired])).toEqual([[never.json.id, true], [polled.json.id, true]]);
  });

  it("a message the broker gives up on is noted, and is still in mesh_inbox", async () => {
    const { nats, db, activity, alpha, beta } = await stack({ consumerAckWaitMs: 500, consumerMaxDeliver: 2 });
    nats.onDeadLetter((letter, created) => recordDeadLetter(db, activity, letter, created));
    const sent = await alpha("mesh_send", { to: "beta", payload: "never acknowledged", context: CTX });

    // Handed out and not acked, as often as the durable allows.
    for (let i = 0; i < 2; i++) {
      const pull = await nats.pullInbox("beta", 10);
      expect(pull.messages, `delivery ${i + 1}`).toHaveLength(1);
      await sleep(700);
    }
    // The broker notices on the delivery that does not happen.
    let noted = auditRows(db, MESSAGE_DEAD_LETTER);
    for (let i = 0; noted.length === 0 && i < 20; i++) {
      await nats.pullInbox("beta", 10);
      await sleep(250);
      noted = auditRows(db, MESSAGE_DEAD_LETTER);
    }
    expect(noted.map((r) => [r.entity_id, r.agent_name])).toEqual([[sent.json.id, "beta"]]);
    expect(noted[0].summary).toContain("2 times");

    // Given up on is not waiting: a loop that reads while inbox_pending is
    // above zero must not spin on it.
    const after = await beta("mesh_receive");
    expect(after.json.messages).toEqual([]);
    expect(after.json.inbox_pending).toBe(0);
    expect((await beta("mesh_status")).json.inbox_pending).toBe(0);
    const inbox = await beta("mesh_inbox");
    expect(inbox.json.messages.map((m: { id: string; read_at: string | null }) => [m.id, m.read_at])).toEqual([[sent.json.id, null]]);
    expect((await beta("mesh_get", { message_id: sent.json.id })).json.payload).toBe("never acknowledged");
  }, 30_000);
});
