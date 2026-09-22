// message_reads: who was handed what (src/services/reads.ts).

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { initDatabase } from "../../src/services/db";
import { createMessage, persistMessage } from "../../src/services/message";
import { markRead, readCheck, listInbox, rotateReads, readsCutover, UNREAD_CAP } from "../../src/services/reads";
import { maintenanceTasks } from "../../src/services/maintenance-tasks";
import { ActivityService } from "../../src/services/activity";

const DAY = 86_400_000;

describe("reads", () => {
  let db: Database.Database;
  const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
  function stored(opts: { to?: string; toKey?: string | null; fromKey?: string; ageMs?: number; payload?: string }) {
    const msg = createMessage({ from: "beta", to: opts.to ?? "alpha", type: "info", payload: opts.payload ?? "x", context: "ctx" });
    msg.created_at = iso(opts.ageMs ?? 0);
    // A broadcast written by this code carries "" as its key.
    const toKey = opts.toKey === undefined ? "alpha" : opts.toKey === null && opts.to === "broadcast" ? "" : opts.toKey;
    persistMessage(db, msg, { fromKey: opts.fromKey ?? "beta", toKey });
    return msg;
  }

  it("leaves out a broadcast an older release wrote: it has no key, and would look unread for ever", () => {
    cutoverAt(DAY);
    const old = createMessage({ from: "beta", to: "broadcast", type: "info", payload: "from the old release", context: "ctx" });
    persistMessage(db, old, { fromKey: "beta", toKey: null });
    stored({ to: "broadcast", toKey: null, payload: "from this release" });
    const inbox = listInbox(db, { key: "alpha", since: null, limit: 10 });
    expect(inbox.rows.map((r) => r.payload)).toEqual(["from this release"]);
    expect(inbox.unread).toBe(1);
  });

  it("counts as unread only what mesh_receive can still hand out", () => {
    cutoverAt(DAY);
    const ranOut = createMessage({ from: "beta", to: "alpha", type: "info", payload: "ran out", context: "ctx", ttl_seconds: 60 });
    ranOut.created_at = iso(10 * 60_000);
    persistMessage(db, ranOut, { fromKey: "beta", toKey: "alpha" });
    stored({ payload: "still due" });
    const read = stored({ payload: "read" });
    markRead(db, [read.id], "alpha");
    const inbox = listInbox(db, { key: "alpha", since: null, limit: 10 });
    expect(inbox.rows).toHaveLength(3);
    expect(inbox.unread).toBe(1);
  });
  const cutoverAt = (msAgo: number) =>
    db.prepare("UPDATE _migrations SET applied_at = ? WHERE name = '0010_message_reads.sql'").run(iso(msAgo));

  beforeEach(() => {
    db = initDatabase(":memory:");
  });

  it("keeps the first time a message was handed out", () => {
    markRead(db, ["msg_a"], "alpha", new Date("2026-09-01T10:00:00.000Z"));
    markRead(db, ["msg_a", "msg_b"], "alpha", new Date("2026-09-02T10:00:00.000Z"));
    const rows = db.prepare("SELECT message_id, read_at FROM message_reads ORDER BY message_id").all();
    expect(rows).toEqual([
      { message_id: "msg_a", read_at: "2026-09-01T10:00:00.000Z" },
      { message_id: "msg_b", read_at: "2026-09-02T10:00:00.000Z" },
    ]);
  });

  it("knows a read per reader", () => {
    markRead(db, ["msg_a"], "alpha");
    expect(readCheck(db, "alpha")("msg_a")).toBe(true);
    expect(readCheck(db, "beta")("msg_a")).toBe(false);
    expect(readCheck(db, "alpha")("msg_b")).toBe(false);
  });

  it("writes nothing for a reader without a key, or for no messages", () => {
    markRead(db, ["msg_a"], "");
    markRead(db, [], "alpha");
    expect(db.prepare("SELECT COUNT(*) AS n FROM message_reads").get()).toEqual({ n: 0 });
  });

  it("an inbox starts where reads began to be recorded, however old the agent is", () => {
    cutoverAt(DAY);
    stored({ ageMs: 2 * DAY, payload: "direct, before" });
    stored({ to: "broadcast", toKey: null, ageMs: 2 * DAY, payload: "broadcast, before" });
    stored({ ageMs: DAY / 2, payload: "direct, after" });
    stored({ to: "broadcast", toKey: null, ageMs: DAY / 3, payload: "broadcast, after" });
    const old = listInbox(db, { key: "alpha", since: iso(30 * DAY), limit: 10 });
    expect(old.rows.map((r) => r.payload)).toEqual(["broadcast, after", "direct, after"]);
    expect(old.unread).toBe(2);
  });

  it("an inbox starts at the agent's own start when that is later", () => {
    cutoverAt(10 * DAY);
    stored({ ageMs: 5 * DAY, payload: "for the one before" });
    stored({ ageMs: DAY, payload: "for this one" });
    const inbox = listInbox(db, { key: "alpha", since: iso(2 * DAY), limit: 10 });
    expect(inbox.rows.map((r) => r.payload)).toEqual(["for this one"]);
  });

  it("an inbox is empty, not everything, when nothing is known", () => {
    stored({});
    expect(listInbox(db, { key: "", since: null, limit: 10 })).toEqual({ rows: [], unread: 0 });
    db.prepare("DELETE FROM _migrations WHERE name = '0010_message_reads.sql'").run();
    expect(readsCutover(db)).toBeNull();
    expect(listInbox(db, { key: "alpha", since: null, limit: 10 })).toEqual({ rows: [], unread: 0 });
    expect(readsCutover(new Database(":memory:"))).toBeNull();
  });

  it("orders two messages of one millisecond by arrival", () => {
    cutoverAt(DAY);
    const at = iso(1000);
    for (const payload of ["first", "second"]) {
      const msg = createMessage({ from: "beta", to: "alpha", type: "info", payload, context: "ctx" });
      msg.created_at = at;
      persistMessage(db, msg, { fromKey: "beta", toKey: "alpha" });
    }
    expect(listInbox(db, { key: "alpha", since: null, limit: 10 }).rows.map((r) => r.payload)).toEqual(["second", "first"]);
  });

  it("stops counting past a cap: one number is not worth a hundred milliseconds of blocked database", () => {
    cutoverAt(DAY);
    for (let i = 0; i < UNREAD_CAP + 5; i++) stored({ payload: `m${i}` });
    const inbox = listInbox(db, { key: "alpha", since: null, limit: 10 });
    expect(inbox.rows).toHaveLength(10);
    expect(inbox.unread).toBe(UNREAD_CAP + 1);
  });

  it("does not count a message older than any deadline can reach", () => {
    cutoverAt(30 * DAY);
    const old = createMessage({ from: "beta", to: "alpha", type: "info", payload: "long gone", context: "ctx", ttl_seconds: 604_800 });
    old.created_at = iso(20 * DAY);
    persistMessage(db, old, { fromKey: "beta", toKey: "alpha" });
    const inbox = listInbox(db, { key: "alpha", since: null, limit: 10 });
    expect(inbox.rows.map((r) => r.payload)).toEqual(["long gone"]);
    expect(inbox.unread).toBe(0);
  });

  it("rotates by age, and keeps a read whose message the history never had", () => {
    markRead(db, ["msg_old"], "alpha", new Date(Date.now() - 31 * DAY));
    markRead(db, ["msg_gap"], "alpha", new Date(Date.now() - DAY));
    expect(rotateReads(db, 30)).toBe(1);
    expect(db.prepare("SELECT message_id FROM message_reads").all()).toEqual([{ message_id: "msg_gap" }]);
  });

  it("is rotated with the hourly maintenance, after the messages", () => {
    markRead(db, ["msg_old"], "alpha", new Date(Date.now() - 31 * DAY));
    const tasks = maintenanceTasks({ db, activity: new ActivityService(db), backupDir: null, backupKeep: 0 });
    const names = tasks.map((t) => t.name);
    expect(names.indexOf("message_reads")).toBeGreaterThan(names.indexOf("messages"));
    expect(tasks.find((t) => t.name === "message_reads")!.run()).toBe(1);
  });
});
