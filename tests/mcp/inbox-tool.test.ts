// mesh_inbox: what was sent to an agent, read or not, without taking
// anything out of the broker. mesh_receive acks before its answer has
// reached the agent; when that answer is lost, this is where the message
// can still be found.

import { describe, it, expect, beforeEach } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createHarness, callTool } from "./harness";
import type { Harness, ToolCall } from "./harness";
import { ADMIN_NOT_AGENT_HINT } from "../../src/mcp/shared";
import { DEFAULT_PREVIEW_CHARS } from "../../src/types";

const CTX = "inbox test";
interface InboxRow { id: string; from: string; to: string; payload: string; read_at: string | null; expires_at: string; expired?: boolean; payload_truncated: boolean; payload_length: number }
const rowsOf = (reply: ToolCall) => reply.json.messages as InboxRow[];
const payloadsOf = (reply: ToolCall) => rowsOf(reply).map((m) => m.payload);

describe("mesh_inbox", () => {
  let h: Harness;
  let alpha: Client;
  let beta: Client;

  beforeEach(async () => {
    h = createHarness();
    h.agents.create("alpha");
    h.agents.create("beta");
    alpha = await h.connect("alpha");
    beta = await h.connect("beta");
  });
  const toAlpha = (payload: string, extra: Record<string, unknown> = {}) =>
    callTool(beta, "mesh_send", { to: "alpha", payload, context: CTX, ...extra });

  it("lists what was sent to the agent, newest first, and takes nothing out", async () => {
    await toAlpha("one");
    await toAlpha("two");
    await callTool(beta, "mesh_send", { to: "broadcast", payload: "to all", context: CTX });
    await callTool(alpha, "mesh_send", { to: "beta", payload: "not for alpha", context: CTX });

    const inbox = await callTool(alpha, "mesh_inbox", {});
    expect(inbox.isError, inbox.text).toBe(false);
    expect(payloadsOf(inbox)).toEqual(["to all", "two", "one"]);
    expect(rowsOf(inbox).every((m) => m.read_at === null)).toBe(true);
    expect(inbox.json.count).toBe(3);
    expect(inbox.json.unread).toBe(3);
    expect(inbox.json.inbox_pending).toBe(3);
    expect(h.nats.acked).toBe(0);

    // Still all there for mesh_receive.
    const got = await callTool(alpha, "mesh_receive", {});
    expect((got.json.messages as unknown[]).length).toBe(3);
  });

  it("shows when mesh_receive handed a message out, which is what survives a lost answer", async () => {
    await toAlpha("the answer to this receive gets lost");
    await callTool(alpha, "mesh_receive", {});
    const inbox = await callTool(alpha, "mesh_inbox", {});
    const [row] = rowsOf(inbox);
    expect(row.payload).toBe("the answer to this receive gets lost");
    expect(row.read_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(inbox.json.unread).toBe(0);
  });

  it("unread_only leaves out what was handed out", async () => {
    await toAlpha("read");
    await callTool(alpha, "mesh_receive", {});
    await toAlpha("unread");
    expect(payloadsOf(await callTool(alpha, "mesh_inbox", { unread_only: true }))).toEqual(["unread"]);
    expect(payloadsOf(await callTool(alpha, "mesh_inbox", {}))).toEqual(["unread", "read"]);
  });

  it("a broadcast is read per agent", async () => {
    h.agents.create("gamma");
    const gamma = await h.connect("gamma");
    await callTool(beta, "mesh_send", { to: "broadcast", payload: "to all", context: CTX });
    await callTool(alpha, "mesh_receive", {});
    expect(rowsOf(await callTool(alpha, "mesh_inbox", {}))[0].read_at).not.toBeNull();
    expect(rowsOf(await callTool(gamma, "mesh_inbox", {}))[0].read_at).toBeNull();
    // Its sender never gets it, so it is not in the sender's inbox either.
    expect(rowsOf(await callTool(beta, "mesh_inbox", {}))).toEqual([]);
  });

  it("cuts long payloads like mesh_receive does", async () => {
    await toAlpha("x".repeat(DEFAULT_PREVIEW_CHARS + 10));
    const [byDefault] = rowsOf(await callTool(alpha, "mesh_inbox", {}));
    expect(byDefault.payload).toHaveLength(DEFAULT_PREVIEW_CHARS);
    expect(byDefault.payload_truncated).toBe(true);
    expect(byDefault.payload_length).toBe(DEFAULT_PREVIEW_CHARS + 10);
    const [short] = rowsOf(await callTool(alpha, "mesh_inbox", { preview_chars: 100 }));
    expect(short.payload).toHaveLength(100);
  });

  it("marks what ran out unread, so the agent sees what it never got", async () => {
    // An agent, and a history of reads, that are an hour old.
    const anHourAgo = new Date(Date.now() - 3_600_000).toISOString();
    h.db.prepare("UPDATE agents SET inbox_since = ?").run(anHourAgo);
    h.db.prepare("UPDATE _migrations SET applied_at = ? WHERE name = '0010_message_reads.sql'").run(anHourAgo);
    const sent = await toAlpha("too late", { ttl_seconds: 1 });
    h.db.prepare("UPDATE messages SET created_at = ? WHERE id = ?").run(new Date(Date.now() - 60_000).toISOString(), sent.json.id);
    const [row] = rowsOf(await callTool(alpha, "mesh_inbox", {}));
    expect(row.expired).toBe(true);
    expect(Date.parse(row.expires_at)).toBeLessThan(Date.now());
  });

  it("honours limit, and refuses one outside its bounds", async () => {
    for (let i = 0; i < 4; i++) await toAlpha(`m${i}`);
    const two = await callTool(alpha, "mesh_inbox", { limit: 2 });
    expect(payloadsOf(two)).toEqual(["m3", "m2"]);
    expect(two.json.unread).toBe(4);
    expect((await callTool(alpha, "mesh_inbox", { limit: 0 })).isError).toBe(true);
    expect((await callTool(alpha, "mesh_inbox", { limit: 51 })).isError).toBe(true);
    expect((await callTool(alpha, "mesh_inbox", { limit: 50 })).isError).toBe(false);
  });

  it("follows the agent through a rename", async () => {
    await toAlpha("before the rename");
    h.agents.rename(h.agents.getByName("alpha")!.id, "gamma", "admin");
    const gamma = await h.connect("gamma");
    await callTool(beta, "mesh_send", { to: "gamma", payload: "after the rename", context: CTX });
    const inbox = await callTool(gamma, "mesh_inbox", {});
    expect(payloadsOf(inbox)).toEqual(["after the rename", "before the rename"]);
    expect(rowsOf(inbox).map((m) => m.to)).toEqual(["gamma", "gamma"]);
  });

  it("does not show a new agent the mail of the one that had its name and key before", async () => {
    await toAlpha("for the first alpha");
    await callTool(beta, "mesh_send", { to: "broadcast", payload: "before the second alpha", context: CTX });
    h.agents.deleteById(h.agents.getByName("alpha")!.id, "admin");
    await new Promise((r) => setTimeout(r, 5));
    h.agents.create("alpha");
    const second = await h.connect("alpha");
    expect(rowsOf(await callTool(second, "mesh_inbox", {}))).toEqual([]);
    await toAlpha("for the second alpha");
    expect(payloadsOf(await callTool(second, "mesh_inbox", {}))).toEqual(["for the second alpha"]);
  });

  it("leaves out what was sent before reads were recorded: it would all look unread", async () => {
    h.db.prepare(
      `INSERT INTO messages (id, from_agent, to_agent, type, payload, context, correlation_id, reply_to, priority, ttl_seconds, created_at, from_key)
       VALUES ('msg_before', 'beta', 'alpha', 'info', 'from before', 'ctx', NULL, NULL, 'normal', 86400, ?, 'beta')`,
    ).run(new Date().toISOString());
    const inbox = await callTool(alpha, "mesh_inbox", {});
    expect(rowsOf(inbox)).toEqual([]);
    expect(inbox.json.unread).toBe(0);
  });

  it("says so when there is nothing", async () => {
    const inbox = await callTool(alpha, "mesh_inbox", {});
    expect(inbox.json.messages).toEqual([]);
    expect(inbox.json.count).toBe(0);
    expect(String(inbox.json.hint)).toMatch(/nothing/i);
  });

  it("is refused for the admin token, which has no inbox", async () => {
    const admin = await h.connect("admin", { isAdmin: true });
    const res = await callTool(admin, "mesh_inbox", {});
    expect(res.isError).toBe(true);
    expect(res.text).toBe(ADMIN_NOT_AGENT_HINT);
  });

  // The bug: never_handed_out was counted while mapping the RETURNED page,
  // so `limit` moved a number that its own description, the README and
  // CLAUDE.md all call a property of the inbox. With 17 unsent messages and
  // the default limit of 10 it answered 10 — smaller than `unread`, which is
  // impossible under that reading, and an agent that trusts the wording
  // concludes seven were already handed to it.
  it("counts the whole inbox, whatever the page size", async () => {
    for (let i = 0; i < 17; i++) await toAlpha(`m${i}`);

    const paged = await callTool(alpha, "mesh_inbox", { limit: 3 });
    expect(rowsOf(paged)).toHaveLength(3);
    expect(paged.json.unread).toBe(17);
    expect(paged.json.never_handed_out).toBe(17);

    const dflt = await callTool(alpha, "mesh_inbox", {});
    expect(rowsOf(dflt)).toHaveLength(10);
    expect(dflt.json.never_handed_out).toBe(17);

    const all = await callTool(alpha, "mesh_inbox", { limit: 50 });
    expect(rowsOf(all)).toHaveLength(17);
    expect(all.json.never_handed_out).toBe(17);

    // And it never drops below `unread`: it is a superset of it.
    for (const reply of [paged, dflt, all]) {
      expect(reply.json.never_handed_out as number).toBeGreaterThanOrEqual(reply.json.unread as number);
    }
  });

  // `never_handed_out` is a superset of `unread`: what ran out before it was
  // read stays in the first and leaves the second. Only a message whose own
  // deadline has really passed is dropped by mesh_receive — the stream body
  // carries its created_at, so moving the SQLite row's is not enough.
  it("keeps counting what ran out unread, and stops counting what was read", async () => {
    await toAlpha("ran out", { ttl_seconds: 1 });
    // Past the deadline by more than a second: `created_at` is stored to the
    // second, so for up to one second after it the SQL count and the
    // message's own check can still disagree.
    await new Promise((r) => setTimeout(r, 2_100));
    await toAlpha("still due");

    const before = await callTool(alpha, "mesh_inbox", { limit: 1 });
    expect(before.json.unread).toBe(1);
    expect(before.json.never_handed_out).toBe(2);

    const received = await callTool(alpha, "mesh_receive", {});
    expect(payloadsOf(received)).toEqual(["still due"]);
    expect(received.json.expired_dropped).toBe(1);

    const after = await callTool(alpha, "mesh_inbox", { limit: 1 });
    expect(after.json.unread).toBe(0);
    // The one that ran out was never handed out and never will be.
    expect(after.json.never_handed_out).toBe(1);
  });

  it("is announced as read-only", async () => {
    const tool = (await alpha.listTools()).tools.find((t) => t.name === "mesh_inbox");
    expect(tool?.annotations?.readOnlyHint).toBe(true);
  });
});

describe("mesh_receive records what it hands out", () => {
  let h: Harness;
  let alpha: Client;
  let beta: Client;

  beforeEach(async () => {
    h = createHarness();
    h.agents.create("alpha");
    h.agents.create("beta");
    alpha = await h.connect("alpha");
    beta = await h.connect("beta");
  });
  const reads = (id: unknown) =>
    h.db.prepare("SELECT reader_key, read_at FROM message_reads WHERE message_id = ?").all(id) as { reader_key: string; read_at: string }[];

  it("one row per message and reader, under the reader's inbox key", async () => {
    const sent = await callTool(beta, "mesh_send", { to: "alpha", payload: "x", context: CTX });
    expect(reads(sent.json.id)).toEqual([]);
    await callTool(alpha, "mesh_receive", {});
    expect(reads(sent.json.id).map((r) => r.reader_key)).toEqual(["alpha"]);
  });

  it("stores who a direct message is for by key, not by name", async () => {
    const sent = await callTool(beta, "mesh_send", { to: "ALPHA", payload: "x", context: CTX });
    const row = h.db.prepare("SELECT to_agent, to_key FROM messages WHERE id = ?").get(sent.json.id) as { to_agent: string; to_key: string | null };
    expect(row).toEqual({ to_agent: "alpha", to_key: "alpha" });
    // A broadcast carries "" : "written by this code, for everybody". NULL is
    // a row from before, or from an older release in a deploy overlap.
    const all = await callTool(beta, "mesh_send", { to: "broadcast", payload: "x", context: CTX });
    expect((h.db.prepare("SELECT to_key FROM messages WHERE id = ?").get(all.json.id) as { to_key: string | null }).to_key).toBe("");
  });

  it("hands the batch out even when the reads cannot be written", async () => {
    await callTool(beta, "mesh_send", { to: "alpha", payload: "still delivered", context: CTX });
    h.db.exec("CREATE TRIGGER no_reads BEFORE INSERT ON message_reads BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END");
    const got = await callTool(alpha, "mesh_receive", {});
    expect(got.isError, got.text).toBe(false);
    expect((got.json.messages as { payload: string }[]).map((m) => m.payload)).toEqual(["still delivered"]);
  });

  it("hands the batch out even when the reads cannot be asked", async () => {
    await callTool(beta, "mesh_send", { to: "alpha", payload: "still delivered", context: CTX });
    h.db.exec("DROP TABLE message_reads");
    const got = await callTool(alpha, "mesh_receive", {});
    expect(got.isError, got.text).toBe(false);
    expect((got.json.messages as { payload: string }[]).map((m) => m.payload)).toEqual(["still delivered"]);
  });

  it("does not hand the same message out twice when the broker delivers it again", async () => {
    const msg = { id: "msg_again", from: "beta", to: "alpha", type: "info", payload: "once", context: CTX, correlation_id: null, reply_to: null, priority: "normal", ttl_seconds: 86400, created_at: new Date().toISOString() };
    h.nats.enqueue("alpha", msg);
    expect((await callTool(alpha, "mesh_receive", {})).json.count).toBe(1);
    h.nats.enqueue("alpha", msg); // the ack was lost, the broker delivers again
    const second = await callTool(alpha, "mesh_receive", {});
    expect(second.json.messages).toEqual([]);
    expect(second.json.inbox_pending).toBe(0);
  });
});

// A sender used to have no way to learn whether anybody read its message.
describe("mesh_get and mesh_history say whether a message was read", () => {
  let h: Harness;
  let alpha: Client;
  let beta: Client;

  beforeEach(async () => {
    h = createHarness();
    h.agents.create("alpha");
    h.agents.create("beta");
    alpha = await h.connect("alpha");
    beta = await h.connect("beta");
  });

  it("a direct message: null until its recipient was handed it, then the moment", async () => {
    const sent = await callTool(alpha, "mesh_send", { to: "beta", payload: "x", context: CTX });
    const before = await callTool(alpha, "mesh_get", { message_id: sent.json.id });
    expect(before.json).toHaveProperty("read_at", null);
    expect(before.json.expires_at).toBe(sent.json.expires_at);
    await callTool(beta, "mesh_receive", {});
    const after = await callTool(alpha, "mesh_get", { message_id: sent.json.id });
    expect(after.json.read_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(after.json.read_by).toBeUndefined();
  });

  it("a read by somebody else does not count for a direct message", async () => {
    const sent = await callTool(alpha, "mesh_send", { to: "beta", payload: "x", context: CTX });
    h.db.prepare("INSERT INTO message_reads (message_id, reader_key, read_at) VALUES (?, 'gamma', ?)").run(sent.json.id, new Date().toISOString());
    expect((await callTool(alpha, "mesh_get", { message_id: sent.json.id })).json.read_at).toBeNull();
  });

  it("a broadcast: how many agents were handed it", async () => {
    h.agents.create("gamma");
    const gamma = await h.connect("gamma");
    const sent = await callTool(alpha, "mesh_send", { to: "broadcast", payload: "x", context: CTX });
    expect((await callTool(alpha, "mesh_get", { message_id: sent.json.id })).json.read_by).toBe(0);
    await callTool(beta, "mesh_receive", {});
    await callTool(gamma, "mesh_receive", {});
    const after = await callTool(alpha, "mesh_get", { message_id: sent.json.id });
    expect(after.json.read_by).toBe(2);
    expect(after.json).not.toHaveProperty("read_at");
  });

  it("says nothing about a message from before reads were recorded", async () => {
    h.db.prepare(
      `INSERT INTO messages (id, from_agent, to_agent, type, payload, context, correlation_id, reply_to, priority, ttl_seconds, created_at, from_key)
       VALUES ('msg_before', 'alpha', 'beta', 'info', 'old', 'ctx', NULL, NULL, 'normal', 86400, ?, 'alpha')`,
    ).run(new Date().toISOString());
    const got = await callTool(alpha, "mesh_get", { message_id: "msg_before" });
    expect(got.json).not.toHaveProperty("read_at");
    expect(got.json).not.toHaveProperty("read_by");
  });

  it("mesh_history carries the same for every message of the thread", async () => {
    const root = await callTool(alpha, "mesh_send", { to: "beta", payload: "question", context: CTX });
    await callTool(beta, "mesh_receive", {});
    await callTool(beta, "mesh_reply", { message_id: root.json.id, payload: "answer", context: CTX });
    const thread = await callTool(alpha, "mesh_history", { correlation_id: root.json.id as string });
    const [first, second] = thread.json.messages as { read_at: string | null }[];
    expect(first.read_at).toMatch(/^\d{4}-/);
    expect(second.read_at).toBeNull();
  });
});

describe("mesh_receive and the reads it records, the edges", () => {
  let h: Harness;
  let alpha: Client;
  let beta: Client;
  beforeEach(async () => {
    h = createHarness();
    h.agents.create("alpha");
    h.agents.create("beta");
    alpha = await h.connect("alpha");
    beta = await h.connect("beta");
  });

  it("records no read for a batch it could not return: an ack that throws ends the call, and the reads stay unwritten", async () => {
    for (let i = 0; i < 3; i++) await callTool(beta, "mesh_send", { to: "alpha", payload: `m${i}`, context: CTX });
    const pull = h.nats.pullInbox.bind(h.nats);
    h.nats.pullInbox = async (key, limit, opts) => {
      const res = await pull(key, limit, opts);
      res.messages[1].ack = () => { throw new Error("connection closed"); };
      return res;
    };
    const got = await callTool(alpha, "mesh_receive", {});
    expect(got.isError).toBe(true);
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM message_reads").get()).toEqual({ n: 0 });
  });

  it("says when a read could not be recorded, so the sweep does not call the message expired unread", async () => {
    const sent = await callTool(beta, "mesh_send", { to: "alpha", payload: "handed out", context: CTX, ttl_seconds: 1 });
    h.db.exec("CREATE TRIGGER no_reads BEFORE INSERT ON message_reads BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END");
    const got = await callTool(alpha, "mesh_receive", {});
    expect(got.isError, got.text).toBe(false);
    const noted = h.db.prepare("SELECT action, agent_name FROM activity_log WHERE entity_id = ? AND action = 'read_not_recorded'").all(sent.json.id);
    expect(noted).toEqual([{ action: "read_not_recorded", agent_name: "alpha" }]);
  });

  it("flags a message as expired only when it ran out UNREAD", async () => {
    const anHourAgo = new Date(Date.now() - 3_600_000).toISOString();
    h.db.prepare("UPDATE agents SET inbox_since = ?").run(anHourAgo);
    h.db.prepare("UPDATE _migrations SET applied_at = ? WHERE name = '0010_message_reads.sql'").run(anHourAgo);
    const read = await callTool(beta, "mesh_send", { to: "alpha", payload: "read in time", context: CTX, ttl_seconds: 1 });
    await callTool(alpha, "mesh_receive", {});
    const unread = await callTool(beta, "mesh_send", { to: "alpha", payload: "never read", context: CTX, ttl_seconds: 1 });
    for (const id of [read.json.id, unread.json.id]) h.db.prepare("UPDATE messages SET created_at = ? WHERE id = ?").run(new Date(Date.now() - 60_000).toISOString(), id);
    const inbox = await callTool(alpha, "mesh_inbox", {});
    const byId = Object.fromEntries((inbox.json.messages as { id: string; expired?: boolean; read_at: string | null }[]).map((m) => [m.id, m]));
    expect(byId[read.json.id as string].expired).toBeUndefined();
    expect(byId[read.json.id as string].read_at).not.toBeNull();
    expect(byId[unread.json.id as string].expired).toBe(true);
    // `unread` counts what mesh_receive can still hand out, not what ran out.
    expect(inbox.json.unread).toBe(0);
    expect(inbox.json.never_handed_out).toBe(1);
  });

  it("does not fall over a row whose created_at is no date", async () => {
    h.db.prepare(
      `INSERT INTO messages (id, from_agent, to_agent, type, payload, context, correlation_id, reply_to, priority, ttl_seconds, created_at, from_key, to_key)
       VALUES ('msg_01ARZ3NDEKTSV4RRFFQ69G5FAV', 'beta', 'alpha', 'info', 'by hand', 'ctx', NULL, NULL, 'normal', 86400, 'yesterday', 'beta', 'alpha')`,
    ).run();
    for (const [tool, args] of [["mesh_get", { message_id: "msg_01ARZ3NDEKTSV4RRFFQ69G5FAV" }], ["mesh_history", { correlation_id: "msg_01ARZ3NDEKTSV4RRFFQ69G5FAV" }]] as const) {
      const res = await callTool(alpha, tool, args);
      expect(res.isError, `${tool}: ${res.text}`).toBe(false);
    }
    expect((await callTool(alpha, "mesh_get", { message_id: "msg_01ARZ3NDEKTSV4RRFFQ69G5FAV" })).json.expires_at).toBeNull();
  });
});
