import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { initDatabase } from "../../src/services/db";
import { createMessage, persistMessage } from "../../src/services/message";
import {
  listMessageItems,
  listConversationSummaries,
  getThread,
  resolveThreadRoot,
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

describe("listMessageItems", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it("returns empty result on empty table", () => {
    const result = listMessageItems(db, { limit: 10, offset: 0 });
    expect(result.data).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.has_more).toBe(false);
    expect(result.limit).toBe(10);
    expect(result.offset).toBe(0);
  });

  it("returns messages ordered by created_at DESC with total", () => {
    seed(db, 3);
    const result = listMessageItems(db, { limit: 10, offset: 0 });
    expect(result.data).toHaveLength(3);
    expect(result.total).toBe(3);
    expect(result.has_more).toBe(false);
    // Newest first
    expect(result.data[0].created_at >= result.data[1].created_at).toBe(true);
    expect(result.data[1].created_at >= result.data[2].created_at).toBe(true);
  });

  it("maps db row columns to Message shape (from_agent -> from)", () => {
    seed(db, 1);
    const result = listMessageItems(db, { limit: 10, offset: 0 });
    expect(result.data[0].from).toBe("alpha");
    expect(result.data[0].to).toBe("beta");
    expect(result.data[0]).not.toHaveProperty("from_agent");
  });

  it("paginates with limit + offset and reports has_more correctly", () => {
    seed(db, 5);
    const page1 = listMessageItems(db, { limit: 2, offset: 0 });
    expect(page1.data).toHaveLength(2);
    expect(page1.total).toBe(5);
    expect(page1.has_more).toBe(true);

    const page3 = listMessageItems(db, { limit: 2, offset: 4 });
    expect(page3.data).toHaveLength(1);
    expect(page3.has_more).toBe(false);
  });

  it("filters by agent case-insensitively (both from and to)", () => {
    seed(db, 2, { from: "Alpha", to: "Beta" });
    seed(db, 3, { from: "gamma", to: "delta" });

    const resultA = listMessageItems(db, { limit: 10, offset: 0, agent: "alpha" });
    expect(resultA.total).toBe(2);
    expect(resultA.data.every((m) => m.from === "Alpha" || m.to === "Alpha")).toBe(true);

    const resultGamma = listMessageItems(db, { limit: 10, offset: 0, agent: "DELTA" });
    expect(resultGamma.total).toBe(3);
  });
});

describe("listConversationSummaries", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it("returns empty result on empty table", () => {
    const result = listConversationSummaries(db, { limit: 10, offset: 0 });
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

    const result = listConversationSummaries(db, { limit: 10, offset: 0 });
    expect(result.data).toHaveLength(1);
    expect(result.total).toBe(1);
    const thread = result.data[0];
    expect(thread.thread_id).toBe(root.id);
    expect(thread.message_count).toBe(3);
    // A summary carries no bodies: the list page used to load every payload
    // of up to 50 threads on each request.
    expect(thread).not.toHaveProperty("messages");
    expect(getThread(db, root.id)!.messages.map((m) => m.payload)).toEqual(["root", "r1", "r2"]);
    // Participants include all three agents
    expect(new Set(thread.participants)).toEqual(new Set(["alpha", "beta", "gamma"]));
    // first_payload is from the oldest message in the thread
    expect(thread.first_payload).toBe("root");
  });

  it("treats messages without correlation_id as separate single-message threads", () => {
    seed(db, 3); // 3 messages, each its own thread
    const result = listConversationSummaries(db, { limit: 10, offset: 0 });
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

    const result = listConversationSummaries(db, { limit: 10, offset: 0 });
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
    const result = listConversationSummaries(db, { limit: 2, offset: 0 });
    expect(result.data).toHaveLength(2);
    expect(result.total).toBe(4);
    expect(result.has_more).toBe(true);
  });
});

