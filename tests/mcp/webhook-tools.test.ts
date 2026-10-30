// mesh_webhook_set / _get / _delete through a real McpServer, and what the
// other tools do with a hook: mesh_send queues the call, mesh_status shows the
// state and nothing else.

import { describe, it, expect, beforeEach } from "vitest";
import { createHarness, callTool } from "./harness";
import type { Harness } from "./harness";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

const URL_ = "https://hooks.example.com/trigger/kate";
const WHSEC = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";

let h: Harness;
let kate: Client;
let worky: Client;

const deliveries = () => h.db.prepare("SELECT agent_key FROM webhook_deliveries").all() as { agent_key: string }[];

beforeEach(async () => {
  h = createHarness();
  h.agents.create("kate");
  h.agents.create("worky");
  kate = await h.connect("kate");
  worky = await h.connect("worky");
});

describe("mesh_webhook_set", () => {
  it("makes a secret, shows it once, and never again", async () => {
    const set = await callTool(kate, "mesh_webhook_set", { url: URL_ });
    expect(set.isError).toBe(false);
    expect(set.json.secret).toMatch(/^whsec_/);
    expect(set.json.webhook).toMatchObject({ url: URL_, auth_mode: "standard_webhooks", state: "active", include_broadcasts: false });
    expect(set.json).toHaveProperty("inbox_pending");

    const get = await callTool(kate, "mesh_webhook_get");
    expect(get.text).not.toContain((set.json.secret as string).slice(6));
    expect(get.json.webhook).toMatchObject({ url: URL_, state: "active", pending: null });
  });

  it("takes the receiver's whsec_ secret and does not echo it", async () => {
    const set = await callTool(kate, "mesh_webhook_set", { url: URL_, secret: WHSEC });
    expect(set.isError).toBe(false);
    expect(set.json).not.toHaveProperty("secret");
    expect(set.text).not.toContain(WHSEC.slice(6));
  });

  it("tells the kind of key by its form: whsec_ is signed, anything else is a bearer key", async () => {
    const signed = await callTool(kate, "mesh_webhook_set", { url: URL_, secret: WHSEC });
    expect(signed.json.webhook).toMatchObject({ auth_mode: "standard_webhooks" });
    const bearer = await callTool(kate, "mesh_webhook_set", { url: URL_, secret: "grok-sender-key-0123456789" });
    expect(bearer.isError).toBe(false);
    expect(bearer.json.webhook).toMatchObject({ auth_mode: "bearer" });
    const made = await callTool(kate, "mesh_webhook_set", { url: URL_ });
    expect(made.json.webhook).toMatchObject({ auth_mode: "standard_webhooks" });
    expect(made.json.secret).toMatch(/^whsec_/);
  });

  it("still lets auth_mode force the kind", async () => {
    const forced = await callTool(kate, "mesh_webhook_set", { url: URL_, auth_mode: "standard_webhooks", secret: "grok-sender-key-0123456789" });
    expect(forced.text).toMatch(/^secret: a signing secret is/);
  });

  it("refuses the acceptance criteria's targets: http, localhost, 127.0.0.1, 10.x, 169.254.x", async () => {
    for (const url of [
      "http://hooks.example.com/t",
      "https://localhost/t",
      "https://127.0.0.1/t",
      "https://10.0.0.8/t",
      "https://169.254.169.254/latest",
    ]) {
      const r = await callTool(kate, "mesh_webhook_set", { url });
      expect(r.isError, url).toBe(true);
      expect(r.text).toMatch(/^url refused: /);
    }
    expect((await callTool(kate, "mesh_webhook_get")).json.webhook).toBeNull();
  });

  it("refuses a name that resolves to a private address, and one that does not resolve", async () => {
    h.dns.set("inner.example.com", ["10.0.0.5"]);
    const inner = await callTool(kate, "mesh_webhook_set", { url: "https://inner.example.com/t" });
    expect(inner.text).toContain("not public");
    const gone = await callTool(kate, "mesh_webhook_set", { url: "https://gone.example.com/t" });
    expect(gone.text).toContain("could not be resolved");
  });

  it("refuses a malformed secret and a bearer mode without a key", async () => {
    expect((await callTool(kate, "mesh_webhook_set", { url: URL_, secret: "hunter2" })).text).toMatch(/^secret: /);
    expect((await callTool(kate, "mesh_webhook_set", { url: URL_, auth_mode: "bearer" })).text).toMatch(/^secret: .*required/);
    const bearer = await callTool(kate, "mesh_webhook_set", { url: URL_, auth_mode: "bearer", secret: "grok-sender-key-0123456789" });
    expect(bearer.isError).toBe(false);
    expect(bearer.json.webhook).toMatchObject({ auth_mode: "bearer" });
  });

  it("is refused for the admin token", async () => {
    const admin = await h.connect("admin", { isAdmin: true });
    for (const tool of ["mesh_webhook_set", "mesh_webhook_get", "mesh_webhook_delete"]) {
      const r = await callTool(admin, tool, tool === "mesh_webhook_set" ? { url: URL_ } : {});
      expect(r.isError, tool).toBe(true);
      expect(r.text).toMatch(/^admin_token_is_not_an_agent/);
    }
  });
});

