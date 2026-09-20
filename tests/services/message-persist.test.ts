import { describe, it, expect, beforeEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { initDatabase } from "../../src/services/db";
import {
  createMessage,
  ownBroadcastsBehind,
  persistMessage,
  sendAndPersistMessage,
} from "../../src/services/message";

function createTestDb(): Database.Database {
  // initDatabase accepts ":memory:" and runs all migrations from ./migrations
  return initDatabase(":memory:");
}

describe("persistMessage", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it("inserts a message into the messages table", () => {
    const msg = createMessage({
      from: "alpha",
      to: "beta",
      type: "info",
      payload: "hello",
      context: "test",
    });

    persistMessage(db, msg);

    const row = db
      .prepare("SELECT * FROM messages WHERE id = ?")
      .get(msg.id) as {
      id: string;
      from_agent: string;
      to_agent: string;
      type: string;
    };
    expect(row).toBeDefined();
    expect(row.id).toBe(msg.id);
    expect(row.from_agent).toBe("alpha");
    expect(row.to_agent).toBe("beta");
    expect(row.type).toBe("info");
  });

  it("throws on duplicate message id (unique constraint)", () => {
    const msg = createMessage({
      from: "alpha",
      to: "beta",
      type: "info",
      payload: "hello",
      context: "test",
    });
    persistMessage(db, msg);

    expect(() => persistMessage(db, msg)).toThrow();
  });
});

describe("sendAndPersistMessage — NATS-first dual-write order (ADR-006)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it("publishes to NATS then persists to DB on happy path", async () => {
    const publishCalls: Array<{ subject: string; msgId: string }> = [];
    const nats = {
      publish: vi.fn(async (subject: string, _data: Uint8Array, msgId: string) => {
        publishCalls.push({ subject, msgId });
      }),
    };

    const msg = createMessage({
      from: "alpha",
      to: "beta",
      type: "info",
      payload: "hi",
      context: "test",
    });

    const result = await sendAndPersistMessage(
      nats,
      db,
      msg,
      "mesh.agents.beta.inbox",
    );

    expect(result.delivered).toBe(true);
    expect(result.persisted).toBe(true);
    expect(publishCalls).toHaveLength(1);
    expect(publishCalls[0].subject).toBe("mesh.agents.beta.inbox");
    expect(publishCalls[0].msgId).toBe(msg.id);

    const row = db
      .prepare("SELECT id FROM messages WHERE id = ?")
      .get(msg.id);
    expect(row).toBeDefined();
  });

  it("returns delivered=false and DOES NOT persist when NATS publish fails", async () => {
    const nats = {
      publish: vi.fn(async () => {
        throw new Error("nats down");
      }),
    };

    const msg = createMessage({
      from: "alpha",
      to: "beta",
      type: "info",
      payload: "hi",
      context: "test",
    });

    const result = await sendAndPersistMessage(
      nats,
      db,
      msg,
      "mesh.agents.beta.inbox",
    );

    expect(result.delivered).toBe(false);
    expect(result.persisted).toBe(false);
    expect(result.error).toBe("nats_unavailable");

    // CRITICAL: the message MUST NOT be in the DB (no phantom-send)
    const row = db
      .prepare("SELECT id FROM messages WHERE id = ?")
      .get(msg.id);
    expect(row).toBeUndefined();
  });

  it("says 'delivery unknown' for a publish that timed out, and keeps 'unavailable' for one that was never sent", async () => {
    // A timeout is not a "no". The bytes may sit in the socket and be stored
    // the moment the broker answers again. Telling the sender "not delivered"
    // makes it send a second copy.
    const send = (err: unknown) => sendAndPersistMessage(
      { publish: vi.fn(async () => { throw err; }) }, db,
      createMessage({ from: "alpha", to: "beta", type: "info", payload: "hi", context: "test" }),
      "mesh.agents.beta.inbox",
    );
    const timedOut = await send(Object.assign(new Error("TIMEOUT"), { code: "TIMEOUT" }));
    expect(timedOut).toMatchObject({ delivered: false, persisted: false, error: "delivery_unknown" });

    const refused = await send(Object.assign(new Error("broker unavailable"), { name: "BrokerUnavailableError" }));
    expect(refused).toMatchObject({ delivered: false, persisted: false, error: "nats_unavailable" });
    const closed = await send(Object.assign(new Error("CONNECTION_CLOSED"), { code: "CONNECTION_CLOSED" }));
    expect(closed.error).toBe("nats_unavailable");
  });

  it("returns delivered=true and persisted=false when DB insert fails after NATS success", async () => {
    const nats = {
      publish: vi.fn(async () => {
        // NATS publish succeeds
      }),
    };

    const msg = createMessage({
      from: "alpha",
      to: "beta",
      type: "info",
      payload: "hi",
      context: "test",
    });

    // Pre-insert the same id to force unique-constraint failure on persistMessage
    persistMessage(db, msg);

    // Second call with the same msg triggers DB insert failure after NATS success
    const result = await sendAndPersistMessage(
      nats,
      db,
      msg,
      "mesh.agents.beta.inbox",
    );

    expect(result.delivered).toBe(true);
    expect(result.persisted).toBe(false);
    expect(nats.publish).toHaveBeenCalledTimes(1);
  });
});

