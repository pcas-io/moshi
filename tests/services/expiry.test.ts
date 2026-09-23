// A message that ran out before anybody read it leaves one audit row, from
// whoever notices first: mesh_receive dropping it, or the hourly sweep.

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDatabase } from "../../src/services/db";
import { ActivityService } from "../../src/services/activity";
import { createMessage, persistMessage, expiresAt } from "../../src/services/message";
import { markRead } from "../../src/services/reads";
import { noteExpired, sweepExpiredUnread, MESSAGE_EXPIRED } from "../../src/services/expiry";
import { maintenanceTasks, EXPIRED_UNREAD_TASK } from "../../src/services/maintenance-tasks";
import { createHarness, callTool } from "../mcp/harness";

const HOUR = 3_600_000;

describe("expired unread", () => {
  let db: Database.Database;
  let activity: ActivityService;
  const expiredRows = () =>
    db.prepare("SELECT entity_id, summary, agent_name FROM activity_log WHERE action = ? ORDER BY rowid").all(MESSAGE_EXPIRED) as
      { entity_id: string; summary: string; agent_name: string }[];

  /** A stored message, `ageMs` old. */
  function stored(opts: { to?: string; toKey?: string | null; ttl?: number; ageMs?: number; from?: string } = {}) {
    const msg = createMessage({ from: opts.from ?? "alpha", to: opts.to ?? "beta", type: "info", payload: "x", context: "ctx", ttl_seconds: opts.ttl ?? 60 });
    msg.created_at = new Date(Date.now() - (opts.ageMs ?? 10 * 60_000)).toISOString();
    persistMessage(db, msg, { fromKey: "alpha", toKey: opts.toKey === undefined ? "beta" : opts.toKey, streamSeq: 1 });
    return msg;
  }

  beforeEach(() => {
    db = initDatabase(":memory:");
    activity = new ActivityService(db);
    // Reads have been recorded for a day: the messages below are younger.
    db.prepare("UPDATE _migrations SET applied_at = ? WHERE name = '0010_message_reads.sql'").run(new Date(Date.now() - 24 * HOUR).toISOString());
  });

  it("notes a message once, in a sentence, under its sender", () => {
    const msg = stored({ ttl: 90 });
    expect(noteExpired(db, activity, msg)).toBe(true);
    expect(noteExpired(db, activity, msg)).toBe(false);
    expect(expiredRows()).toEqual([
      { entity_id: msg.id, summary: "alpha → beta: expired unread, its deadline was 90 s", agent_name: "alpha" },
    ]);
  });

  it("writes the deadline the way a person would say it", () => {
    const said = (ttl: number) => {
      const msg = stored({ ttl });
      noteExpired(db, activity, msg);
      return expiredRows().find((r) => r.entity_id === msg.id)!.summary.split("was ")[1];
    };
    expect([said(45), said(120), said(7200), said(86_400), said(172_800), said(3_660)]).toEqual(["45 s", "2 min", "2 h", "1 d", "2 d", "61 min"]);
  });

  it("takes the names from the history, where a rename has rewritten them", () => {
    const msg = stored();
    db.prepare("UPDATE messages SET to_agent = 'gamma' WHERE id = ?").run(msg.id);
    noteExpired(db, activity, msg);
    expect(expiredRows()[0].summary).toContain("alpha → gamma");
  });

  it("falls back to the envelope for a message the history never took", () => {
    noteExpired(db, activity, { id: "msg_gap", from: "alpha", to: "beta", ttl_seconds: 60 });
    expect(expiredRows()[0].summary).toContain("alpha → beta");
  });

  it("the sweep finds what ran out unread, and nothing else", () => {
    const ranOut = stored();
    const read = stored();
    markRead(db, [read.id], "beta");
    const readByAnother = stored();
    markRead(db, [readByAnother.id], "gamma");
    stored({ ttl: 86_400 }); // still running
    // Both halves of "direct mail only", each on its own row. A broadcast
    // this code wrote has to_key "" and is excluded by `!= \'\'`; a row from
    // before recipients were stored by key has NULL and is excluded by
    // `IS NOT NULL`. With only the NULL row the second half was pinned by
    // nothing: dropping it left the whole suite green.
    stored({ to: "broadcast", toKey: "" }); // nobody in particular missed it
    stored({ to: "broadcast", toKey: null }); // and from before the keys
    stored({ ageMs: 48 * HOUR }); // from before reads were recorded

    expect(sweepExpiredUnread(db, activity)).toBe(2);
    expect(expiredRows().map((r) => r.entity_id).sort()).toEqual([ranOut.id, readByAnother.id].sort());
    expect(sweepExpiredUnread(db, activity)).toBe(0);
    expect(expiredRows()).toHaveLength(2);
  });

  it("the sweep is exact at the deadline, to the second", () => {
    const now = Date.now();
    const msg = stored({ ttl: 600, ageMs: 600_000 - 1_500 });
    expect(sweepExpiredUnread(db, activity, now)).toBe(0);
    expect(sweepExpiredUnread(db, activity, now + 3_000)).toBe(1);
    expect(expiredRows()[0].entity_id).toBe(msg.id);
  });

  it("the sweep does nothing on a database that was never migrated this far", () => {
    stored();
    db.prepare("DELETE FROM _migrations WHERE name = '0010_message_reads.sql'").run();
    expect(sweepExpiredUnread(db, activity)).toBe(0);
  });

  it("runs with the hourly maintenance, before the history is rotated", () => {
    const msg = stored();
    const tasks = maintenanceTasks({ db, activity, backupDir: null, backupKeep: 0 });
    const names = tasks.map((t) => t.name);
    expect(names.indexOf(EXPIRED_UNREAD_TASK)).toBeGreaterThanOrEqual(0);
    expect(names.indexOf(EXPIRED_UNREAD_TASK)).toBeLessThan(names.indexOf("messages"));
    expect(tasks.find((t) => t.name === EXPIRED_UNREAD_TASK)!.run()).toBe(1);
    expect(expiredRows()[0].entity_id).toBe(msg.id);
  });
});

