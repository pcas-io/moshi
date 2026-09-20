// Migrations 0007 and 0008 on a database that already has agents and
// messages — the live case.

import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "fs";

const FIRST = "0007_message_stream_seq.sql";
const NEW = ["0007_message_stream_seq.sql", "0008_agent_inbox_since.sql"];

function legacyDb(): Database.Database {
  const db = new Database(":memory:");
  for (const file of readdirSync("migrations").filter((f) => f.endsWith(".sql") && f < FIRST).sort()) {
    db.exec(readFileSync(`migrations/${file}`, "utf-8"));
  }
  db.prepare(
    `INSERT INTO agents (id, name, inbox_key, name_since, token_hash, is_active, created_at, updated_at)
     VALUES ('a1', 'Tech-CIO', 'tech-cio', '2026-05-18T00:00:00.000Z', 'h1', 1, '2026-05-18T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`,
  ).run();
  db.prepare(
    `INSERT INTO messages (id, from_agent, to_agent, type, payload, context, correlation_id, reply_to, priority, ttl_seconds, created_at)
     VALUES ('m1', 'Tech-CIO', 'broadcast', 'info', 'p', 'c', NULL, NULL, 'normal', 86400, '2026-09-19T10:00:00.000Z')`,
  ).run();
  return db;
}

describe("migrations 0007 and 0008", () => {
  it("dates every existing agent's inbox from its creation, so its durables stay its own", () => {
    const db = legacyDb();
    for (const file of NEW) db.exec(readFileSync(`migrations/${file}`, "utf-8"));
    expect(db.prepare("SELECT name, inbox_since FROM agents").all()).toEqual([
      { name: "Tech-CIO", inbox_since: "2026-05-18T00:00:00.000Z" },
    ]);
  });

  it("leaves sequence and sender key of old messages unknown: they are never subtracted from a pending count", () => {
    const db = legacyDb();
    for (const file of NEW) db.exec(readFileSync(`migrations/${file}`, "utf-8"));
    expect(db.prepare("SELECT id, stream_seq, from_key FROM messages").all()).toEqual([{ id: "m1", stream_seq: null, from_key: null }]);
  });

  it("applies each file as a whole or not at all", () => {
    // The runner records a migration only after it ran. A file that stops
    // half way must not leave a column behind that makes the retry fail.
    for (const file of NEW) {
      const sql = readFileSync(`migrations/${file}`, "utf-8").replace(/--.*$/gm, "").trim();
      expect(sql.startsWith("BEGIN;"), file).toBe(true);
      expect(sql.endsWith("COMMIT;"), file).toBe(true);
    }
  });
});
