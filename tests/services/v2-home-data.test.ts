// The one piece of new SQL behind Home's lead sentence: which incident came
// in last, and who answered it. Everything else in v2-home-data.ts is a
// pass-through of functions tested next door.

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "fs";
import { ulid } from "ulidx";
import { getLatestIncident } from "../../src/services/v2-home-data";

const NOW = new Date("2026-09-12T14:00:00Z");
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  const files = readdirSync("migrations").filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) db.exec(readFileSync(`migrations/${f}`, "utf-8"));
  return db;
}

function insertMessage(
  db: Database.Database,
  args: {
    from: string; to: string; type: string; createdAt: Date;
    correlationId?: string | null; id?: string;
  },
): string {
  const id = args.id ?? ulid();
  db.prepare(
    `INSERT INTO messages (id, from_agent, to_agent, type, payload, context,
      correlation_id, reply_to, priority, ttl_seconds, created_at)
     VALUES (?, ?, ?, ?, 'body', 'ctx', ?, NULL, 'normal', 86400, ?)`,
  ).run(id, args.from, args.to, args.type, args.correlationId ?? null, args.createdAt.toISOString());
  return id;
}

describe("getLatestIncident", () => {
  let db: Database.Database;
  beforeEach(() => { db = createTestDb(); });

  it("returns null with no incidents in the window", () => {
    insertMessage(db, { from: "scout", to: "ops-kai", type: "info", createdAt: new Date(NOW.getTime() - HOUR) });
    insertMessage(db, { from: "scout", to: "ops-kai", type: "incident", createdAt: new Date(NOW.getTime() - 2 * DAY) });
    expect(getLatestIncident(db, NOW)).toBeNull();
  });

  it("names the first agent who answered and how long it took", () => {
    const opened = new Date(NOW.getTime() - 3 * HOUR);
    const id = insertMessage(db, { from: "triage-1", to: "ops-kai", type: "incident", createdAt: opened });
    insertMessage(db, {
      from: "ops-kai", to: "triage-1", type: "reply",
      createdAt: new Date(opened.getTime() + 12 * MINUTE), correlationId: id,
    });
    insertMessage(db, {
      from: "sec-warden", to: "triage-1", type: "reply",
      createdAt: new Date(opened.getTime() + 40 * MINUTE), correlationId: id,
    });

    expect(getLatestIncident(db, NOW)).toEqual({
      openedAt: opened.toISOString(),
      closedBy: "ops-kai",
      minutesToClose: 12,
    });
  });

  it("ignores the reporter talking to itself", () => {
    const opened = new Date(NOW.getTime() - HOUR);
    const id = insertMessage(db, { from: "triage-1", to: "ops-kai", type: "alert", createdAt: opened });
    insertMessage(db, {
      from: "triage-1", to: "ops-kai", type: "info",
      createdAt: new Date(opened.getTime() + 5 * MINUTE), correlationId: id,
    });

    expect(getLatestIncident(db, NOW)).toEqual({
      openedAt: opened.toISOString(),
      closedBy: null,
      minutesToClose: null,
    });
  });

  it("takes the newest incident when several came in", () => {
    insertMessage(db, { from: "scout", to: "ops-kai", type: "incident", createdAt: new Date(NOW.getTime() - 6 * HOUR) });
    const newest = new Date(NOW.getTime() - 30 * MINUTE);
    insertMessage(db, { from: "dex-eu", to: "ops-kai", type: "incident_acknowledged", createdAt: newest });

    expect(getLatestIncident(db, NOW)?.openedAt).toBe(newest.toISOString());
  });

  it("never reports a zero-minute close", () => {
    const opened = new Date(NOW.getTime() - HOUR);
    const id = insertMessage(db, { from: "triage-1", to: "ops-kai", type: "incident", createdAt: opened });
    insertMessage(db, {
      from: "ops-kai", to: "triage-1", type: "reply",
      createdAt: new Date(opened.getTime() + 4 * 1000), correlationId: id,
    });

    expect(getLatestIncident(db, NOW)?.minutesToClose).toBe(1);
  });
});