describe("mesh_receive notes what it drops as expired", () => {
  const CTX = "expiry test";
  const past = () => new Date(Date.now() - HOUR).toISOString();
  const envelope = (id: string, to: string) => ({ id, from: "beta", to, type: "info", payload: "too late", context: CTX, correlation_id: null, reply_to: null, priority: "normal", ttl_seconds: 60, created_at: past() });

  it("one audit row per direct message, also when the broker delivers it again", async () => {
    const h = createHarness();
    h.agents.create("alpha");
    h.agents.create("beta");
    const alpha = await h.connect("alpha");
    h.nats.enqueue("alpha", envelope("msg_late", "alpha"));
    await callTool(alpha, "mesh_receive", {});
    h.nats.enqueue("alpha", envelope("msg_late", "alpha"));
    await callTool(alpha, "mesh_receive", {});
    const rows = h.db.prepare("SELECT entity_id, agent_name FROM activity_log WHERE action = ?").all(MESSAGE_EXPIRED);
    expect(rows).toEqual([{ entity_id: "msg_late", agent_name: "beta" }]);
  });

  it("none for a broadcast: there is no one reader who missed it", async () => {
    const h = createHarness();
    h.agents.create("alpha");
    h.agents.create("beta");
    const alpha = await h.connect("alpha");
    h.nats.enqueueRaw("mesh.broadcast", JSON.stringify(envelope("msg_late_all", "broadcast")));
    const got = await callTool(alpha, "mesh_receive", {});
    expect(got.json.expired_dropped).toBe(1);
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM activity_log WHERE action = ?").get(MESSAGE_EXPIRED)).toEqual({ n: 0 });
  });

  it("still answers when the audit row cannot be written", async () => {
    const h = createHarness();
    h.agents.create("alpha");
    h.agents.create("beta");
    const alpha = await h.connect("alpha");
    const beta = await h.connect("beta");
    h.nats.enqueue("alpha", envelope("msg_late", "alpha"));
    await callTool(beta, "mesh_send", { to: "alpha", payload: "in time", context: CTX });
    h.db.exec("CREATE TRIGGER no_audit BEFORE INSERT ON activity_log BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END");
    const got = await callTool(alpha, "mesh_receive", {});
    expect(got.isError, got.text).toBe(false);
    expect((got.json.messages as { payload: string }[]).map((m) => m.payload)).toEqual(["in time"]);
  });
});

