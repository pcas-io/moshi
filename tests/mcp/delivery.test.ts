// The delivery core: what a sender is told, where a reply goes, which thread
// a message may join, and how a send whose outcome nobody knows is repeated
// without reaching the recipient twice.

import { describe, it, expect, beforeEach } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createHarness, callTool } from "./harness";
import type { Harness, ToolCall } from "./harness";
import { RateLimiter } from "../../src/services/ratelimit";

const CTX = "delivery test";
const payloadsOf = (reply: ToolCall) => (reply.json.messages as { payload: string }[]).map((m) => m.payload);
const rowCount = (h: Harness, id: string) =>
  (h.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE id = ?").get(id) as { n: number }).n;
/** The id a refused send names, so that it can be sent again. */
const idIn = (text: string) => /msg_[0-9A-HJKMNP-TV-Z]{26}/.exec(text)?.[0] ?? "";

describe("mesh_reply to one's own message", () => {
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

  it("goes to the one the message was for, not back to the sender", async () => {
    const sent = await callTool(alpha, "mesh_send", { to: "beta", payload: "first", context: CTX });
    const more = await callTool(alpha, "mesh_reply", { message_id: sent.json.id, payload: "one more thing", context: CTX });
    expect(more.isError, more.text).toBe(false);
    expect(more.json.to).toBe("beta");
    expect(h.nats.published.at(-1)!.subject).toBe("mesh.agents.beta.inbox");
    expect(payloadsOf(await callTool(beta, "mesh_receive", {}))).toEqual(["first", "one more thing"]);
    expect((await callTool(alpha, "mesh_receive", {})).json.messages).toEqual([]);
  });

  it("goes back to everyone when the message was a broadcast", async () => {
    const sent = await callTool(alpha, "mesh_send", { to: "broadcast", payload: "to all", context: CTX });
    const more = await callTool(alpha, "mesh_reply", { message_id: sent.json.id, payload: "correction", context: CTX });
    expect(more.isError, more.text).toBe(false);
    expect(more.json.to).toBe("broadcast");
    expect(h.nats.published.at(-1)!.subject).toBe("mesh.broadcast");
    expect(more.json.correlation_id).toBe(sent.json.id);
  });

  it("still knows the message as its own after a rename", async () => {
    const sent = await callTool(alpha, "mesh_send", { to: "beta", payload: "first", context: CTX });
    h.agents.rename(h.agents.getByName("alpha")!.id, "gamma", "admin");
    const gamma = await h.connect("gamma");
    const more = await callTool(gamma, "mesh_reply", { message_id: sent.json.id, payload: "as gamma", context: CTX });
    expect(more.json.to).toBe("beta");
  });

  it("refuses when the one it was for is gone", async () => {
    const sent = await callTool(alpha, "mesh_send", { to: "beta", payload: "first", context: CTX });
    h.agents.deleteById(h.agents.getByName("beta")!.id, "admin");
    const more = await callTool(alpha, "mesh_reply", { message_id: sent.json.id, payload: "anyone?", context: CTX });
    expect(more.isError).toBe(true);
    expect(more.text).toContain("mesh_status");
  });

  it("leaves an ordinary reply alone: it goes to the sender", async () => {
    const sent = await callTool(alpha, "mesh_send", { to: "beta", payload: "question", context: CTX });
    const answer = await callTool(beta, "mesh_reply", { message_id: sent.json.id, payload: "answer", context: CTX });
    expect(answer.json.to).toBe("alpha");
  });
});

describe("what a sender is told about the deadline", () => {
  let h: Harness;
  let alpha: Client;

  beforeEach(async () => {
    h = createHarness();
    h.agents.create("alpha");
    h.agents.create("beta");
    alpha = await h.connect("alpha");
  });

  it("mesh_send names the moment the message stops being delivered", async () => {
    const sent = await callTool(alpha, "mesh_send", { to: "beta", payload: "x", context: CTX, ttl_seconds: 90 });
    const created = Date.parse(sent.json.created_at as string);
    expect(Date.parse(sent.json.expires_at as string)).toBe(created + 90_000);
    const byDefault = await callTool(alpha, "mesh_send", { to: "beta", payload: "x", context: CTX });
    expect(Date.parse(byDefault.json.expires_at as string)).toBe(Date.parse(byDefault.json.created_at as string) + 86_400_000);
  });

  it("mesh_reply does too", async () => {
    const sent = await callTool(alpha, "mesh_send", { to: "beta", payload: "x", context: CTX });
    const beta = await h.connect("beta");
    const answer = await callTool(beta, "mesh_reply", { message_id: sent.json.id, payload: "y", context: CTX });
    expect(Date.parse(answer.json.expires_at as string)).toBe(Date.parse(answer.json.created_at as string) + 86_400_000);
  });
});

describe("correlation_id names an existing thread", () => {
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
  const send = (extra: Record<string, unknown>) =>
    callTool(alpha, "mesh_send", { to: "beta", payload: "x", context: CTX, ...extra });

  it("refuses an id nobody has ever seen, publishes nothing and says what to do", async () => {
    const res = await send({ correlation_id: "deploy-2026-09" });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("deploy-2026-09");
    expect(res.text).toContain("mesh_reply");
    expect(h.nats.published).toHaveLength(0);
  });

  it("takes the id of a thread's first message as it is", async () => {
    const root = await send({});
    const next = await send({ correlation_id: root.json.id });
    expect(next.isError, next.text).toBe(false);
    expect(next.json.correlation_id).toBe(root.json.id);
  });

  it("turns the id of a reply into the thread it belongs to", async () => {
    const root = await send({});
    const answer = await callTool(beta, "mesh_reply", { message_id: root.json.id, payload: "y", context: CTX });
    const next = await send({ correlation_id: answer.json.id });
    expect(next.isError, next.text).toBe(false);
    expect(next.json.correlation_id).toBe(root.json.id);
    const thread = await callTool(alpha, "mesh_history", { correlation_id: root.json.id as string });
    expect(thread.json.count).toBe(3);
    // No second thread named after the reply.
    const split = h.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE correlation_id = ?").get(answer.json.id) as { n: number };
    expect(split.n).toBe(0);
  });

  it("keeps a thread that was named freely before this rule", async () => {
    h.db.prepare(
      `INSERT INTO messages (id, from_agent, to_agent, type, payload, context, correlation_id, reply_to, priority, ttl_seconds, created_at)
       VALUES ('msg_legacy', 'beta', 'alpha', 'info', 'old', 'ctx', 'release-train', NULL, 'normal', 86400, ?)`,
    ).run(new Date().toISOString());
    const next = await send({ correlation_id: "  release-train " });
    expect(next.isError, next.text).toBe(false);
    expect(next.json.correlation_id).toBe("release-train");
  });

  it("a thread name wins over a message that happens to have the same id", async () => {
    // Legacy: somebody named a thread after a reply of another thread.
    const root = await send({});
    const answer = await callTool(beta, "mesh_reply", { message_id: root.json.id, payload: "y", context: CTX });
    h.db.prepare(
      `INSERT INTO messages (id, from_agent, to_agent, type, payload, context, correlation_id, reply_to, priority, ttl_seconds, created_at)
       VALUES ('msg_side', 'beta', 'alpha', 'info', 'side thread', 'ctx', ?, NULL, 'normal', 86400, ?)`,
    ).run(answer.json.id, new Date().toISOString());
    const next = await send({ correlation_id: answer.json.id });
    expect(next.json.correlation_id).toBe(answer.json.id);
  });

  it("still reads an empty value as none", async () => {
    const res = await send({ correlation_id: "   " });
    expect(res.isError, res.text).toBe(false);
    expect(res.json.correlation_id).toBeUndefined();
  });
});

describe("sending again what may or may not have arrived", () => {
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
  const send = (extra: Record<string, unknown> = {}) =>
    callTool(alpha, "mesh_send", { to: "beta", payload: "important", context: CTX, ...extra });

  it("tells the sender how: the refusal names the id and the parameter", async () => {
    h.nats.publishOutcome = "timeout_stored";
    const first = await send();
    expect(first.isError).toBe(true);
    expect(first.text).toMatch(/^nats_unavailable/);
    expect(first.text).toContain("could not be confirmed");
    expect(first.text).toContain(`message_id="${idIn(first.text)}"`);
    expect(idIn(first.text)).not.toBe("");
  });

  it("the first attempt had arrived: one delivery, one history row, and the sender learns it", async () => {
    h.nats.publishOutcome = "timeout_stored";
    const id = idIn((await send()).text);
    expect(rowCount(h, id)).toBe(0);

    h.nats.publishOutcome = "ok";
    const again = await send({ message_id: id });
    expect(again.isError, again.text).toBe(false);
    expect(again.json.id).toBe(id);
    expect(again.json.duplicate).toBe(true);
    expect(rowCount(h, id)).toBe(1);
    expect(payloadsOf(await callTool(beta, "mesh_receive", {}))).toEqual(["important"]);
    expect((await callTool(beta, "mesh_get", { message_id: id })).isError).toBe(false);
    expect((await callTool(beta, "mesh_reply", { message_id: id, payload: "got it", context: CTX })).isError).toBe(false);
  });

  it("the first attempt was lost: the second one is the delivery", async () => {
    h.nats.publishOutcome = "timeout_lost";
    const id = idIn((await send()).text);
    h.nats.publishOutcome = "ok";
    const again = await send({ message_id: id });
    expect(again.isError, again.text).toBe(false);
    expect(again.json.id).toBe(id);
    expect(again.json.duplicate).toBeUndefined();
    expect(payloadsOf(await callTool(beta, "mesh_receive", {}))).toEqual(["important"]);
    expect(rowCount(h, id)).toBe(1);
  });

  it("the sequence stored with the row is the one the broker kept the first copy under", async () => {
    await send({ payload: "before" });
    h.nats.publishOutcome = "timeout_stored";
    const id = idIn((await send()).text);
    h.nats.publishOutcome = "ok";
    await send({ payload: "in between" });
    await send({ message_id: id });
    const row = h.db.prepare("SELECT stream_seq FROM messages WHERE id = ?").get(id) as { stream_seq: number };
    expect(row.stream_seq).toBe(2);
  });

  it("answers a repeat of what was delivered and stored without sending anything", async () => {
    const first = await send();
    const published = h.nats.published.length;
    const again = await send({ message_id: first.json.id });
    expect(again.isError, again.text).toBe(false);
    expect(again.json.id).toBe(first.json.id);
    expect(again.json.already_delivered).toBe(true);
    expect(again.json.created_at).toBe(first.json.created_at);
    expect(h.nats.published).toHaveLength(published);
    expect(payloadsOf(await callTool(beta, "mesh_receive", {}))).toEqual(["important"]);
  });

  it("refuses to pass another message off under a delivered id", async () => {
    const first = await send();
    for (const other of [{ payload: "something else" }, { to: "alpha" }, { type: "question" }]) {
      const again = await send({ message_id: first.json.id, ...other });
      expect(again.isError, JSON.stringify(other)).toBe(true);
      expect(again.text).toContain("different");
    }
    expect(h.nats.published).toHaveLength(1);
  });

  it("refuses an id that is somebody else's message, and points to mesh_reply", async () => {
    const theirs = await callTool(beta, "mesh_send", { to: "alpha", payload: "from beta", context: CTX });
    const again = await send({ message_id: theirs.json.id });
    expect(again.isError).toBe(true);
    expect(again.text).toContain("mesh_reply");
    expect(h.nats.published).toHaveLength(1);
  });

  it("refuses an id that is no message id", async () => {
    for (const bad of ["msg_x", "deploy-1", "msg_" + "I".repeat(26), "msg_" + "0".repeat(27), ""]) {
      const res = await send({ message_id: bad });
      expect(res.isError, bad).toBe(true);
    }
    expect(h.nats.published).toHaveLength(0);
  });

  it("after the broker's duplicate window the recipient still reads it once: both copies in one pull", async () => {
    h.nats.publishOutcome = "timeout_stored";
    const id = idIn((await send()).text);
    h.nats.publishOutcome = "ok";
    h.nats.forgetDuplicates();
    const again = await send({ message_id: id });
    expect(again.isError, again.text).toBe(false);
    const got = await callTool(beta, "mesh_receive", {});
    expect(payloadsOf(got)).toEqual(["important"]);
    expect(got.json.inbox_pending).toBe(0);
  });

  it("after the broker's duplicate window the recipient still reads it once: the second copy comes later", async () => {
    h.nats.publishOutcome = "timeout_stored";
    const id = idIn((await send()).text);
    expect(payloadsOf(await callTool(beta, "mesh_receive", {}))).toEqual(["important"]);
    h.nats.publishOutcome = "ok";
    h.nats.forgetDuplicates();
    await send({ message_id: id });
    await send({ payload: "the next one" });
    const got = await callTool(beta, "mesh_receive", { limit: 1 });
    expect(payloadsOf(got)).toEqual(["the next one"]);
    expect(got.json.inbox_pending).toBe(0);
  });

  it("a reply can be sent again too, under its own parameter", async () => {
    const question = await callTool(beta, "mesh_send", { to: "alpha", payload: "?", context: CTX });
    h.nats.publishOutcome = "timeout_stored";
    const first = await callTool(alpha, "mesh_reply", { message_id: question.json.id, payload: "!", context: CTX });
    expect(first.isError).toBe(true);
    const id = idIn(first.text);
    expect(first.text).toContain(`resend_id="${id}"`);
    h.nats.publishOutcome = "ok";
    const again = await callTool(alpha, "mesh_reply", { message_id: question.json.id, resend_id: id, payload: "!", context: CTX });
    expect(again.isError, again.text).toBe(false);
    expect(again.json.id).toBe(id);
    expect(again.json.duplicate).toBe(true);
    expect(again.json.reply_to).toBe(question.json.id);
    await callTool(beta, "mesh_receive", {}); // beta's own question is not in it
    expect(rowCount(h, id)).toBe(1);
  });
});

describe("a delivery the history did not take", () => {
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
  const breakHistory = () => h.db.exec("CREATE TRIGGER no_history BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END");
  const mendHistory = () => h.db.exec("DROP TRIGGER no_history");

  it("is reported to the sender, with the way to mend it", async () => {
    breakHistory();
    const sent = await callTool(alpha, "mesh_send", { to: "beta", payload: "delivered anyway", context: CTX });
    expect(sent.isError, sent.text).toBe(false);
    expect(sent.json.history_gap).toBe(true);
    expect(String(sent.json.hint)).toContain(`message_id="${sent.json.id}"`);
    expect(rowCount(h, sent.json.id as string)).toBe(0);
  });

  it("is mended by sending it again, and the recipient still gets it once", async () => {
    breakHistory();
    const sent = await callTool(alpha, "mesh_send", { to: "beta", payload: "delivered anyway", context: CTX });
    mendHistory();
    const again = await callTool(alpha, "mesh_send", { to: "beta", payload: "delivered anyway", context: CTX, message_id: sent.json.id });
    expect(again.isError, again.text).toBe(false);
    expect(again.json.history_gap).toBeUndefined();
    expect(rowCount(h, sent.json.id as string)).toBe(1);
    expect(payloadsOf(await callTool(beta, "mesh_receive", {}))).toEqual(["delivered anyway"]);
  });

  it("a reply reports it as well", async () => {
    const question = await callTool(beta, "mesh_send", { to: "alpha", payload: "?", context: CTX });
    breakHistory();
    const answer = await callTool(alpha, "mesh_reply", { message_id: question.json.id, payload: "!", context: CTX });
    expect(answer.isError, answer.text).toBe(false);
    expect(answer.json.history_gap).toBe(true);
    expect(String(answer.json.hint)).toContain(`resend_id="${answer.json.id}"`);
  });
});

describe("what a send costs", () => {
  const limited = (capacity: number) => {
    const clock = { now: 0 };
    const h = createHarness({ rateLimiter: new RateLimiter(capacity, 60_000, () => clock.now) });
    h.agents.create("alpha");
    h.agents.create("beta");
    return { h, clock };
  };

  it("nothing, when it is refused before it is sent", async () => {
    const { h } = limited(2);
    const alpha = await h.connect("alpha");
    for (let i = 0; i < 5; i++) {
      expect((await callTool(alpha, "mesh_send", { to: "nobody", payload: "x", context: CTX })).isError).toBe(true);
      expect((await callTool(alpha, "mesh_send", { to: "beta", payload: "x", context: CTX, correlation_id: "no-such-thread" })).isError).toBe(true);
      expect((await callTool(alpha, "mesh_reply", { message_id: "msg_none", payload: "x", context: CTX })).isError).toBe(true);
    }
    expect((await callTool(alpha, "mesh_send", { to: "beta", payload: "1", context: CTX })).isError).toBe(false);
    expect((await callTool(alpha, "mesh_send", { to: "beta", payload: "2", context: CTX })).isError).toBe(false);
    const third = await callTool(alpha, "mesh_send", { to: "beta", payload: "3", context: CTX });
    expect(third.isError).toBe(true);
    expect(third.text).toMatch(/Rate limit exceeded\. Wait \d+ seconds?/);
  });

  it("nothing, when it repeats what is delivered and stored", async () => {
    const { h } = limited(1);
    const alpha = await h.connect("alpha");
    const first = await callTool(alpha, "mesh_send", { to: "beta", payload: "x", context: CTX });
    for (let i = 0; i < 3; i++) {
      const again = await callTool(alpha, "mesh_send", { to: "beta", payload: "x", context: CTX, message_id: first.json.id });
      expect(again.json.already_delivered, again.text).toBe(true);
    }
  });

  it("mesh_register draws on the same bucket", async () => {
    const { h, clock } = limited(3);
    const alpha = await h.connect("alpha");
    for (let i = 0; i < 3; i++) {
      expect((await callTool(alpha, "mesh_register", { working_on: `task ${i}` })).isError).toBe(false);
    }
    const fourth = await callTool(alpha, "mesh_register", { working_on: "too much" });
    expect(fourth.isError).toBe(true);
    expect(fourth.text).toContain("Rate limit exceeded");
    expect(h.agents.getByName("alpha")!.working_on).toBe("task 2");
    expect((await callTool(alpha, "mesh_send", { to: "beta", payload: "x", context: CTX })).isError).toBe(true);
    clock.now = 20_000; // one token every 20 s at this capacity
    expect((await callTool(alpha, "mesh_register", { working_on: "again" })).isError).toBe(false);
  });

  it("a rename does not hand out a fresh bucket", async () => {
    const { h } = limited(1);
    const alpha = await h.connect("alpha");
    expect((await callTool(alpha, "mesh_send", { to: "beta", payload: "x", context: CTX })).isError).toBe(false);
    h.agents.rename(h.agents.getByName("alpha")!.id, "gamma", "admin");
    const gamma = await h.connect("gamma");
    expect((await callTool(gamma, "mesh_send", { to: "beta", payload: "x", context: CTX })).isError).toBe(true);
  });

  it("reading costs nothing", async () => {
    const { h } = limited(1);
    const alpha = await h.connect("alpha");
    await callTool(alpha, "mesh_send", { to: "beta", payload: "x", context: CTX });
    for (const tool of ["mesh_status", "mesh_receive", "mesh_inbox"]) {
      expect((await callTool(alpha, tool, {})).isError, tool).toBe(false);
    }
  });
});

describe("mesh_history orders a thread like every other place does", () => {
  it("by time, and by arrival when two messages share a millisecond", async () => {
    const h = createHarness();
    h.agents.create("alpha");
    const alpha = await h.connect("alpha");
    const at = new Date().toISOString();
    const insert = h.db.prepare(
      `INSERT INTO messages (id, from_agent, to_agent, type, payload, context, correlation_id, reply_to, priority, ttl_seconds, created_at)
       VALUES (?, 'alpha', 'beta', 'info', ?, 'ctx', ?, NULL, 'normal', 86400, ?)`,
    );
    // The reply sorts BEFORE the root by id, and is found first by the index
    // on correlation_id: only the arrival order puts the root first.
    insert.run("msg_zzz_root", "root", null, at);
    insert.run("msg_aaa_reply", "reply", "msg_zzz_root", at);
    insert.run("msg_aaa_reply2", "second reply", "msg_zzz_root", at);
    const thread = await callTool(alpha, "mesh_history", { correlation_id: "msg_zzz_root" });
    expect((thread.json.messages as { payload: string }[]).map((m) => m.payload)).toEqual(["root", "reply", "second reply"]);
  });
});

// A repeat is only ever of a send of one's OWN. Every send leaves a record of
// the attempt before it is published; a repeat has to match that record, and
// the envelope is rebuilt from it. Without the record, any agent that had
// seen an id whose history row did not exist yet (a delivery_unknown send
// that arrived late, a history_gap send) could publish under it: the broker
// deduplicated, and the history row was then written from the SQUATTER's
// draft. The real sender's repeat was refused for ever, and every later
// reader of a broadcast saw it as the squatter's.
describe("a repeat is of one's own send, and of nothing else", () => {
  let h: Harness;
  let alpha: Client;
  let beta: Client;
  let gamma: Client;

  beforeEach(async () => {
    h = createHarness();
    for (const name of ["alpha", "beta", "gamma"]) h.agents.create(name);
    alpha = await h.connect("alpha");
    beta = await h.connect("beta");
    gamma = await h.connect("gamma");
  });
  const attempts = () => (h.db.prepare("SELECT COUNT(*) AS n FROM send_attempts").get() as { n: number }).n;
  const row = (id: unknown) => h.db.prepare("SELECT from_agent, to_agent, to_key, payload, ttl_seconds, created_at FROM messages WHERE id = ?").get(id) as Record<string, unknown> | undefined;

  it("a recipient that learned the id cannot take it over, and the sender's own repeat still mends the row", async () => {
    h.nats.publishOutcome = "timeout_stored";
    const id = idIn((await callTool(alpha, "mesh_send", { to: "beta", payload: "from alpha", context: CTX })).text);
    h.nats.publishOutcome = "ok";
    // beta reads it (the copy is in the stream) and now knows the id.
    expect(payloadsOf(await callTool(beta, "mesh_receive", {}))).toEqual(["from alpha"]);

    const squat = await callTool(beta, "mesh_send", { to: "gamma", payload: "FORGED", context: CTX, message_id: id });
    expect(squat.isError).toBe(true);
    expect(squat.text).toContain("not an id of a send of yours");
    expect(row(id)).toBeUndefined();
    expect((await callTool(gamma, "mesh_receive", {})).json.messages).toEqual([]);
    expect((await callTool(gamma, "mesh_inbox", {})).json.messages).toEqual([]);

    const mend = await callTool(alpha, "mesh_send", { to: "beta", payload: "from alpha", context: CTX, message_id: id });
    expect(mend.isError, mend.text).toBe(false);
    expect(mend.json.duplicate).toBe(true);
    expect(row(id)).toMatchObject({ from_agent: "alpha", to_agent: "beta", to_key: "beta", payload: "from alpha" });
  });

  it("the same for a broadcast: a reader cannot make it theirs", async () => {
    h.nats.publishOutcome = "timeout_stored";
    const id = idIn((await callTool(alpha, "mesh_send", { to: "broadcast", payload: "to all", context: CTX })).text);
    h.nats.publishOutcome = "ok";
    await callTool(gamma, "mesh_receive", {});
    const squat = await callTool(gamma, "mesh_send", { to: "gamma", payload: "to all", context: CTX, message_id: id });
    expect(squat.isError).toBe(true);
    // beta, reading later, still sees alpha as the sender and answers alpha.
    await callTool(alpha, "mesh_send", { to: "broadcast", payload: "to all", context: CTX, message_id: id });
    const got = await callTool(beta, "mesh_receive", {});
    expect((got.json.messages as { from: string }[]).map((m) => m.from)).toEqual(["alpha"]);
    const answer = await callTool(beta, "mesh_reply", { message_id: id, payload: "hi alpha", context: CTX });
    expect(answer.json.to).toBe("alpha");
  });

  it("refuses to pass other content off as the repeat of an unconfirmed send", async () => {
    h.nats.publishOutcome = "timeout_stored";
    const id = idIn((await callTool(alpha, "mesh_send", { to: "beta", payload: "ORIGINAL", context: CTX, ttl_seconds: 120 })).text);
    h.nats.publishOutcome = "ok";
    for (const other of [{ payload: "CHANGED" }, { to: "gamma" }, { type: "question" }]) {
      const again = await callTool(alpha, "mesh_send", { to: "beta", payload: "ORIGINAL", context: CTX, message_id: id, ...other });
      expect(again.isError, JSON.stringify(other)).toBe(true);
      expect(again.text).toContain("different");
    }
    expect(row(id)).toBeUndefined();
    // The envelope of the repeat is the envelope of the first attempt: same
    // deadline, same moment, whatever the repeat's call said.
    const again = await callTool(alpha, "mesh_send", { to: "beta", payload: "ORIGINAL", context: "later status", message_id: id, ttl_seconds: 600 });
    expect(again.isError, again.text).toBe(false);
    expect(row(id)).toMatchObject({ ttl_seconds: 120 });
    expect(Date.parse(again.json.expires_at as string) - Date.parse(again.json.created_at as string)).toBe(120_000);
    expect(payloadsOf(await callTool(beta, "mesh_receive", {}))).toEqual(["ORIGINAL"]);
  });

  it("refuses any id that is not the caller's, however well-formed, before anything is published", async () => {
    for (const id of ["msg_7ZZZZZZZZZZZZZZZZZZZZZZZZZ", "msg_00000000000000000000000000", "msg_01ARZ3NDEKTSV4RRFFQ69G5FAV"]) {
      const res = await callTool(alpha, "mesh_send", { to: "beta", payload: "x", context: CTX, message_id: id });
      expect(res.isError, id).toBe(true);
      expect(res.text).toContain("not an id of a send of yours");
    }
    expect(h.nats.published).toHaveLength(0);
  });

  it("keeps the record through a repeat the broker refused, so the next repeat still finds it", async () => {
    h.nats.publishOutcome = "timeout_stored";
    const id = idIn((await callTool(alpha, "mesh_send", { to: "beta", payload: "x", context: CTX })).text);
    h.nats.failPublish = true;
    const refused = await callTool(alpha, "mesh_send", { to: "beta", payload: "x", context: CTX, message_id: id });
    expect(refused.text).toContain("not delivered");
    expect(attempts()).toBe(1);
    h.nats.failPublish = false;
    h.nats.publishOutcome = "ok";
    const again = await callTool(alpha, "mesh_send", { to: "beta", payload: "x", context: CTX, message_id: id });
    expect(again.isError, again.text).toBe(false);
    expect(again.json.duplicate).toBe(true);
  });

  it("keeps the record of an attempt only until the history has the row", async () => {
    await callTool(alpha, "mesh_send", { to: "beta", payload: "x", context: CTX });
    expect(attempts()).toBe(0);
    h.nats.publishOutcome = "timeout_lost";
    await callTool(alpha, "mesh_send", { to: "beta", payload: "y", context: CTX });
    expect(attempts()).toBe(1);
    h.nats.publishOutcome = "ok";
    const id = (h.db.prepare("SELECT message_id FROM send_attempts").get() as { message_id: string }).message_id;
    await callTool(alpha, "mesh_send", { to: "beta", payload: "y", context: CTX, message_id: id });
    expect(attempts()).toBe(0);
    expect(row(id)).toMatchObject({ payload: "y" });
  });

  it("answers a repeat of a stored message even when its recipient has gone since", async () => {
    const sent = await callTool(alpha, "mesh_send", { to: "beta", payload: "x", context: CTX });
    h.agents.deleteById(h.agents.getByName("beta")!.id, "admin");
    const again = await callTool(alpha, "mesh_send", { to: "beta", payload: "x", context: CTX, message_id: sent.json.id });
    expect(again.isError, again.text).toBe(false);
    expect(again.json.already_delivered).toBe(true);
  });

  it("says so when the recipient of an unconfirmed send has gone since", async () => {
    h.nats.publishOutcome = "timeout_stored";
    const id = idIn((await callTool(alpha, "mesh_send", { to: "beta", payload: "x", context: CTX })).text);
    h.nats.publishOutcome = "ok";
    h.agents.deleteById(h.agents.getByName("beta")!.id, "admin");
    const again = await callTool(alpha, "mesh_send", { to: "beta", payload: "x", context: CTX, message_id: id });
    expect(again.isError).toBe(true);
    expect(again.text).toMatch(/removed|deactivated/);
  });

  it("a reply's repeat follows the same rule", async () => {
    const question = await callTool(beta, "mesh_send", { to: "alpha", payload: "?", context: CTX });
    h.nats.publishOutcome = "timeout_stored";
    const id = idIn((await callTool(alpha, "mesh_reply", { message_id: question.json.id, payload: "!", context: CTX })).text);
    h.nats.publishOutcome = "ok";
    const squat = await callTool(gamma, "mesh_reply", { message_id: question.json.id, resend_id: id, payload: "!", context: CTX });
    expect(squat.isError).toBe(true);
    expect(squat.text).toContain("not an id of a send of yours");
    const other = await callTool(alpha, "mesh_reply", { message_id: question.json.id, resend_id: id, payload: "changed", context: CTX });
    expect(other.isError).toBe(true);
    expect(other.text).toContain("different");
    const again = await callTool(alpha, "mesh_reply", { message_id: question.json.id, resend_id: id, payload: "!", context: CTX });
    expect(again.isError, again.text).toBe(false);
    expect(again.json.duplicate).toBe(true);
  });

  it("mesh_register draws on the bucket by key: a rename in between changes nothing", async () => {
    const clock = { now: 0 };
    const t = createHarness({ rateLimiter: new RateLimiter(1, 60_000, () => clock.now) });
    t.agents.create("alpha");
    const a = await t.connect("alpha");
    expect((await callTool(a, "mesh_register", { working_on: "x" })).isError).toBe(false);
    t.agents.rename(t.agents.getByName("alpha")!.id, "gamma", "admin");
    const g = await t.connect("gamma");
    expect((await callTool(g, "mesh_register", { working_on: "y" })).isError).toBe(true);
  });

  it("a repeat of a reply to ANOTHER message is not the same message", async () => {
    const q1 = await callTool(beta, "mesh_send", { to: "alpha", payload: "1?", context: CTX });
    const q2 = await callTool(beta, "mesh_send", { to: "alpha", payload: "2?", context: CTX });
    const first = await callTool(alpha, "mesh_reply", { message_id: q1.json.id, payload: "!", context: CTX });
    const again = await callTool(alpha, "mesh_reply", { message_id: q2.json.id, resend_id: first.json.id, payload: "!", context: CTX });
    expect(again.isError).toBe(true);
    expect(again.text).toContain("different");
  });

  it("ownership of a stored row is by key, not by name", async () => {
    // A row with the caller's NAME but another agent's key: not the caller's.
    h.db.prepare(
      `INSERT INTO messages (id, from_agent, to_agent, type, payload, context, correlation_id, reply_to, priority, ttl_seconds, created_at, from_key, to_key)
       VALUES ('msg_01ARZ3NDEKTSV4RRFFQ69G5FAV', 'alpha', 'beta', 'info', 'x', 'ctx', NULL, NULL, 'normal', 86400, ?, 'somebody-else', 'beta')`,
    ).run(new Date().toISOString());
    const res = await callTool(alpha, "mesh_send", { to: "beta", payload: "x", context: CTX, message_id: "msg_01ARZ3NDEKTSV4RRFFQ69G5FAV" });
    expect(res.isError).toBe(true);
    // A row from before keys were stored, with the caller's name: the caller's.
    h.db.prepare(
      `INSERT INTO messages (id, from_agent, to_agent, type, payload, context, correlation_id, reply_to, priority, ttl_seconds, created_at)
       VALUES ('msg_01ARZ3NDEKTSV4RRFFQ69G5FAW', 'alpha', 'beta', 'info', 'x', 'ctx', NULL, NULL, 'normal', 86400, '2026-01-01T00:00:00.000Z')`,
    ).run();
    const old = await callTool(alpha, "mesh_send", { to: "beta", payload: "x", context: CTX, message_id: "msg_01ARZ3NDEKTSV4RRFFQ69G5FAW" });
    expect(old.isError, old.text).toBe(false);
    expect(old.json.already_delivered).toBe(true);
    expect(old.json.created_at).toBe("2026-01-01T00:00:00.000Z");
  });

  it("takes a correlation_id with spaces around it, up to the limit after trimming", async () => {
    const root = await callTool(alpha, "mesh_send", { to: "beta", payload: "x", context: CTX });
    const padded = await callTool(alpha, "mesh_send", { to: "beta", payload: "y", context: CTX, correlation_id: `  ${root.json.id}  ` });
    expect(padded.isError, padded.text).toBe(false);
    expect(padded.json.correlation_id).toBe(root.json.id);
  });
});

describe("what a repeat leaves behind", () => {
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
  const audit = (action: string, id: unknown) =>
    (h.db.prepare("SELECT COUNT(*) AS n FROM activity_log WHERE action = ? AND entity_id = ?").get(action, id) as { n: number }).n;

  it("one message, one 'message_sent' row: a mend of the history did not send anything", async () => {
    h.db.exec("CREATE TRIGGER no_history BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END");
    const sent = await callTool(alpha, "mesh_send", { to: "beta", payload: "delivered anyway", context: CTX });
    expect(sent.json.history_gap).toBe(true);
    h.db.exec("DROP TRIGGER no_history");
    const mend = await callTool(alpha, "mesh_send", { to: "beta", payload: "delivered anyway", context: CTX, message_id: sent.json.id });
    expect(mend.isError, mend.text).toBe(false);
    expect(audit("message_sent", sent.json.id)).toBe(1);
    // The mend is visible as what it is.
    expect(audit("message_stored", sent.json.id)).toBe(1);
  });

  it("the row says what the recipient's copy says: the deadline of the FIRST attempt, not of the repeat", async () => {
    h.nats.publishOutcome = "timeout_stored";
    const first = await callTool(alpha, "mesh_send", { to: "beta", payload: "important", context: CTX, ttl_seconds: 60 });
    const id = idIn(first.text);
    h.nats.publishOutcome = "ok";
    await new Promise((r) => setTimeout(r, 20));
    const again = await callTool(alpha, "mesh_send", { to: "beta", payload: "important", context: CTX, ttl_seconds: 60, message_id: id });
    expect(again.isError, again.text).toBe(false);

    const row = h.db.prepare("SELECT created_at, ttl_seconds FROM messages WHERE id = ?").get(id) as { created_at: string; ttl_seconds: number };
    const envelope = h.nats.published.find((p) => p.msgId === id)!.json as { created_at: string; ttl_seconds: number };
    expect(row.created_at).toBe(envelope.created_at);
    expect(row.ttl_seconds).toBe(envelope.ttl_seconds);
    expect(again.json.created_at).toBe(envelope.created_at);
    expect(Date.parse(again.json.expires_at as string)).toBe(Date.parse(envelope.created_at) + 60_000);
    // And what mesh_inbox shows agrees with it.
    const [inbox] = (await callTool(beta, "mesh_inbox", {})).json.messages as { created_at: string; expires_at: string }[];
    expect(inbox.created_at).toBe(envelope.created_at);
  });
});
