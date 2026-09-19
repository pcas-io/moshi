import { describe, it, expect, beforeEach } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createHarness, callTool } from "./harness";
import type { Harness } from "./harness";
import { ADMIN_NOT_AGENT_HINT } from "../../src/mcp/shared";
import { DEFAULT_PREVIEW_CHARS, FIELD_LIMITS } from "../../src/types";
import { AGENT_NAME_RE } from "../../src/services/agent";

const CTX = "test context";

describe("MCP tools — agent identity", () => {
  let h: Harness;
  let alpha: Client;

  beforeEach(async () => {
    h = createHarness();
    h.agents.create("alpha");
    h.agents.create("beta");
    alpha = await h.connect("alpha");
  });

  it("mesh_send defaults type to info and reports inbox_pending (A7, A4)", async () => {
    h.nats.enqueue("alpha", { id: "msg_x", from: "beta", to: "alpha", type: "info", payload: "hi", context: CTX, correlation_id: null, reply_to: null, priority: "normal", ttl_seconds: 86400, created_at: new Date().toISOString() });
    const res = await callTool(alpha, "mesh_send", { to: "beta", payload: "hello", context: CTX });
    expect(res.isError).toBe(false);
    expect(res.json.type).toBe("info");
    expect(res.json.inbox_pending).toBe(1);
    expect(res.json.hint).toBeUndefined();
    expect(h.nats.published[0].subject).toBe("mesh.agents.beta.inbox");
  });

  it("mesh_send hints on a non-recommended type but still delivers", async () => {
    const res = await callTool(alpha, "mesh_send", { to: "beta", type: "questoin", payload: "?", context: CTX });
    expect(res.isError).toBe(false);
    expect(res.json.type).toBe("questoin");
    expect(String(res.json.hint)).toContain("not a recommended type");
    expect(h.nats.published).toHaveLength(1);
  });

  it("mesh_send rejects unknown recipients with a next step", async () => {
    const res = await callTool(alpha, "mesh_send", { to: "nobody", payload: "x", context: CTX });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("mesh_status");
  });

  it("mesh_send reports inbox_pending=null when NATS cannot be asked", async () => {
    h.nats.failPending = true;
    const res = await callTool(alpha, "mesh_send", { to: "beta", payload: "x", context: CTX });
    expect(res.isError).toBe(false);
    expect(res.json.inbox_pending).toBeNull();
  });

  it("mesh_receive acks everything it returns and reports the remainder (A3, A4)", async () => {
    const beta = await h.connect("beta");
    for (let i = 0; i < 3; i++) {
      await callTool(alpha, "mesh_send", { to: "beta", payload: `m${i}`, context: CTX, type: i === 1 ? "question" : "info" });
    }
    const res = await callTool(beta, "mesh_receive", { limit: 2 });
    expect(res.isError).toBe(false);
    expect(res.json.count).toBe(2);
    expect(res.json.inbox_pending).toBe(1);
    expect(h.nats.acked).toBe(2);
    const rest = await callTool(beta, "mesh_receive", {});
    expect(rest.json.count).toBe(1);
    expect(rest.json.inbox_pending).toBe(0);
    const empty = await callTool(beta, "mesh_receive", {});
    expect(empty.json.messages).toEqual([]);
    expect(empty.json.hint).toBe("No new messages.");
  });

  it("mesh_receive no longer accepts a type filter (A3)", async () => {
    const tools = await alpha.listTools();
    const receive = tools.tools.find((t) => t.name === "mesh_receive");
    expect(receive).toBeDefined();
    const props = Object.keys((receive!.inputSchema as { properties?: Record<string, unknown> }).properties ?? {});
    expect(props.sort()).toEqual(["limit", "preview_chars"]);
  });

  it("mesh_receive previews long payloads and points to mesh_get (A5)", async () => {
    const beta = await h.connect("beta");
    const long = "x".repeat(DEFAULT_PREVIEW_CHARS + 500);
    const sent = await callTool(alpha, "mesh_send", { to: "beta", payload: long, context: CTX });
    const res = await callTool(beta, "mesh_receive", {});
    const msg = (res.json.messages as Record<string, unknown>[])[0];
    expect(msg.payload_truncated).toBe(true);
    expect(msg.payload_length).toBe(long.length);
    expect((msg.payload as string).length).toBe(DEFAULT_PREVIEW_CHARS);
    expect(String(res.json.hint)).toContain("mesh_get");

    const full = await callTool(beta, "mesh_get", { message_id: sent.json.id });
    expect(full.isError).toBe(false);
    expect(full.json.payload).toBe(long);
  });

  it("mesh_receive honours preview_chars and leaves short payloads untouched", async () => {
    const beta = await h.connect("beta");
    await callTool(alpha, "mesh_send", { to: "beta", payload: "short", context: CTX });
    const res = await callTool(beta, "mesh_receive", { preview_chars: 100 });
    const msg = (res.json.messages as Record<string, unknown>[])[0];
    expect(msg.payload).toBe("short");
    expect(msg.payload_truncated).toBe(false);
    expect(res.json.hint).toBeUndefined();
  });

  it("mesh_get reports unknown ids as an error", async () => {
    const res = await callTool(alpha, "mesh_get", { message_id: "msg_nope" });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("not found");
  });

  it("mesh_reply keeps the thread, defaults type to reply and accepts a custom type (A9)", async () => {
    const beta = await h.connect("beta");
    const root = await callTool(alpha, "mesh_send", { to: "beta", type: "review_request", payload: "please review", context: CTX });
    const reply = await callTool(beta, "mesh_reply", { message_id: root.json.id as string, payload: "lgtm", context: CTX });
    expect(reply.json.type).toBe("reply");
    expect(reply.json.correlation_id).toBe(root.json.id);
    // beta never pulled the root message — it is still waiting for beta.
    expect(reply.json.inbox_pending).toBe(1);

    const typed = await callTool(beta, "mesh_reply", { message_id: root.json.id as string, payload: "approved", context: CTX, type: "review_result" });
    expect(typed.json.type).toBe("review_result");
  });

  it("mesh_history resolves the thread from a reply id (A8)", async () => {
    const beta = await h.connect("beta");
    const root = await callTool(alpha, "mesh_send", { to: "beta", payload: "q", context: CTX });
    const reply = await callTool(beta, "mesh_reply", { message_id: root.json.id as string, payload: "a", context: CTX });
    const viaReply = await callTool(alpha, "mesh_history", { correlation_id: reply.json.id as string });
    expect(viaReply.json.count).toBe(2);
    expect(viaReply.json.thread_id).toBe(root.json.id);
    const viaRoot = await callTool(alpha, "mesh_history", { correlation_id: root.json.id as string });
    expect(viaRoot.json.count).toBe(2);
  });

  it("mesh_register persists metadata in SQLite and mesh_status reads it back (D4)", async () => {
    const reg = await callTool(alpha, "mesh_register", { role: "reviewer", capabilities: ["review"], working_on: "top5" });
    expect(reg.json.registered).toBe(true);
    expect(reg.json.inbox_pending).toBe(0);
    // A bare liveness touch must not wipe the metadata.
    await h.presence.touch("alpha");
    const status = await callTool(alpha, "mesh_status", {});
    const me = (status.json.agents as Record<string, unknown>[]).find((a) => a.name === "alpha")!;
    expect(me.role).toBe("reviewer");
    expect(me.capabilities).toEqual(["review"]);
    expect(me.working_on).toBe("top5");
    expect(me.presence).toBe("live");
    expect(status.json.inbox_pending).toBe(0);
    expect(h.nats.kv.get("alpha")).toEqual({ timestamp: expect.any(String) });
  });
});

