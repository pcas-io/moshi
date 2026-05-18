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
