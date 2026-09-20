import { describe, it, expect, beforeEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { initDatabase } from "../../src/services/db";
import {
  createMessage,
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