// The broker counts an agent's own broadcasts as pending for it. What is
// subtracted has to be exactly those that are still ahead of its consumer AND
// in the stream the broker is counting in.
describe("ownBroadcastsBehind", () => {
  const NOW = Date.parse("2026-09-20T12:00:00.000Z");
  const daysAgo = (d: number) => new Date(NOW - d * 24 * 60 * 60 * 1000).toISOString();
  const STREAM = { created: daysAgo(20), firstSeq: 1, lastSeq: 1000 };
  let db: Database.Database;
  beforeEach(() => { db = initDatabase(":memory:"); });

  function put(fromKey: string | null, to: string, seq: number | null, createdAt: string, from = fromKey ?? "somebody") {
    const m = createMessage({ from, to, type: "info", payload: "p", context: "c" });
    m.created_at = createdAt;
    persistMessage(db, m, { streamSeq: seq, fromKey });
  }

  it("counts the sender's own broadcasts behind the position, by its inbox key, and nothing else", () => {
    put("alpha", "broadcast", 10, daysAgo(1)); // already handed out
    put("alpha", "broadcast", 11, daysAgo(1));
    put("alpha", "broadcast", 12, daysAgo(0));
    put("beta", "broadcast", 13, daysAgo(0));  // somebody else's
    put("alpha", "beta", 14, daysAgo(0));      // not a broadcast
    put("alpha", "broadcast", null, daysAgo(0)); // no sequence known
    put(null, "broadcast", 15, daysAgo(0), "alpha"); // sent before keys were stored: a name proves nothing
    expect(ownBroadcastsBehind(db, "alpha", 10, STREAM, NOW)).toBe(2);
    expect(ownBroadcastsBehind(db, "alpha", 12, STREAM, NOW)).toBe(0);
    expect(ownBroadcastsBehind(db, "beta", 0, STREAM, NOW)).toBe(1);
  });

  it("leaves out what the stream has dropped by age: the broker does not count it either", () => {
    // The history keeps a row for 30 days, the stream a message for 7.
    put("alpha", "broadcast", 5, daysAgo(8));
    put("alpha", "broadcast", 6, daysAgo(6));
    expect(ownBroadcastsBehind(db, "alpha", 0, STREAM, NOW)).toBe(1);
  });

  it("leaves out rows of another stream: sequences start over when the stream is recreated", () => {
    // The NATS volume was lost, the SQLite file was not. The old rows carry
    // sequences in the thousands, the new stream is at 3.
    put("alpha", "broadcast", 4711, daysAgo(2));
    put("alpha", "broadcast", 4712, daysAgo(1));
    put("alpha", "broadcast", 2, daysAgo(0)); // sent into the new stream
    const recreated = { created: daysAgo(0.5), firstSeq: 1, lastSeq: 3 };
    expect(ownBroadcastsBehind(db, "alpha", 0, recreated, NOW)).toBe(1);
    // Old rows that happen to fall into the new range are older than the stream.
    put("alpha", "broadcast", 3, daysAgo(3));
    expect(ownBroadcastsBehind(db, "alpha", 0, recreated, NOW)).toBe(1);
    // And a row from after the recreate with a sequence the stream has not
    // reached (a SQLite file restored over a younger stream) is not in it either.
    put("alpha", "broadcast", 99, daysAgo(0.1));
    expect(ownBroadcastsBehind(db, "alpha", 0, recreated, NOW)).toBe(1);
  });

  it("leaves out what the stream's limits have evicted", () => {
    put("alpha", "broadcast", 7, daysAgo(0));
    put("alpha", "broadcast", 8, daysAgo(0));
    expect(ownBroadcastsBehind(db, "alpha", 0, { ...STREAM, firstSeq: 8 }, NOW)).toBe(1);
  });
});