describe("listMessageItems — SQL-side filters (C2)", () => {
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
    const byPayload = put({ payload: "Deploy FAILED on kai" });
    const byContext = put({ context: "working on the deploy pipeline" });
    for (let i = 0; i < 60; i++) put({ payload: `noise ${i}` });
    const res = listMessageItems(db, { limit: 50, offset: 0, q: "deploy" });
    expect(res.total).toBe(2);
    // Found through the payload, although the listing does not carry it.
    expect(res.data.map((m) => m.id).sort()).toEqual([byPayload.id, byContext.id].sort());
  });

  it("matches message id and thread id exactly", () => {
    const root = put({ payload: "root" });
    const reply = put({ payload: "reply", correlation_id: root.id });
    expect(listMessageItems(db, { limit: 50, offset: 0, q: reply.id }).data.map((m) => m.id)).toEqual([reply.id]);
    const byThread = listMessageItems(db, { limit: 50, offset: 0, q: root.id });
    expect(byThread.data.map((m) => m.id).sort()).toEqual([root.id, reply.id].sort());
  });

  it("treats LIKE wildcards in the query literally", () => {
    put({ payload: "100% done" });
    put({ payload: "100 percent done" });
    expect(listMessageItems(db, { limit: 50, offset: 0, q: "100%" }).total).toBe(1);
    put({ payload: "a_b" });
    put({ payload: "axb" });
    expect(listMessageItems(db, { limit: 50, offset: 0, q: "a_b" }).total).toBe(1);
  });

  it("filters routing in SQL and combines it with agent + query", () => {
    put({ to: "broadcast", payload: "maintenance tonight" });
    put({ to: "beta", payload: "maintenance tonight" });
    put({ from: "gamma", to: "broadcast", payload: "maintenance tonight" });
    expect(listMessageItems(db, { limit: 50, offset: 0, routing: "broadcast" }).total).toBe(2);
    expect(listMessageItems(db, { limit: 50, offset: 0, routing: "direct" }).total).toBe(1);
    const combined = listMessageItems(db, { limit: 50, offset: 0, routing: "broadcast", agent: "ALPHA", q: "tonight" });
    expect(combined.total).toBe(1);
    expect(combined.data[0].from).toBe("alpha");
  });

  it("ignores a whitespace-only query", () => {
    put({});
    expect(listMessageItems(db, { limit: 50, offset: 0, q: "   " }).total).toBe(1);
  });
});

describe("listConversationSummaries — search and agent filter (C2, C3)", () => {
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

    const res = listConversationSummaries(db, { limit: 50, offset: 0, q: "plexus" });
    expect(res.total).toBe(1);
    expect(res.data[0].thread_id).toBe(root.id);
    expect(res.data[0].message_count).toBe(2);
  });

  it("filters threads by participant case-insensitively", () => {
    seed(db, 2, { from: "alpha", to: "beta" });
    seed(db, 1, { from: "gamma", to: "delta" });
    const res = listConversationSummaries(db, { limit: 50, offset: 0, agent: "Beta" });
    expect(res.total).toBe(2);
    expect(res.data.every((t) => t.participants.includes("beta"))).toBe(true);
    expect(listConversationSummaries(db, { limit: 50, offset: 0, agent: "nobody" }).total).toBe(0);
  });

  it("paginates the filtered set and keeps totals consistent", () => {
    seed(db, 5, { from: "alpha", to: "beta" });
    seed(db, 5, { from: "gamma", to: "delta" });
    const page1 = listConversationSummaries(db, { limit: 3, offset: 0, agent: "alpha" });
    expect(page1.total).toBe(5);
    expect(page1.data).toHaveLength(3);
    expect(page1.has_more).toBe(true);
    const page2 = listConversationSummaries(db, { limit: 3, offset: 3, agent: "alpha" });
    expect(page2.data).toHaveLength(2);
    expect(page2.has_more).toBe(false);
  });
});


// ── Query split for the live dashboard ────────────────────────────
// The list refreshes every few seconds. It must not load bodies it never
// shows, and list and open thread must agree on who the parties are.

function at(db: Database.Database, offsetMs: number, params: Parameters<typeof createMessage>[0]) {
  const m = createMessage(params);
  m.created_at = new Date(Date.parse("2026-09-19T10:00:00.000Z") + offsetMs).toISOString();
  persistMessage(db, m);
  return m;
}