describe("MCP tools — rename keeps the address", () => {
  let h: Harness;
  let alpha: Client;
  let betaId: string;

  beforeEach(async () => {
    h = createHarness();
    h.agents.create("alpha");
    betaId = h.agents.create("beta").agent.id;
    alpha = await h.connect("alpha");
  });

  it("delivers mail sent before the rename to the agent under its new name", async () => {
    await callTool(alpha, "mesh_send", { to: "beta", payload: "sent before the rename", context: CTX });
    h.agents.rename(betaId, "gamma");
    const gamma = await h.connect("gamma");
    const res = await callTool(gamma, "mesh_receive", {});
    expect(res.isError).toBe(false);
    expect(res.json.count).toBe(1);
    expect((res.json.messages as { payload: string }[])[0].payload).toBe("sent before the rename");
  });

  it("routes new mail for the new name to the unchanged inbox", async () => {
    h.agents.rename(betaId, "gamma");
    const res = await callTool(alpha, "mesh_send", { to: "gamma", payload: "hello gamma", context: CTX });
    expect(res.isError).toBe(false);
    expect(res.json.to).toBe("gamma");
    expect(h.nats.published[0].subject).toBe("mesh.agents.beta.inbox");
    const gamma = await h.connect("gamma");
    expect((await callTool(gamma, "mesh_receive", {})).json.count).toBe(1);
  });

  it("no longer knows the old name", async () => {
    h.agents.rename(betaId, "gamma");
    const res = await callTool(alpha, "mesh_send", { to: "beta", payload: "x", context: CTX });
    expect(res.isError).toBe(true);
    expect(h.nats.published).toHaveLength(0);
  });

  it("lets a reply reach a sender who was renamed after writing", async () => {
    const beta = await h.connect("beta");
    const sent = await callTool(beta, "mesh_send", { to: "alpha", payload: "question from beta", context: CTX });
    h.agents.rename(betaId, "gamma");
    const reply = await callTool(alpha, "mesh_reply", { message_id: String(sent.json.id), payload: "answer", context: CTX });
    expect(reply.isError).toBe(false);
    expect(reply.json.to).toBe("gamma");
    expect(h.nats.published.at(-1)?.subject).toBe("mesh.agents.beta.inbox");
    const gamma = await h.connect("gamma");
    const inbox = await callTool(gamma, "mesh_receive", {});
    expect((inbox.json.messages as { payload: string }[]).map((m) => m.payload)).toEqual(["answer"]);
  });

  it("shows current names on mail that was waiting through a rename", async () => {
    const beta = await h.connect("beta");
    await callTool(beta, "mesh_send", { to: "alpha", payload: "written as beta", context: CTX });
    h.agents.rename(betaId, "gamma");
    const inbox = await callTool(alpha, "mesh_receive", {});
    const [msg] = inbox.json.messages as { from: string; to: string; payload: string }[];
    // The JetStream copy still says "beta". An agent that answers by name
    // would be told the sender does not exist.
    expect(msg.from).toBe("gamma");
    expect(msg.payload).toBe("written as beta");
  });

  it("refuses to guess an inbox for an identity without an agent record", async () => {
    await expect(h.connect("nobody-by-that-name")).rejects.toThrow(/no agent record/i);
  });

  it("stores the canonical recipient name, whatever case the sender typed", async () => {
    const res = await callTool(alpha, "mesh_send", { to: "BETA", payload: "x", context: CTX });
    expect(res.json.to).toBe("beta");
    const row = h.db.prepare("SELECT to_agent FROM messages WHERE id = ?").get(String(res.json.id));
    expect(row).toEqual({ to_agent: "beta" });
  });
});

