// Migration 0005 on a database that already has agents — the live case.
// Every existing agent must keep exactly the NATS address it has today,
// otherwise the deploy itself would strand unread mail.

import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "fs";

const MIGRATION = "0005_agent_inbox_key.sql";

function migrationsBefore(name: string): string[] {
  return readdirSync("migrations").filter((f) => f.endsWith(".sql") && f < name).sort();
}

function legacyDb(): Database.Database {
  const db = new Database(":memory:");
  for (const file of migrationsBefore(MIGRATION)) {
    db.exec(readFileSync(`migrations/${file}`, "utf-8"));
  }
  const insert = db.prepare(
    `INSERT INTO agents (id, name, token_hash, is_active, created_at, updated_at)
     VALUES (?, ?, ?, 1, '2026-05-18T00:00:00.000Z', '2026-05-18T00:00:00.000Z')`,
  );
  insert.run("a1", "Tech-CIO", "h1");
  insert.run("a2", "ccode", "h2");
  return db;
}

describe("migration 0005 — agent inbox key", () => {
  it("backfills every existing agent with its lower-cased name", () => {
    const db = legacyDb();
    db.exec(readFileSync(`migrations/${MIGRATION}`, "utf-8"));
    const rows = db.prepare("SELECT name, inbox_key FROM agents ORDER BY id").all();
    expect(rows).toEqual([
      { name: "Tech-CIO", inbox_key: "tech-cio" },
      { name: "ccode", inbox_key: "ccode" },
    ]);
  });

  it("dates every existing name from the agent's creation", () => {
    const db = legacyDb();
    db.exec(readFileSync(`migrations/${MIGRATION}`, "utf-8"));
    const rows = db.prepare("SELECT name_since, created_at FROM agents").all() as
      { name_since: string; created_at: string }[];
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.name_since).toBe(row.created_at);
  });

  it("makes the key unique, so two agents can never share an inbox", () => {
    const db = legacyDb();
    db.exec(readFileSync(`migrations/${MIGRATION}`, "utf-8"));
    expect(() =>
      db.prepare(
        `INSERT INTO agents (id, name, inbox_key, token_hash, is_active, created_at, updated_at)
         VALUES ('a3', 'other', 'ccode', 'h3', 1, 'x', 'x')`,
      ).run(),
    ).toThrow(/UNIQUE/);
  });

  it("is all-or-nothing: a failure leaves no half-applied column behind", () => {
    const db = legacyDb();
    // Two agents whose names differ only by case cannot exist (name is
    // UNIQUE NOCASE), so force the index to fail another way: pre-create a
    // conflicting object with the index's name.
    db.exec("CREATE TABLE idx_agents_inbox_key (x)");
    expect(() => db.exec(readFileSync(`migrations/${MIGRATION}`, "utf-8"))).toThrow();
    if (db.inTransaction) db.exec("ROLLBACK");
    const cols = db.prepare("PRAGMA table_info(agents)").all() as { name: string }[];
    expect(cols.map((c) => c.name)).not.toContain("inbox_key");
  });
});