describe("listConversationSummaries — what a row needs, and no more", () => {
  let db: Database.Database;
  beforeEach(() => { db = createTestDb(); });

  it("keeps the first payload whole, so a JSON payload still parses in the preview", () => {
    const big = JSON.stringify({ text: "x".repeat(10_000) });
    const root = at(db, 0, { from: "alpha", to: "beta", type: "info", payload: big, context: "first context" });
    at(db, 1000, { from: "beta", to: "alpha", type: "reply", payload: "later", context: "second context", correlation_id: root.id });
    const [row] = listConversationSummaries(db, { limit: 10, offset: 0 }).data;
    expect(row!.first_payload).toBe(big);
    expect(row!.first_context).toBe("first context");
    expect(row!.started_at).toBe("2026-09-19T10:00:00.000Z");
    expect(row!.last_activity).toBe("2026-09-19T10:00:01.000Z");
  });

  it("orders the parties by time, not by insertion: first sender, first recipient, then whoever joins", () => {
    // Inserted out of order on purpose. The title and the bubble side both
    // depend on participants[0] and [1].
    const rootId = "msg_ROOT";
    const reply = createMessage({ from: "gamma", to: "alpha", type: "reply", payload: "r", context: "t", correlation_id: rootId });
    reply.created_at = "2026-09-19T10:00:05.000Z";
    persistMessage(db, reply);
    const root = createMessage({ from: "alpha", to: "beta", type: "question", payload: "q", context: "t" });
    root.id = rootId;
    root.created_at = "2026-09-19T10:00:00.000Z";
    persistMessage(db, root);

    const [row] = listConversationSummaries(db, { limit: 10, offset: 0 }).data;
    expect(row!.participants).toEqual(["alpha", "beta", "gamma"]);
    expect(row!.first_payload).toBe("q");
    // The open thread must tell the same story as its row.
    expect(getThread(db, rootId)!.participants).toEqual(row!.participants);
  });

  it("breaks a tie on created_at by insertion, the same way in the list and in the thread", () => {
    // Same millisecond, and ids that sort the other way round: a ULID of the
    // same millisecond says nothing about order, the write order does.
    const a = createMessage({ from: "alpha", to: "beta", type: "info", payload: "a", context: "t" });
    const b = createMessage({ from: "beta", to: "alpha", type: "reply", payload: "b", context: "t", correlation_id: "msg_Z_ROOT" });
    a.id = "msg_Z_ROOT"; b.id = "msg_A_REPLY";
    a.created_at = b.created_at = "2026-09-19T10:00:00.000Z";
    persistMessage(db, a);
    persistMessage(db, b);
    const [row] = listConversationSummaries(db, { limit: 10, offset: 0 }).data;
    expect(row!.first_payload).toBe("a");
    expect(row!.participants).toEqual(["alpha", "beta"]);
    expect(getThread(db, "msg_Z_ROOT")!.messages.map((m) => m.payload)).toEqual(["a", "b"]);
  });
});

describe("what the refreshing listings read", () => {
  // The Log table and the thread list refresh every few seconds. Their shape
  // does not show whether a payload was read from disk and thrown away.
  function statementsOf(db: Database.Database, run: () => void): string[] {
    const seen: string[] = [];
    const prepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => { seen.push(sql); return prepare(sql); }) as typeof db.prepare;
    try { run(); } finally { db.prepare = prepare as typeof db.prepare; }
    return seen;
  }
  const selectList = (sql: string) => /SELECT([\s\S]*?)FROM/i.exec(sql)![1]!;

  it("lists messages without selecting a payload, or everything", () => {
    const db = createTestDb();
    seed(db, 3);
    const sqls = statementsOf(db, () => listMessageItems(db, { limit: 10, offset: 0, q: "p", agent: "alpha", routing: "direct" }));
    expect(sqls.length).toBeGreaterThan(0);
    for (const sql of sqls) {
      expect(selectList(sql), sql).not.toMatch(/\*\s*$|\*\s*,|\bpayload\b/);
    }
  });

  it("reads exactly one body per listed thread: the first message's, in one statement", () => {
    const db = createTestDb();
    const root = at(db, 0, { from: "alpha", to: "beta", type: "info", payload: "first", context: "t" });
    at(db, 1000, { from: "beta", to: "alpha", type: "reply", payload: "second", context: "t", correlation_id: root.id });
    const sqls = statementsOf(db, () => listConversationSummaries(db, { limit: 10, offset: 0 }));
    const reading = sqls.filter((sql) => /\*\s*$|\*\s*,|\bpayload\b/.test(selectList(sql)));
    expect(reading).toHaveLength(1);
    expect(reading[0]).toMatch(/WHERE id IN/);
  });
});

