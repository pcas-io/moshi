// Migration 0006 on a database that already has messages — the live case.
//
// mesh_send used to store any string as correlation_id. An empty one made
// every such message one thread with the id "", which no link can name. One
// with spaces around it made a thread whose own row could not open it.

import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "fs";
import { getThread, listConversationSummaries } from "../../src/services/message-queries";

const MIGRATION = "0006_normalize_correlation_id.sql";

function legacyDb(): Database.Database {
  const db = new Database(":memory:");
  for (const file of readdirSync("migrations").filter((f) => f.endsWith(".sql") && f < MIGRATION).sort()) {
    db.exec(readFileSync(`migrations/${file}`, "utf-8"));
  }
  const insert = db.prepare(
    `INSERT INTO messages (id, from_agent, to_agent, type, payload, context, correlation_id, reply_to, priority, ttl_seconds, created_at)
     VALUES (?, 'alpha', 'beta', 'info', ?, 'ctx', ?, NULL, 'normal', 86400, ?)`,
  );
  insert.run("m1", "empty one", "", "2026-09-01T10:00:00.000Z");
  insert.run("m2", "empty two", "", "2026-09-01T10:01:00.000Z");
  insert.run("m3", "blank", "   ", "2026-09-01T10:02:00.000Z");
  insert.run("m4", "padded", " topic-1 ", "2026-09-01T10:03:00.000Z");
  insert.run("m5", "clean", "topic-1", "2026-09-01T10:04:00.000Z");
  insert.run("m6", "root", null, "2026-09-01T10:05:00.000Z");
  insert.run("m7", "reply", "m6", "2026-09-01T10:06:00.000Z");
  return db;
}

describe("migration 0006 — normalize correlation_id", () => {
  it("turns an empty or blank id into none, and trims a padded one", () => {
    const db = legacyDb();
    db.exec(readFileSync(`migrations/${MIGRATION}`, "utf-8"));
    const rows = db.prepare("SELECT id, correlation_id FROM messages ORDER BY id").all();
    expect(rows).toEqual([
      { id: "m1", correlation_id: null },
      { id: "m2", correlation_id: null },
      { id: "m3", correlation_id: null },
      { id: "m4", correlation_id: "topic-1" },
      { id: "m5", correlation_id: "topic-1" },
      { id: "m6", correlation_id: null },
      { id: "m7", correlation_id: "m6" },
    ]);
  });

  it("leaves every thread openable from the id its row carries", () => {
    const db = legacyDb();
    db.exec(readFileSync(`migrations/${MIGRATION}`, "utf-8"));
    const rows = listConversationSummaries(db, { limit: 50, offset: 0 }).data;
    expect(rows.map((r) => r.thread_id).sort()).toEqual(["m1", "m2", "m3", "m6", "topic-1"]);
    for (const row of rows) {
      expect(row.thread_id.trim()).toBe(row.thread_id);
      expect(getThread(db, row.thread_id)!.message_count, row.thread_id).toBe(row.message_count);
    }
    expect(getThread(db, "topic-1")!.messages.map((m) => m.payload)).toEqual(["padded", "clean"]);
  });

  it("can run twice", () => {
    const db = legacyDb();
    const sql = readFileSync(`migrations/${MIGRATION}`, "utf-8");
    db.exec(sql);
    const once = db.prepare("SELECT id, correlation_id FROM messages ORDER BY id").all();
    db.exec(sql);
    expect(db.prepare("SELECT id, correlation_id FROM messages ORDER BY id").all()).toEqual(once);
  });
});