describe("MCP tools — mesh_reply checks the recipient", () => {
  let h: Harness;
  let alpha: Client;
  let betaId: string;
  let messageId: string;

  beforeEach(async () => {
    h = createHarness();
    h.agents.create("alpha");
    betaId = h.agents.create("beta").agent.id;
    alpha = await h.connect("alpha");
    const beta = await h.connect("beta");
    const sent = await callTool(beta, "mesh_send", { to: "alpha", payload: "ping", context: CTX });
    messageId = String(sent.json.id);
    h.nats.published.length = 0;
  });

  it("refuses a reply to a deleted sender instead of reporting it delivered", async () => {
    h.agents.deleteById(betaId);
    const res = await callTool(alpha, "mesh_reply", { message_id: messageId, payload: "pong", context: CTX });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("mesh_status");
    expect(h.nats.published).toHaveLength(0);
  });

  it("refuses a reply to a deactivated sender", async () => {
    h.agents.revokeById(betaId);
    const res = await callTool(alpha, "mesh_reply", { message_id: messageId, payload: "pong", context: CTX });
    expect(res.isError).toBe(true);
    expect(h.nats.published).toHaveLength(0);
  });
});

describe("MCP tools — field bounds", () => {
  // Only the 512 KB body limit capped these. A 500 KB `working_on` is echoed
  // to every agent in every mesh_status reply and rendered on every page load.
  let h: Harness;
  let alpha: Client;
  beforeEach(async () => {
    h = createHarness();
    h.agents.create("alpha");
    h.agents.create("beta");
    alpha = await h.connect("alpha");
  });

  const send = (extra: Record<string, unknown>) =>
    callTool(alpha, "mesh_send", { to: "beta", payload: "x", context: CTX, ...extra });

  it("rejects an oversized type and an oversized correlation_id", async () => {
    expect((await send({ type: "t".repeat(65) })).isError).toBe(true);
    expect((await send({ correlation_id: "c".repeat(65) })).isError).toBe(true);
    expect((await send({ type: "t".repeat(64) })).isError).toBe(false);
  });

  it("wants ttl_seconds as a positive whole number within the stream's seven days", async () => {
    for (const ttl of [-5, 0, 1.5, 604801]) expect((await send({ ttl_seconds: ttl })).isError, String(ttl)).toBe(true);
    expect((await send({ ttl_seconds: 3600 })).isError).toBe(false);
  });

  it("wants whole-number limits", async () => {
    expect((await callTool(alpha, "mesh_receive", { limit: 2.5 })).isError).toBe(true);
    expect((await callTool(alpha, "mesh_history", { limit: 2.5 })).isError).toBe(true);
  });

  it("bounds what mesh_register announces", async () => {
    const reg = (args: Record<string, unknown>) => callTool(alpha, "mesh_register", args);
    expect((await reg({ working_on: "w".repeat(513) })).isError).toBe(true);
    expect((await reg({ role: "r".repeat(65) })).isError).toBe(true);
    expect((await reg({ capabilities: Array.from({ length: 33 }, (_, i) => `c${i}`) })).isError).toBe(true);
    expect((await reg({ capabilities: ["c".repeat(65)] })).isError).toBe(true);
    expect((await reg({ role: "dev", working_on: "fine", capabilities: ["ts"] })).isError).toBe(false);
  });

  // The rejecting side alone would stay green if every limit shrank to 10.
  // These pin the accepting side at exactly the documented values.
  it("accepts every mesh_register field at exactly its limit", async () => {
    const res = await callTool(alpha, "mesh_register", {
      role: "r".repeat(FIELD_LIMITS.ROLE),
      working_on: "w".repeat(FIELD_LIMITS.WORKING_ON),
      capabilities: Array.from({ length: FIELD_LIMITS.CAPABILITIES }, (_, i) =>
        String(i).padStart(FIELD_LIMITS.CAPABILITY, "c")),
    });
    expect(res.isError, res.text).toBe(false);
    const row = h.agents.getByName("alpha")!;
    expect(row.role).toHaveLength(64);
    expect(row.working_on).toHaveLength(512);
    const stored = JSON.parse(row.capabilities!) as string[];
    expect(stored).toHaveLength(32);
    expect(stored[0]).toHaveLength(64); // not FIELD_LIMITS.CAPABILITY: that would shrink with the constant
  });

  it("accepts a ttl of one second and of exactly seven days", async () => {
    expect(FIELD_LIMITS.TTL_SECONDS_MAX).toBe(7 * 24 * 60 * 60);
    for (const ttl of [1, FIELD_LIMITS.TTL_SECONDS_MAX]) {
      const res = await send({ ttl_seconds: ttl });
      expect(res.isError, `${ttl}: ${res.text}`).toBe(false);
    }
  });

  it("reaches the longest legal agent name, and the name rule and the tool limit agree", async () => {
    const longest = "a".repeat(FIELD_LIMITS.AGENT_NAME);
    expect(AGENT_NAME_RE.test(longest)).toBe(true);
    expect(AGENT_NAME_RE.test(longest + "a")).toBe(false);
    h.agents.create(longest);
    const to = (name: string) => callTool(alpha, "mesh_send", { to: name, payload: "x", context: CTX });
    expect((await to(longest)).isError).toBe(false);
    expect((await to(longest + "a")).isError).toBe(true);
  });

  it("publishes nothing when a bound rejects the send", async () => {
    const before = h.nats.published.length;
    await send({ ttl_seconds: FIELD_LIMITS.TTL_SECONDS_MAX + 1 });
    await send({ type: "t".repeat(FIELD_LIMITS.TYPE + 1) });
    await send({ correlation_id: "c".repeat(FIELD_LIMITS.ID + 1) });
    expect(h.nats.published).toHaveLength(before);
  });

  it("lets a real message id through every tool that takes one", async () => {
    const sent = await send({});
    const id = sent.json["id"] as string;
    expect(id.length).toBeLessThanOrEqual(FIELD_LIMITS.ID);

    expect((await callTool(alpha, "mesh_get", { message_id: id })).isError).toBe(false);
    expect((await callTool(alpha, "mesh_history", { correlation_id: id })).isError).toBe(false);
    expect((await send({ correlation_id: id })).isError).toBe(false);
    const beta = await h.connect("beta");
    const reply = await callTool(beta, "mesh_reply", { message_id: id, payload: "y", context: CTX });
    expect(reply.isError, reply.text).toBe(false);

    // An id of exactly 64 characters is still a legal thread reference.
    expect((await send({ correlation_id: "c".repeat(64) })).isError).toBe(false);

    const tooLong = "m".repeat(FIELD_LIMITS.ID + 1);
    expect((await callTool(alpha, "mesh_get", { message_id: tooLong })).isError).toBe(true);
    expect((await callTool(alpha, "mesh_history", { correlation_id: tooLong })).isError).toBe(true);
    expect((await callTool(beta, "mesh_reply", { message_id: tooLong, payload: "y", context: CTX })).isError).toBe(true);
  });
});