describe("listConversationSummaries — what a refresh costs", () => {
  it("finds the parties of the listed threads through the indexes, not by reading the table", () => {
    const db = createTestDb();
    for (let i = 0; i < 300; i++) {
      const root = at(db, i * 1000, { from: "alpha", to: "beta", type: "info", payload: `p${i}`, context: "t" });
      if (i % 3 === 0) at(db, i * 1000 + 1, { from: "beta", to: "alpha", type: "reply", payload: "r", context: "t", correlation_id: root.id });
    }
    // No ANALYZE: production has no statistics either (db.ts never runs it),
    // and this pins the plan the planner picks without them.
    const seen: string[] = [];
    const prepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => { seen.push(sql); return prepare(sql); }) as typeof db.prepare;
    const page = listConversationSummaries(db, { limit: 50, offset: 0 });
    db.prepare = prepare as typeof db.prepare;
    expect(page.data).toHaveLength(50);

    const skeleton = seen.find((sql) => /from_agent, to_agent/.test(sql) && !/payload/.test(sql));
    expect(skeleton, "the names-and-ids query").toBeDefined();
    const binds = (skeleton!.match(/\?/g) ?? []).map(() => "x");
    const plan = (prepare(`EXPLAIN QUERY PLAN ${skeleton}`).all(...binds) as { detail: string }[]).map((step) => step.detail);
    expect(plan.filter((d) => /^SCAN messages/.test(d)), plan.join(" | ")).toEqual([]);
  });
});

