import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { initDatabase } from "../../src/services/db";
import { createMessage, persistMessage } from "../../src/services/message";
import {
  listMessages,
  listConversations,
} from "../../src/services/message-queries";

function createTestDb(): Database.Database {
  return initDatabase(":memory:");
}

function seed(db: Database.Database, n: number, opts?: { from?: string; to?: string; correlation_id?: string }) {
  const msgs = [];
  for (let i = 0; i < n; i++) {
    const m = createMessage({
      from: opts?.from ?? "alpha",
      to: opts?.to ?? "beta",
      type: "info",
      payload: `p${i}`,
      context: "test",
      correlation_id: opts?.correlation_id,
    });
    persistMessage(db, m);
    msgs.push(m);
  }
  return msgs;
}

describe("listMessages", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it("returns empty result on empty table", () => {
    const result = listMessages(db, { limit: 10, offset: 0 });
    expect(result.data).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.has_more).toBe(false);
    expect(result.limit).toBe(10);
    expect(result.offset).toBe(0);
  });

  it("returns messages ordered by created_at DESC with total", () => {
    seed(db, 3);
    const result = listMessages(db, { limit: 10, offset: 0 });
    expect(result.data).toHaveLength(3);
    expect(result.total).toBe(3);
    expect(result.has_more).toBe(false);
    // Newest first
    expect(result.data[0].created_at >= result.data[1].created_at).toBe(true);
    expect(result.data[1].created_at >= result.data[2].created_at).toBe(true);
  });

  it("maps db row columns to Message shape (from_agent -> from)", () => {
    seed(db, 1);
    const result = listMessages(db, { limit: 10, offset: 0 });
    expect(result.data[0].from).toBe("alpha");
    expect(result.data[0].to).toBe("beta");
    expect(result.data[0]).not.toHaveProperty("from_agent");
  });

  it("paginates with limit + offset and reports has_more correctly", () => {
    seed(db, 5);
    const page1 = listMessages(db, { limit: 2, offset: 0 });
    expect(page1.data).toHaveLength(2);
    expect(page1.total).toBe(5);
    expect(page1.has_more).toBe(true);

    const page3 = listMessages(db, { limit: 2, offset: 4 });
    expect(page3.data).toHaveLength(1);
    expect(page3.has_more).toBe(false);
  });

  it("filters by agent case-insensitively (both from and to)", () => {
    seed(db, 2, { from: "Alpha", to: "Beta" });
    seed(db, 3, { from: "gamma", to: "delta" });

    const resultA = listMessages(db, { limit: 10, offset: 0, agent: "alpha" });
    expect(resultA.total).toBe(2);
    expect(resultA.data.every((m) => m.from === "Alpha" || m.to === "Alpha")).toBe(true);

    const resultGamma = listMessages(db, { limit: 10, offset: 0, agent: "DELTA" });
    expect(resultGamma.total).toBe(3);
  });
});

describe("listConversations", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it("returns empty result on empty table", () => {
    const result = listConversations(db, { limit: 10, offset: 0 });
    expect(result.data).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.has_more).toBe(false);
  });

  it("groups messages into a single thread by correlation_id", () => {
    // 3 messages in same thread (one root + 2 replies sharing correlation_id)
    const root = createMessage({
      from: "alpha",
      to: "beta",
      type: "question",
      payload: "root",
      context: "t",
    });
    persistMessage(db, root);
    const reply1 = createMessage({
      from: "beta",
      to: "alpha",
      type: "reply",
      payload: "r1",
      context: "t",
      correlation_id: root.id,
    });
    persistMessage(db, reply1);
    const reply2 = createMessage({
      from: "gamma",
      to: "alpha",
      type: "reply",
      payload: "r2",
      context: "t",
      correlation_id: root.id,
    });
    persistMessage(db, reply2);

    const result = listConversations(db, { limit: 10, offset: 0 });
    expect(result.data).toHaveLength(1);
    expect(result.total).toBe(1);
    const thread = result.data[0];
    expect(thread.thread_id).toBe(root.id);
    expect(thread.message_count).toBe(3);
    expect(thread.messages).toHaveLength(3);
    // Participants include all three agents
    expect(new Set(thread.participants)).toEqual(new Set(["alpha", "beta", "gamma"]));
    // first_payload is from the oldest message in the thread
    expect(thread.first_payload).toBe("root");
  });

  it("treats messages without correlation_id as separate single-message threads", () => {
    seed(db, 3); // 3 messages, each its own thread
    const result = listConversations(db, { limit: 10, offset: 0 });
    expect(result.data).toHaveLength(3);
    expect(result.total).toBe(3);
    for (const t of result.data) {
      expect(t.message_count).toBe(1);
    }
  });

  it("orders threads by last_activity DESC and paginates", () => {
    // Thread A: 1 message
    const a = createMessage({ from: "alpha", to: "beta", type: "info", payload: "a", context: "t" });
    persistMessage(db, a);
    // Thread B: 1 message (newer)
    const b = createMessage({ from: "alpha", to: "beta", type: "info", payload: "b", context: "t" });
    // Force b.created_at to be strictly later
    b.created_at = new Date(Date.now() + 1000).toISOString();
    persistMessage(db, b);

    const result = listConversations(db, { limit: 10, offset: 0 });
    expect(result.data).toHaveLength(2);
    // Thread B (newer) comes first
    expect(result.data[0].thread_id).toBe(b.id);
    expect(result.data[1].thread_id).toBe(a.id);
  });

  it("has_more is true when more threads exist than the page", () => {
    for (let i = 0; i < 4; i++) {
      const m = createMessage({ from: "alpha", to: "beta", type: "info", payload: `p${i}`, context: "t" });
      persistMessage(db, m);
    }
    const result = listConversations(db, { limit: 2, offset: 0 });
    expect(result.data).toHaveLength(2);
    expect(result.total).toBe(4);
    expect(result.has_more).toBe(true);
  });
});

