// ActivityService read-side queries.
//
// These exist because the Log screen used to compute its entity counts and
// its time filter in the view, over the 50 rows of the current page: the
// counts were counts-within-a-page and the time filter silently moved the
// page boundary. Both now belong to SQL, so `total`, `has_more` and the
// "Busiest today" aside describe the whole table.

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "fs";
import { ulid } from "ulidx";
import {
  ACTIVITY_RANGES,
  ActivityService,
  OPERATOR_ACTOR,
  isOperatorActor,
  parseActivityRange,
  startOfDayIso,
} from "../../src/services/activity";

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  const files = readdirSync("migrations").filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) db.exec(readFileSync(`migrations/${f}`, "utf-8"));
  return db;
}

interface InsertEvent {
  action?: string;
  entity_type?: string;
  /** `null` is the operator writing without a name; omit for "scout". */
  agent_name?: string | null;
  summary?: string | null;
  createdAt: Date;
}

function insertEvent(db: Database.Database, e: InsertEvent): void {
  db.prepare(
    `INSERT INTO activity_log (id, action, entity_type, entity_id, summary, agent_name, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    ulid(),
    e.action ?? "message_sent",
    e.entity_type ?? "message",
    ulid(),
    e.summary ?? null,
    e.agent_name === undefined ? "scout" : e.agent_name,
    e.createdAt.toISOString(),
  );
}

const NOW = new Date("2026-09-12T14:00:00Z");
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

function ago(ms: number): Date {
  return new Date(NOW.getTime() - ms);
}

describe("ActivityService.list — entity filter", () => {
  let db: Database.Database;
  let activity: ActivityService;

  beforeEach(() => {
    db = createTestDb();
    activity = new ActivityService(db);
  });

  it("returns everything when no entity is given", () => {
    insertEvent(db, { entity_type: "message", createdAt: ago(MINUTE) });
    insertEvent(db, { entity_type: "agent", createdAt: ago(2 * MINUTE) });
    const page = activity.list({ limit: 50, offset: 0 });
    expect(page.total).toBe(2);
    expect(page.data).toHaveLength(2);
  });

  it("filters rows by entity_type", () => {
    insertEvent(db, { entity_type: "message", createdAt: ago(MINUTE) });
    insertEvent(db, { entity_type: "session", createdAt: ago(2 * MINUTE) });
    insertEvent(db, { entity_type: "agent", createdAt: ago(3 * MINUTE) });
    const page = activity.list({ limit: 50, offset: 0, entity_type: "agent" });
    expect(page.data.map((a) => a.entity_type)).toEqual(["agent"]);
  });

  // The bug this query replaces: 65 rows, one page of 50, and the view
  // counting the 3 agent events it happened to see instead of all 5.
  it("counts the whole table, not the current page", () => {
    for (let i = 0; i < 60; i++) insertEvent(db, { entity_type: "message", createdAt: ago(i * MINUTE) });
    for (let i = 0; i < 5; i++) {
      insertEvent(db, { entity_type: "agent", action: "agent_created", createdAt: ago((100 + i) * MINUTE) });
    }
    const page = activity.list({ limit: 50, offset: 0, entity_type: "agent" });
    expect(page.total).toBe(5);
    expect(page.data).toHaveLength(5);
    expect(page.has_more).toBe(false);
  });

  it("paginates within the filter", () => {
    for (let i = 0; i < 7; i++) insertEvent(db, { entity_type: "agent", createdAt: ago(i * MINUTE) });
    for (let i = 0; i < 3; i++) insertEvent(db, { entity_type: "message", createdAt: ago(i * MINUTE) });
    const first = activity.list({ limit: 5, offset: 0, entity_type: "agent" });
    expect(first.total).toBe(7);
    expect(first.data).toHaveLength(5);
    expect(first.has_more).toBe(true);
    const second = activity.list({ limit: 5, offset: 5, entity_type: "agent" });
    expect(second.data).toHaveLength(2);
    expect(second.has_more).toBe(false);
  });

  it("keeps the agent_name filter working alongside it", () => {
    insertEvent(db, { agent_name: "scout", entity_type: "message", createdAt: ago(MINUTE) });
    insertEvent(db, { agent_name: "ops-kai", entity_type: "message", createdAt: ago(2 * MINUTE) });
    const page = activity.list({ limit: 50, offset: 0, agent_name: "ops-kai", entity_type: "message" });
    expect(page.total).toBe(1);
    expect(page.data[0]?.agent_name).toBe("ops-kai");
  });
});

describe("ActivityService.list — time range", () => {
  let db: Database.Database;
  let activity: ActivityService;

  beforeEach(() => {
    db = createTestDb();
    activity = new ActivityService(db);
    insertEvent(db, { summary: "five minutes", createdAt: ago(5 * MINUTE) });
    insertEvent(db, { summary: "forty minutes", createdAt: ago(40 * MINUTE) });
    insertEvent(db, { summary: "six hours", createdAt: ago(6 * HOUR) });
    insertEvent(db, { summary: "three days", createdAt: ago(72 * HOUR) });
  });

  it("bounds the window at 15 minutes", () => {
    const page = activity.list({ limit: 50, offset: 0, range: "15m", now: NOW.getTime() });
    expect(page.total).toBe(1);
    expect(page.data.map((a) => a.summary)).toEqual(["five minutes"]);
  });

  it("bounds the window at one hour", () => {
    const page = activity.list({ limit: 50, offset: 0, range: "1h", now: NOW.getTime() });
    expect(page.total).toBe(2);
  });

  it("bounds the window at 24 hours", () => {
    const page = activity.list({ limit: 50, offset: 0, range: "24h", now: NOW.getTime() });
    expect(page.total).toBe(3);
  });

  it('treats "all" and an absent range as unbounded', () => {
    expect(activity.list({ limit: 50, offset: 0, range: "all", now: NOW.getTime() }).total).toBe(4);
    expect(activity.list({ limit: 50, offset: 0, now: NOW.getTime() }).total).toBe(4);
  });

  it("accepts an absolute lower bound", () => {
    const page = activity.list({ limit: 50, offset: 0, since: ago(2 * HOUR).toISOString() });
    expect(page.total).toBe(2);
  });

  it("combines the range with the entity filter", () => {
    insertEvent(db, { entity_type: "agent", createdAt: ago(3 * MINUTE) });
    insertEvent(db, { entity_type: "agent", createdAt: ago(30 * HOUR) });
    const page = activity.list({
      limit: 50, offset: 0, entity_type: "agent", range: "24h", now: NOW.getTime(),
    });
    expect(page.total).toBe(1);
  });
});

describe("ActivityService.list — free text", () => {
  let db: Database.Database;
  let activity: ActivityService;

  beforeEach(() => {
    db = createTestDb();
    activity = new ActivityService(db);
  });

  // The Log screen keeps one search box above both tabs. Without this the
  // box would be inert on the audit tab — the exact dead control the
  // redesign removed everywhere else.
  it("matches the summary", () => {
    insertEvent(db, { summary: "ops-kai reported the nginx 502 spike", createdAt: ago(MINUTE) });
    insertEvent(db, { summary: "ops-kai told triage-1 the redeploy finished", createdAt: ago(2 * MINUTE) });
    const page = activity.list({ limit: 50, offset: 0, q: "nginx" });
    expect(page.total).toBe(1);
    expect(page.data[0]?.summary).toContain("nginx");
  });

  it("matches the action and the actor", () => {
    insertEvent(db, { action: "agent_revoked", agent_name: "admin", createdAt: ago(MINUTE) });
    insertEvent(db, { action: "message_sent", agent_name: "scout", createdAt: ago(2 * MINUTE) });
    expect(activity.list({ limit: 50, offset: 0, q: "revoked" }).total).toBe(1);
    expect(activity.list({ limit: 50, offset: 0, q: "scout" }).total).toBe(1);
  });

  it("finds the audit row for a pasted message id", () => {
    const id = ulid();
    db.prepare(
      `INSERT INTO activity_log (id, action, entity_type, entity_id, summary, agent_name, created_at)
       VALUES (?, 'message_sent', 'message', ?, NULL, 'scout', ?)`,
    ).run(ulid(), id, ago(MINUTE).toISOString());
    insertEvent(db, { createdAt: ago(2 * MINUTE) });
    const page = activity.list({ limit: 50, offset: 0, q: id });
    expect(page.total).toBe(1);
    expect(page.data[0]?.entity_id).toBe(id);
  });

  it("treats LIKE metacharacters as literal text", () => {
    insertEvent(db, { summary: "100% done", createdAt: ago(MINUTE) });
    insertEvent(db, { summary: "nothing to see", createdAt: ago(2 * MINUTE) });
    expect(activity.list({ limit: 50, offset: 0, q: "%" }).total).toBe(1);
  });

  it("ignores a whitespace-only search", () => {
    insertEvent(db, { createdAt: ago(MINUTE) });
    expect(activity.list({ limit: 50, offset: 0, q: "   " }).total).toBe(1);
  });

  it("narrows topActors the same way", () => {
    insertEvent(db, { agent_name: "scout", summary: "scout reported the nginx 502 spike", createdAt: ago(MINUTE) });
    insertEvent(db, { agent_name: "ops-kai", summary: "ops-kai shipped the redeploy", createdAt: ago(MINUTE) });
    expect(activity.topActors({ limit: 5, q: "nginx" })).toEqual([{ agent_name: "scout", count: 1 }]);
  });
});

describe("ActivityService.topActors", () => {
  let db: Database.Database;
  let activity: ActivityService;

  beforeEach(() => {
    db = createTestDb();
    activity = new ActivityService(db);
  });

  it("returns nothing when there are no events", () => {
    expect(activity.topActors({ limit: 5 })).toEqual([]);
  });

  // The aside used to rank whoever appeared in the 50 rows on screen.
  it("ranks over the whole table, not one page", () => {
    for (let i = 0; i < 60; i++) insertEvent(db, { agent_name: "noisy", createdAt: ago(i * MINUTE) });
    for (let i = 0; i < 3; i++) insertEvent(db, { agent_name: "quiet", createdAt: ago(i * MINUTE) });
    expect(activity.topActors({ limit: 5 })).toEqual([
      { agent_name: "noisy", count: 60 },
      { agent_name: "quiet", count: 3 },
    ]);
  });

  it("merges a null agent_name into the operator row", () => {
    insertEvent(db, { agent_name: null, createdAt: ago(MINUTE) });
    insertEvent(db, { agent_name: OPERATOR_ACTOR, createdAt: ago(2 * MINUTE) });
    expect(activity.topActors({ limit: 5 })).toEqual([{ agent_name: OPERATOR_ACTOR, count: 2 }]);
  });

  it("orders by count descending and caps at the limit", () => {
    const plan: ReadonlyArray<readonly [string, number]> = [
      ["a", 1], ["b", 2], ["c", 3], ["d", 4], ["e", 5], ["f", 6],
    ];
    for (const [name, n] of plan) {
      for (let i = 0; i < n; i++) insertEvent(db, { agent_name: name, createdAt: ago(i * MINUTE) });
    }
    const top = activity.topActors({ limit: 3 });
    expect(top.map((t) => t.agent_name)).toEqual(["f", "e", "d"]);
    expect(top.map((t) => t.count)).toEqual([6, 5, 4]);
  });

  it("honours an absolute lower bound — this is what makes it 'today'", () => {
    insertEvent(db, { agent_name: "today-agent", createdAt: ago(MINUTE) });
    for (let i = 0; i < 9; i++) insertEvent(db, { agent_name: "yesterday-agent", createdAt: ago(30 * HOUR) });
    const top = activity.topActors({ limit: 5, since: ago(6 * HOUR).toISOString() });
    expect(top).toEqual([{ agent_name: "today-agent", count: 1 }]);
  });

  it("honours the range and entity filters", () => {
    insertEvent(db, { agent_name: "scout", entity_type: "agent", createdAt: ago(MINUTE) });
    insertEvent(db, { agent_name: "scout", entity_type: "message", createdAt: ago(MINUTE) });
    insertEvent(db, { agent_name: "scout", entity_type: "agent", createdAt: ago(30 * HOUR) });
    expect(activity.topActors({ limit: 5, entity_type: "agent" })).toEqual([
      { agent_name: "scout", count: 2 },
    ]);
    expect(
      activity.topActors({ limit: 5, entity_type: "agent", range: "24h", now: NOW.getTime() }),
    ).toEqual([{ agent_name: "scout", count: 1 }]);
  });
});

describe("range helpers", () => {
  it("parses only the four known range keys", () => {
    for (const key of ACTIVITY_RANGES) expect(parseActivityRange(key)).toBe(key);
    expect(parseActivityRange("7d")).toBeUndefined();
    expect(parseActivityRange("")).toBeUndefined();
    expect(parseActivityRange(undefined)).toBeUndefined();
  });

  it("startOfDayIso returns local midnight of the given instant", () => {
    const midnight = new Date(startOfDayIso(NOW.getTime()));
    expect(midnight.getHours()).toBe(0);
    expect(midnight.getMinutes()).toBe(0);
    expect(midnight.getSeconds()).toBe(0);
    expect(midnight.getTime()).toBeLessThanOrEqual(NOW.getTime());
    expect(NOW.getTime() - midnight.getTime()).toBeLessThan(24 * HOUR);
  });

  it("treats a null or admin agent_name as the operator", () => {
    expect(isOperatorActor(null)).toBe(true);
    expect(isOperatorActor(undefined)).toBe(true);
    expect(isOperatorActor(OPERATOR_ACTOR)).toBe(true);
    expect(isOperatorActor("scout")).toBe(false);
  });
});