describe("getThread", () => {
  let db: Database.Database;
  beforeEach(() => { db = createTestDb(); });

  it("finds a thread by its root id and by the id of any reply", () => {
    const root = at(db, 0, { from: "alpha", to: "beta", type: "question", payload: "q", context: "ctx" });
    const reply = at(db, 1000, { from: "beta", to: "alpha", type: "reply", payload: "a", context: "ctx2", correlation_id: root.id });
    for (const id of [root.id, reply.id]) {
      const thread = getThread(db, id)!;
      expect(thread.thread_id, id).toBe(root.id);
      expect(thread.message_count).toBe(2);
      expect(thread.messages.map((m) => m.payload)).toEqual(["q", "a"]);
      expect(thread.first_payload).toBe("q");
      expect(thread.first_context).toBe("ctx");
      expect(thread.last_activity).toBe(reply.created_at);
    }
  });

  it("finds a thread that is far outside the first page of the list", () => {
    const old = at(db, 0, { from: "alpha", to: "beta", type: "info", payload: "the old one", context: "t" });
    for (let i = 1; i <= 60; i++) at(db, i * 1000, { from: "alpha", to: "beta", type: "info", payload: `p${i}`, context: "t" });
    expect(listConversationSummaries(db, { limit: 50, offset: 0 }).data.some((t) => t.thread_id === old.id)).toBe(false);
    expect(getThread(db, old.id)!.first_payload).toBe("the old one");
  });

  it("answers null for an id nobody knows, instead of some other thread", () => {
    at(db, 0, { from: "alpha", to: "beta", type: "info", payload: "p", context: "t" });
    expect(getThread(db, "msg_DOES_NOT_EXIST")).toBeNull();
    expect(getThread(db, "")).toBeNull();
  });

  it("does not pull a foreign message in through a borrowed correlation_id", () => {
    // mesh_send accepts any correlation_id. M points at X, which is itself
    // a reply in thread R. The thread "X" is M alone; X belongs to R.
    const r = at(db, 0, { from: "alpha", to: "beta", type: "question", payload: "R", context: "t" });
    const x = at(db, 1000, { from: "beta", to: "alpha", type: "reply", payload: "X", context: "t", correlation_id: r.id });
    at(db, 2000, { from: "gamma", to: "alpha", type: "info", payload: "M", context: "t", correlation_id: x.id });
    const m = db.prepare("SELECT id FROM messages WHERE payload = 'M'").get() as { id: string };
    expect(getThread(db, r.id)!.messages.map((v) => v.payload)).toEqual(["R", "X"]);
    // The direction in which the COALESCE check matters: M's thread is "X",
    // and the OR form alone would hand back X itself as well.
    expect(getThread(db, m.id)!.messages.map((v) => v.payload)).toEqual(["M"]);
  });

  it("keeps the parties in the order they spoke, also when that is not alphabetical", () => {
    const root = at(db, 0, { from: "zulu", to: "mike", type: "question", payload: "q", context: "t" });
    at(db, 1000, { from: "alpha", to: "zulu", type: "reply", payload: "a", context: "t", correlation_id: root.id });
    expect(listConversationSummaries(db, { limit: 10, offset: 0 }).data[0]!.participants).toEqual(["zulu", "mike", "alpha"]);
    expect(getThread(db, root.id)!.participants).toEqual(["zulu", "mike", "alpha"]);
  });

  it("opens a thread whose id is also the id of someone's reply as ITSELF: a thread id wins over a message id", () => {
    // Every link the dashboard builds carries a THREAD id. Here the thread
    // id "X" is at the same time the id of a reply in thread R.
    const r = at(db, 0, { from: "alpha", to: "beta", type: "question", payload: "R", context: "t" });
    const x = at(db, 1000, { from: "beta", to: "alpha", type: "reply", payload: "X", context: "t", correlation_id: r.id });
    const m = at(db, 2000, { from: "gamma", to: "beta", type: "info", payload: "M", context: "side", correlation_id: x.id });

    const side = getThread(db, x.id)!;
    expect(side.thread_id).toBe(x.id);
    expect(side.messages.map((msg) => msg.payload)).toEqual(["M"]);
    // M's own id still finds the thread M is in, and R is untouched.
    expect(getThread(db, m.id)!.thread_id).toBe(x.id);
    expect(getThread(db, r.id)!.messages.map((msg) => msg.payload)).toEqual(["R", "X"]);

    // The invariant behind it: every row of the list opens as what it lists.
    const rows = listConversationSummaries(db, { limit: 50, offset: 0 }).data;
    expect(rows.map((row) => row.thread_id).sort()).toEqual([r.id, x.id].sort());
    for (const row of rows) {
      const { messages: _messages, ...summary } = getThread(db, row.thread_id)!;
      expect(summary).toEqual(row);
    }
  });

  it("resolveThreadRoot maps a reply to its root and leaves unknown ids alone", () => {
    const root = at(db, 0, { from: "alpha", to: "beta", type: "question", payload: "q", context: "t" });
    const reply = at(db, 1000, { from: "beta", to: "alpha", type: "reply", payload: "a", context: "t", correlation_id: root.id });
    expect(resolveThreadRoot(db, reply.id)).toBe(root.id);
    expect(resolveThreadRoot(db, root.id)).toBe(root.id);
    expect(resolveThreadRoot(db, "msg_UNKNOWN")).toBe("msg_UNKNOWN");
  });
});

describe("listMessageItems", () => {
  it("lists what the Log table shows, without the payloads it never shows", () => {
    const db = createTestDb();
    at(db, 0, { from: "alpha", to: "beta", type: "info", payload: "x".repeat(50_000), context: "visible" });
    const items = listMessageItems(db, { limit: 10, offset: 0 });
    expect(items.total).toBe(1);
    expect(items.data[0]).toMatchObject({ from: "alpha", to: "beta", type: "info", context: "visible" });
    expect(items.data[0]).not.toHaveProperty("payload");
    // The search still reaches into payloads.
    expect(listMessageItems(db, { limit: 10, offset: 0, q: "xxxx" }).total).toBe(1);
    expect(listMessageItems(db, { limit: 10, offset: 0, q: "nothing like it" }).total).toBe(0);
  });
});
