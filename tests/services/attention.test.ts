import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "fs";
import { ulid } from "ulidx";
import { buildAttentionItems } from "../../src/services/attention";
import type { HealthResult } from "../../src/services/health";

const NOW = new Date("2026-09-12T14:00:00Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  const files = readdirSync("migrations").filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) db.exec(readFileSync(`migrations/${f}`, "utf-8"));
  return db;
}

function insertAgent(
  db: Database.Database,
  args: { name: string; lastSeen?: Date | null; created?: Date; active?: boolean },
): void {
  const created = (args.created ?? new Date(NOW.getTime() - 30 * DAY)).toISOString();
  db.prepare(
    `INSERT INTO agents (id, name, token_hash, is_active, last_seen_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    ulid(), args.name, `hash-${args.name}`, args.active === false ? 0 : 1,
    args.lastSeen ? args.lastSeen.toISOString() : null, created, created,
  );
}

function insertMessage(
  db: Database.Database,
  args: {
    from: string; to: string; type: string; createdAt: Date;
    context?: string; payload?: string; correlationId?: string | null; id?: string;
  },
): string {
  const id = args.id ?? ulid();
  db.prepare(
    `INSERT INTO messages (id, from_agent, to_agent, type, payload, context,
      correlation_id, reply_to, priority, ttl_seconds, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'normal', 86400, ?)`,
  ).run(
    id, args.from, args.to, args.type, args.payload ?? "body",
    args.context ?? "ctx", args.correlationId ?? null, args.createdAt.toISOString(),
  );
  return id;
}

const HEALTHY: HealthResult = { status: "ok", nats: "connected", db: "ok", httpStatus: 200 };

describe("buildAttentionItems", () => {
  let db: Database.Database;
  beforeEach(() => { db = createTestDb(); });

  it("returns nothing when everything is fine", () => {
    insertAgent(db, { name: "scout", lastSeen: new Date(NOW.getTime() - HOUR) });
    expect(buildAttentionItems({ db, health: HEALTHY, now: NOW })).toEqual([]);
  });

  it("flags an active agent that has been silent for over a day", () => {
    insertAgent(db, { name: "scout", lastSeen: new Date(NOW.getTime() - 3 * DAY) });
    const items = buildAttentionItems({ db, health: HEALTHY, now: NOW });
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("stale_agent");
    expect(items[0]!.agent).toBe("scout");
    expect(items[0]!.text).toBe("hasn't checked in for 3 days");
  });

  it("says so plainly when the agent has never called in", () => {
    insertAgent(db, { name: "dex-eu", lastSeen: null });
    const items = buildAttentionItems({ db, health: HEALTHY, now: NOW });
    expect(items[0]!.text).toBe("has a token but has never called in");
  });

  it("ignores deactivated agents and freshly created ones", () => {
    insertAgent(db, { name: "gone", lastSeen: new Date(NOW.getTime() - 9 * DAY), active: false });
    insertAgent(db, { name: "brandnew", lastSeen: null, created: new Date(NOW.getTime() - HOUR) });
    expect(buildAttentionItems({ db, health: HEALTHY, now: NOW })).toEqual([]);
  });

  it("flags an incident nobody answered", () => {
    insertMessage(db, {
      from: "sec-warden", to: "broadcast", type: "incident",
      context: "2 agents still on pre-rotation tokens",
      createdAt: new Date(NOW.getTime() - 2 * HOUR),
    });
    const items = buildAttentionItems({ db, health: HEALTHY, now: NOW });
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("open_incident");
    expect(items[0]!.agent).toBe("sec-warden");
    expect(items[0]!.text).toBe("reports 2 agents still on pre-rotation tokens, still unanswered");
  });

  it("clears an incident once somebody else replies in its thread", () => {
    const id = insertMessage(db, {
      from: "sec-warden", to: "ops-kai", type: "incident",
      createdAt: new Date(NOW.getTime() - 2 * HOUR),
    });
    insertMessage(db, {
      from: "ops-kai", to: "sec-warden", type: "reply", correlationId: id,
      createdAt: new Date(NOW.getTime() - HOUR),
    });
    expect(buildAttentionItems({ db, health: HEALTHY, now: NOW })).toEqual([]);
  });

  it("does not count the reporter talking to itself as an answer", () => {
    const id = insertMessage(db, {
      from: "sec-warden", to: "ops-kai", type: "incident",
      createdAt: new Date(NOW.getTime() - 2 * HOUR),
    });
    insertMessage(db, {
      from: "sec-warden", to: "ops-kai", type: "info", correlationId: id,
      createdAt: new Date(NOW.getTime() - HOUR),
    });
    expect(buildAttentionItems({ db, health: HEALTHY, now: NOW })).toHaveLength(1);
  });

  it("ignores incidents older than 24h", () => {
    insertMessage(db, {
      from: "sec-warden", to: "ops-kai", type: "incident",
      createdAt: new Date(NOW.getTime() - 30 * HOUR),
    });
    expect(buildAttentionItems({ db, health: HEALTHY, now: NOW })).toEqual([]);
  });

  it("surfaces a degraded backend", () => {
    const items = buildAttentionItems({
      db, now: NOW,
      health: { status: "degraded", nats: "disconnected", db: "error", httpStatus: 503 },
    });
    expect(items.map((i) => i.kind)).toEqual(["backend", "backend"]);
    expect(items[0]!.text).toContain("NATS is not connected");
    expect(items[1]!.text).toContain("database is not responding");
  });

  it("keeps the handoff's source order: agents, then incidents, then backend", () => {
    insertAgent(db, { name: "scout", lastSeen: new Date(NOW.getTime() - 3 * DAY) });
    insertMessage(db, {
      from: "sec-warden", to: "broadcast", type: "alert",
      createdAt: new Date(NOW.getTime() - HOUR),
    });
    const items = buildAttentionItems({
      db, now: NOW,
      health: { status: "degraded", nats: "disconnected", db: "ok", httpStatus: 503 },
    });
    expect(items.map((i) => i.kind)).toEqual(["stale_agent", "open_incident", "backend"]);
  });

  it("truncates a long incident context instead of wrapping the band", () => {
    insertMessage(db, {
      from: "qa-bot", to: "broadcast", type: "incident",
      context: "x".repeat(200),
      createdAt: new Date(NOW.getTime() - HOUR),
    });
    const items = buildAttentionItems({ db, health: HEALTHY, now: NOW });
    expect(items[0]!.text.length).toBeLessThan(110);
    expect(items[0]!.text).toContain("…");
  });
});
