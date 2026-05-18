import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "fs";
import { ulid } from "ulidx";
import {
  getAgentHeat,
  getMeshEdges,
  getIncidents24h,
} from "../../src/services/dashboard-stats";

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  const files = readdirSync("migrations").filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) db.exec(readFileSync(`migrations/${f}`, "utf-8"));
  return db;
}

interface InsertMsg {
  from: string;
  to: string;
  type: string;
  createdAt: Date;
}

function insertMessage(db: Database.Database, args: InsertMsg): void {
  db.prepare(
    `INSERT INTO messages (id, from_agent, to_agent, type, payload, context,
      correlation_id, reply_to, priority, ttl_seconds, created_at)
     VALUES (?, ?, ?, ?, '{}', 'ctx', NULL, NULL, 'normal', 86400, ?)`,
  ).run(ulid(), args.from, args.to, args.type, args.createdAt.toISOString());
}

describe("getAgentHeat", () => {
  let db: Database.Database;
  const NOW = new Date("2026-04-27T20:00:00Z");

  beforeEach(() => { db = createTestDb(); });

  it("returns 24 zero buckets when there is no traffic", () => {
    const heat = getAgentHeat(db, "ghost", NOW);
    expect(heat).toHaveLength(24);
    expect(heat.every((v) => v === 0)).toBe(true);
  });

  it("buckets messages by hour with index 23 being the most recent", () => {
    insertMessage(db, { from: "alice", to: "bob", type: "info",
      createdAt: new Date(NOW.getTime() - 30 * 60 * 1000) });
    for (let i = 0; i < 2; i++) {
      insertMessage(db, { from: "alice", to: "bob", type: "info",
        createdAt: new Date(NOW.getTime() - 2.5 * 60 * 60 * 1000) });
    }
    const heat = getAgentHeat(db, "alice", NOW);
    expect(heat[23]).toBe(1);
    expect(heat[21]).toBe(2);
    expect(heat.reduce((s, v) => s + v, 0)).toBe(3);
  });

  it("counts both sender and receiver activity", () => {
    insertMessage(db, { from: "alice", to: "bob", type: "info",
      createdAt: new Date(NOW.getTime() - 60_000) });
    insertMessage(db, { from: "carol", to: "alice", type: "info",
      createdAt: new Date(NOW.getTime() - 60_000) });
    expect(getAgentHeat(db, "alice", NOW).reduce((s, v) => s + v, 0)).toBe(2);
  });

  it("ignores messages older than 24h", () => {
    insertMessage(db, { from: "alice", to: "bob", type: "info",
      createdAt: new Date(NOW.getTime() - 25 * 60 * 60 * 1000) });
    expect(getAgentHeat(db, "alice", NOW).reduce((s, v) => s + v, 0)).toBe(0);
  });

  it("matches case-insensitively", () => {
    insertMessage(db, { from: "Alice", to: "Bob", type: "info",
      createdAt: new Date(NOW.getTime() - 60_000) });
    expect(getAgentHeat(db, "alice", NOW).reduce((s, v) => s + v, 0)).toBe(1);
  });
});

describe("getMeshEdges", () => {
  let db: Database.Database;
  const NOW = new Date("2026-04-27T20:00:00Z");

  beforeEach(() => { db = createTestDb(); });

  it("returns empty when no messages exist", () => {
    expect(getMeshEdges(db, undefined, NOW)).toEqual([]);
  });

  it("groups by from/to pair with counts and last-seen", () => {
    const t0 = new Date(NOW.getTime() - 60_000);
    const t1 = new Date(NOW.getTime() - 30_000);
    insertMessage(db, { from: "alice", to: "bob", type: "info", createdAt: t0 });
    insertMessage(db, { from: "alice", to: "bob", type: "info", createdAt: t1 });
    insertMessage(db, { from: "alice", to: "carol", type: "info", createdAt: t0 });

    const edges = getMeshEdges(db, undefined, NOW);
    const ab = edges.find((e) => e.from === "alice" && e.to === "bob");
    const ac = edges.find((e) => e.from === "alice" && e.to === "carol");

    expect(ab?.count).toBe(2);
    expect(ab?.last).toBe(t1.toISOString());
    expect(ac?.count).toBe(1);
  });

  it("respects the time window", () => {
    insertMessage(db, { from: "alice", to: "bob", type: "info",
      createdAt: new Date(NOW.getTime() - 8 * 24 * 60 * 60 * 1000) });
    expect(getMeshEdges(db, 7 * 24 * 60 * 60 * 1000, NOW)).toEqual([]);
  });

  it("orders by count descending", () => {
    insertMessage(db, { from: "a", to: "b", type: "info",
      createdAt: new Date(NOW.getTime() - 1000) });
    for (let i = 0; i < 3; i++) {
      insertMessage(db, { from: "c", to: "d", type: "info",
        createdAt: new Date(NOW.getTime() - 1000) });
    }
    const edges = getMeshEdges(db, undefined, NOW);
    expect(edges[0]?.count).toBe(3);
    expect(edges[1]?.count).toBe(1);
  });
});

describe("getIncidents24h", () => {
  let db: Database.Database;
  const NOW = new Date("2026-04-27T20:00:00Z");

  beforeEach(() => { db = createTestDb(); });

  it("returns 0 with an empty database", () => {
    expect(getIncidents24h(db, NOW)).toBe(0);
  });

  it("counts alerts and incident_* types", () => {
    const recent = new Date(NOW.getTime() - 60_000);
    insertMessage(db, { from: "lk", to: "cortex", type: "alert", createdAt: recent });
    insertMessage(db, { from: "cortex", to: "ww0", type: "incident_acknowledged", createdAt: recent });
    insertMessage(db, { from: "cortex", to: "ww0", type: "incident_response", createdAt: recent });
    insertMessage(db, { from: "alice", to: "bob", type: "info", createdAt: recent });
    expect(getIncidents24h(db, NOW)).toBe(3);
  });

  it("excludes incidents older than 24h", () => {
    insertMessage(db, { from: "lk", to: "cortex", type: "alert",
      createdAt: new Date(NOW.getTime() - 25 * 60 * 60 * 1000) });
    expect(getIncidents24h(db, NOW)).toBe(0);
  });
});
