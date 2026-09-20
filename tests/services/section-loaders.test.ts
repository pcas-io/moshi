// The loaders the pages and their fragments share.

import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { initDatabase } from "../../src/services/db";
import { createMessage, persistMessage } from "../../src/services/message";
import {
  loadConversationList,
  loadLatestThread,
  loadOpenThread,
  readConversationsQuery,
} from "../../src/services/section-loaders";

let db: Database.Database;
beforeEach(() => { db = initDatabase(":memory:"); });

function at(offsetMs: number, params: Parameters<typeof createMessage>[0]) {
  const m = createMessage(params);
  m.created_at = new Date(Date.parse("2026-09-19T10:00:00.000Z") + offsetMs).toISOString();
  persistMessage(db, m);
  return m;
}
const query = (qs: string) => {
  const params = new URLSearchParams(qs);
  return readConversationsQuery((key) => params.get(key) ?? undefined);
};

describe("loadLatestThread", () => {
  it("is the thread of the newest message, also when that thread's id is a reply's id", () => {
    const r = at(0, { from: "alpha", to: "beta", type: "question", payload: "R", context: "t" });
    const x = at(1000, { from: "beta", to: "alpha", type: "reply", payload: "X", context: "t", correlation_id: r.id });
    at(2000, { from: "gamma", to: "beta", type: "info", payload: "M", context: "t", correlation_id: x.id });
    const latest = loadLatestThread(db)!;
    expect(latest.thread_id).toBe(x.id);
    expect(latest.messages.map((m) => m.payload)).toEqual(["M"]);
    // and it is the thread Conversations opens by default
    expect(loadOpenThread(db, {}, loadConversationList(db, query(""))).opened!.thread_id).toBe(x.id);
  });

  it("asks for the newest message, and does not group the whole table to find one thread", () => {
    at(0, { from: "alpha", to: "beta", type: "info", payload: "p", context: "t" });
    const seen: string[] = [];
    const prepare = db.prepare.bind(db);
    db.prepare = ((sql: string) => { seen.push(sql); return prepare(sql); }) as typeof db.prepare;
    expect(loadLatestThread(db)).not.toBeNull();
    db.prepare = prepare as typeof db.prepare;
    expect(seen.filter((sql) => /GROUP BY|DISTINCT|COUNT\(/i.test(sql))).toEqual([]);
  });

  it("is the most recently ACTIVE thread, not the most recently started and not the first", () => {
    const busy = at(0, { from: "alpha", to: "beta", type: "info", payload: "old root", context: "t" });
    at(60_000, { from: "alpha", to: "beta", type: "info", payload: "middle", context: "t" });
    at(120_000, { from: "beta", to: "alpha", type: "reply", payload: "late reply", context: "t", correlation_id: busy.id });
    expect(loadLatestThread(db)!.thread_id).toBe(busy.id);
  });

  it("is null on an empty mesh", () => {
    expect(loadLatestThread(db)).toBeNull();
  });
});

describe("readConversationsQuery", () => {
  it("trims what arrives, the id included: ids are stored trimmed, and a pasted one often has a space at its end", () => {
    expect(query("q=%20deploy%20&agent=%20alpha%20&id=%20topic-1%20&offset=50")).toEqual({
      offset: 50, q: "deploy", agent: "alpha", id: "topic-1",
    });
    expect(query("id=")).toEqual({ offset: 0, q: undefined, agent: undefined, id: undefined });
  });

  it("opens a thread that was sent with spaces around its correlation id, from its row and from a pasted id", () => {
    at(0, { from: "alpha", to: "beta", type: "info", payload: "padded", context: "t", correlation_id: " topic-1 " });
    const row = loadConversationList(db, query("")).data[0]!;
    expect(row.thread_id).toBe("topic-1");
    for (const qs of [`id=${encodeURIComponent(row.thread_id)}`, "id=%20topic-1%20"]) {
      const q = query(qs);
      const open = loadOpenThread(db, q, loadConversationList(db, q));
      expect(open.unknownId, qs).toBeUndefined();
      expect(open.opened!.messages.map((m) => m.payload), qs).toEqual(["padded"]);
    }
  });
});
