// Migration 0016: four new columns, and one backfill that may only fill the
// NEW target_key of rows about an agent that still exists.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import SqliteDatabase from "better-sqlite3";
import { migrationBody } from "../../src/services/db";
import { ActivityService } from "../../src/services/activity";

const FILE = "0016_activity_audit_fields.sql";

function beforeMigration() {
  const db = new SqliteDatabase(":memory:");
  for (const file of readdirSync("migrations").filter((f) => f.endsWith(".sql") && f < FILE).sort()) {
    db.exec(readFileSync(`migrations/${file}`, "utf-8"));
  }
  db.prepare(
    "INSERT INTO agents (id, name, inbox_key, token_hash, is_active, created_at, updated_at) VALUES ('A1', 'ranger', 'scout', 'h', 1, 't', 't')",
  ).run();
  const row = db.prepare(
    "INSERT INTO activity_log (id, action, entity_type, entity_id, summary, agent_name, created_at) VALUES (?, ?, ?, ?, 's', 'admin', '2026-01-01T00:00:00.000Z')",
  );
  row.run("kept", "agent_created", "agent", "A1");
  row.run("gone", "agent_created", "agent", "NO_SUCH_AGENT");
  row.run("hook", "webhook_set", "agent", "A1");
  row.run("mail", "message_sent", "message", "A1");
  return db;
}

describe("migration 0016", () => {
  it("is accepted by the runner's rules for a migration file", () => {
    expect(() => migrationBody(readFileSync(`migrations/${FILE}`, "utf-8"))).not.toThrow();
  });

  it("fills target_key by agent id and leaves everything else as written", () => {
    const db = beforeMigration();
    const columns = "id, action, entity_type, entity_id, summary, agent_name, created_at";
    const before = db.prepare(`SELECT ${columns} FROM activity_log ORDER BY id`).all();
    db.exec(readFileSync(`migrations/${FILE}`, "utf-8"));
    expect(db.prepare(`SELECT ${columns} FROM activity_log ORDER BY id`).all()).toEqual(before);

    const keyOf = (id: string) => (db.prepare("SELECT target_key FROM activity_log WHERE id = ?").get(id) as { target_key: string | null }).target_key;
    expect(keyOf("kept")).toBe("scout");
    expect(keyOf("gone")).toBeNull();
    expect(keyOf("hook")).toBeNull();
    expect(keyOf("mail")).toBeNull();
  });

  it("lets the filter find an old row by the agent's current name", () => {
    const db = beforeMigration();
    db.exec(readFileSync(`migrations/${FILE}`, "utf-8"));
    const found = new ActivityService(db).list({ agent_name: "ranger", limit: 10, offset: 0 });
    expect(found.data.map((r) => r.id)).toEqual(["kept"]);
  });

  it("indexes the target", () => {
    const db = beforeMigration();
    db.exec(readFileSync(`migrations/${FILE}`, "utf-8"));
    const plan = db.prepare("EXPLAIN QUERY PLAN SELECT 1 FROM activity_log WHERE target_key = 'scout'").all() as { detail: string }[];
    expect(plan.map((p) => p.detail).join(" ")).toContain("idx_activity_target");
  });
});

describe("ActivityService.log", () => {
  it("still takes a row without any of the new fields", () => {
    const db = beforeMigration();
    db.exec(readFileSync(`migrations/${FILE}`, "utf-8"));
    const row = new ActivityService(db).log({ action: "x", entity_type: "y", entity_id: "z" });
    expect(row).toMatchObject({ target_key: null, origin: null, detail_json: null });
  });
});