describe("listMessages — SQL-side filters (C2)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  function put(fields: Partial<Parameters<typeof createMessage>[0]>) {
    const m = createMessage({
      from: "alpha", to: "beta", type: "info", payload: "plain", context: "ctx",
      ...fields,
    });
    persistMessage(db, m);
    return m;
  }

  it("matches payload and context case-insensitively across all pages", () => {
    put({ payload: "Deploy FAILED on kai" });
    put({ context: "working on the deploy pipeline" });
    for (let i = 0; i < 60; i++) put({ payload: `noise ${i}` });
    const res = listMessages(db, { limit: 50, offset: 0, q: "deploy" });
    expect(res.total).toBe(2);
    expect(res.data.map((m) => m.payload).sort()).toEqual(["Deploy FAILED on kai", "plain"]);
  });

  it("matches message id and thread id exactly", () => {
    const root = put({ payload: "root" });
    const reply = put({ payload: "reply", correlation_id: root.id });
    expect(listMessages(db, { limit: 50, offset: 0, q: reply.id }).data.map((m) => m.id)).toEqual([reply.id]);
    const byThread = listMessages(db, { limit: 50, offset: 0, q: root.id });
    expect(byThread.data.map((m) => m.id).sort()).toEqual([root.id, reply.id].sort());
  });

  it("treats LIKE wildcards in the query literally", () => {
    put({ payload: "100% done" });
    put({ payload: "100 percent done" });
    expect(listMessages(db, { limit: 50, offset: 0, q: "100%" }).total).toBe(1);
    put({ payload: "a_b" });
    put({ payload: "axb" });
    expect(listMessages(db, { limit: 50, offset: 0, q: "a_b" }).total).toBe(1);
  });

  it("filters routing in SQL and combines it with agent + query", () => {
    put({ to: "broadcast", payload: "maintenance tonight" });
    put({ to: "beta", payload: "maintenance tonight" });
    put({ from: "gamma", to: "broadcast", payload: "maintenance tonight" });
    expect(listMessages(db, { limit: 50, offset: 0, routing: "broadcast" }).total).toBe(2);
    expect(listMessages(db, { limit: 50, offset: 0, routing: "direct" }).total).toBe(1);
    const combined = listMessages(db, { limit: 50, offset: 0, routing: "broadcast", agent: "ALPHA", q: "tonight" });
    expect(combined.total).toBe(1);
    expect(combined.data[0].from).toBe("alpha");
  });

  it("ignores a whitespace-only query", () => {
    put({});
    expect(listMessages(db, { limit: 50, offset: 0, q: "   " }).total).toBe(1);
  });
});

describe("listConversations — search and agent filter (C2, C3)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it("returns whole threads when any message matches the query", () => {
    const root = createMessage({ from: "alpha", to: "beta", type: "question", payload: "where is the runbook?", context: "ctx" });
    persistMessage(db, root);
    const reply = createMessage({ from: "beta", to: "alpha", type: "reply", payload: "in plexus", context: "ctx", correlation_id: root.id });
    persistMessage(db, reply);
    seed(db, 3, { from: "gamma", to: "delta" });

    const res = listConversations(db, { limit: 50, offset: 0, q: "plexus" });
    expect(res.total).toBe(1);
    expect(res.data[0].thread_id).toBe(root.id);
    expect(res.data[0].messages).toHaveLength(2);
  });

  it("filters threads by participant case-insensitively", () => {
    seed(db, 2, { from: "alpha", to: "beta" });
    seed(db, 1, { from: "gamma", to: "delta" });
    const res = listConversations(db, { limit: 50, offset: 0, agent: "Beta" });
    expect(res.total).toBe(2);
    expect(res.data.every((t) => t.participants.includes("beta"))).toBe(true);
    expect(listConversations(db, { limit: 50, offset: 0, agent: "nobody" }).total).toBe(0);
  });

  it("paginates the filtered set and keeps totals consistent", () => {
    seed(db, 5, { from: "alpha", to: "beta" });
    seed(db, 5, { from: "gamma", to: "delta" });
    const page1 = listConversations(db, { limit: 3, offset: 0, agent: "alpha" });
    expect(page1.total).toBe(5);
    expect(page1.data).toHaveLength(3);
    expect(page1.has_more).toBe(true);
    const page2 = listConversations(db, { limit: 3, offset: 3, agent: "alpha" });
    expect(page2.data).toHaveLength(2);
    expect(page2.has_more).toBe(false);
  });
});