describe("expired unread, the edges", () => {
  let db: Database.Database;
  let activity: ActivityService;
  beforeEach(() => {
    db = initDatabase(":memory:");
    activity = new ActivityService(db);
    db.prepare("UPDATE _migrations SET applied_at = ? WHERE name = '0010_message_reads.sql'").run(new Date(Date.now() - 24 * HOUR).toISOString());
  });
  const stored = (ageMs = 10 * 60_000, ttl = 60) => {
    const msg = createMessage({ from: "alpha", to: "beta", type: "info", payload: "x", context: "ctx", ttl_seconds: ttl });
    msg.created_at = new Date(Date.now() - ageMs).toISOString();
    persistMessage(db, msg, { fromKey: "alpha", toKey: "beta", streamSeq: 1 });
    return msg;
  };
  const rows = () => db.prepare("SELECT entity_id FROM activity_log WHERE action = ?").all(MESSAGE_EXPIRED);

  it("writes one row when two processes notice the same message at the same moment", () => {
    // One file, two connections: A has asked "noted?", B notes it, then A inserts.
    const path = `${mkdtempSync(join(tmpdir(), "moshi-expiry-"))}/moshi.db`;
    const a = initDatabase(path);
    const b = new Database(path);
    try {
      b.prepare("UPDATE _migrations SET applied_at = ? WHERE name = '0010_message_reads.sql'").run(new Date(Date.now() - 24 * HOUR).toISOString());
      const msg = createMessage({ from: "alpha", to: "beta", type: "info", payload: "x", context: "ctx", ttl_seconds: 60 });
      msg.created_at = new Date(Date.now() - 10 * 60_000).toISOString();
      persistMessage(a, msg, { fromKey: "alpha", toKey: "beta" });
      const actA = new ActivityService(a);
      const actB = new ActivityService(b);
      // A's check and insert are one immediate transaction: B cannot slip
      // in between them. Prove the outcome: after both, exactly one row.
      expect(noteExpired(a, actA, msg)).toBe(true);
      expect(noteExpired(b, actB, msg)).toBe(false);
      expect(a.prepare("SELECT COUNT(*) AS n FROM activity_log WHERE action = ?").get(MESSAGE_EXPIRED)).toEqual({ n: 1 });
      // And the write itself is atomic with the check: a second insert of the same fact is refused by the schema.
      expect(() => a.prepare("INSERT INTO activity_log (id, action, entity_type, entity_id, summary, agent_name, created_at) VALUES ('x', ?, 'message', ?, 's', 'alpha', ?)").run(MESSAGE_EXPIRED, msg.id, new Date().toISOString())).toThrow(/UNIQUE/);
    } finally {
      a.close();
      b.close();
    }
  });

  it("does not call a message expired unread when its read could not be recorded", () => {
    const msg = stored();
    activity.log({ action: "read_not_recorded", entity_type: "message", entity_id: msg.id, summary: "beta was handed it; the read could not be stored", agent_name: "beta" });
    expect(sweepExpiredUnread(db, activity)).toBe(0);
    expect(rows()).toEqual([]);
  });

  it("skips a row whose created_at is no date instead of throwing", () => {
    const msg = stored();
    db.prepare("UPDATE messages SET created_at = 'yesterday' WHERE id = ?").run(msg.id);
    expect(sweepExpiredUnread(db, activity)).toBe(0);
    expect(expiresAt({ created_at: "yesterday", ttl_seconds: 60 })).toBeNull();
  });
});
