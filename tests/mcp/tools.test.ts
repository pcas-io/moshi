import { describe, it, expect, beforeEach } from "vitest";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createHarness, callTool } from "./harness";
import type { Harness } from "./harness";
import { ADMIN_NOT_AGENT_HINT } from "../../src/mcp/shared";
import { DEFAULT_PREVIEW_CHARS } from "../../src/types";

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