describe("MCP tools — admin identity (A1)", () => {
  let h: Harness;
  let admin: Client;

  beforeEach(async () => {
    h = createHarness();
    h.agents.create("alpha");
    admin = await h.connect("admin", { isAdmin: true });
  });

  it.each(["mesh_register", "mesh_receive"])("%s is refused with the onboarding hint", async (tool) => {
    const res = await callTool(admin, tool, {});
    expect(res.isError).toBe(true);
    expect(res.text).toBe(ADMIN_NOT_AGENT_HINT);
    expect(res.text).toContain("/agents");
  });

  it("mesh_send and mesh_reply are refused before anything is published", async () => {
    const send = await callTool(admin, "mesh_send", { to: "alpha", payload: "x", context: CTX });
    expect(send.isError).toBe(true);
    const reply = await callTool(admin, "mesh_reply", { message_id: "msg_x", payload: "x", context: CTX });
    expect(reply.isError).toBe(true);
    expect(h.nats.published).toEqual([]);
  });

  it("read-only tools keep working, with inbox_pending=null", async () => {
    const status = await callTool(admin, "mesh_status", {});
    expect(status.isError).toBe(false);
    expect((status.json.agents as unknown[]).length).toBe(1);
    expect(status.json.inbox_pending).toBeNull();
    const history = await callTool(admin, "mesh_history", { correlation_id: "msg_none" });
    expect(history.isError).toBe(false);
  });
});