describe("sending to an agent with a hook", () => {
  it("queues one call for the recipient, and none for a repeat the broker deduplicated", async () => {
    await callTool(kate, "mesh_webhook_set", { url: URL_ });
    const first = await callTool(worky, "mesh_send", { to: "kate", payload: "hi", context: "test" });
    await callTool(worky, "mesh_send", { to: "kate", payload: "again", context: "test" });
    expect(deliveries()).toEqual([{ agent_key: "kate" }]);
    expect((await callTool(kate, "mesh_webhook_get")).json.webhook).toMatchObject({ pending: { messages: 2 } });

    // The same send again under its id: the broker answers "duplicate".
    await callTool(worky, "mesh_send", { to: "kate", payload: "hi", context: "test", message_id: first.json.id });
    expect((await callTool(kate, "mesh_webhook_get")).json.webhook).toMatchObject({ pending: { messages: 2 } });
  });

  it("queues nothing when the send failed", async () => {
    await callTool(kate, "mesh_webhook_set", { url: URL_ });
    h.nats.failPublish = true;
    const r = await callTool(worky, "mesh_send", { to: "kate", payload: "hi", context: "test" });
    expect(r.isError).toBe(true);
    expect(deliveries()).toEqual([]);
  });

  it("queues a reply for the agent it goes to", async () => {
    await callTool(worky, "mesh_webhook_set", { url: "https://hooks.example.com/worky" });
    const sent = await callTool(worky, "mesh_send", { to: "kate", payload: "question", context: "test" });
    await callTool(kate, "mesh_reply", { message_id: sent.json.id, payload: "answer", context: "test" });
    expect(deliveries()).toEqual([{ agent_key: "worky" }]);
  });
});

describe("mesh_status and mesh_webhook_delete", () => {
  it("shows every agent's hook state, but not its URL", async () => {
    await callTool(kate, "mesh_webhook_set", { url: URL_ });
    const status = await callTool(worky, "mesh_status");
    const agents = status.json.agents as { name: string; webhook: unknown }[];
    expect(agents.find((a) => a.name === "kate")?.webhook).toEqual({ state: "active", last_success_at: null, last_failure_at: null });
    expect(agents.find((a) => a.name === "worky")?.webhook).toBeNull();
    expect(status.text).not.toContain("hooks.example.com");
  });

  it("removes the hook and what it had waiting", async () => {
    await callTool(kate, "mesh_webhook_set", { url: URL_ });
    await callTool(worky, "mesh_send", { to: "kate", payload: "hi", context: "test" });
    expect((await callTool(kate, "mesh_webhook_delete")).json).toMatchObject({ deleted: true });
    expect(deliveries()).toEqual([]);
    expect((await callTool(kate, "mesh_webhook_delete")).json).toMatchObject({ deleted: false });
  });
});
