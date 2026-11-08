// The agent lifecycle as an audit (ocellio e49547b8), through the real app:
// every door writes one row with the right actor, target and origin, a row
// can be found by the agent it is about, and no token reaches a row or a line.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestApp, signIn, csrfFor, formPost, ADMIN_TOKEN, MCP_HEADERS, rpc } from "./harness";
import type { TestApp } from "./harness";
import { hashIP } from "../../src/auth";
import type { Agent } from "../../src/types";

const NOW = Date.parse("2026-11-07T12:00:00.000Z");
const CLIENT = "203.0.113.7";
const FROM_CLIENT = { "X-Forwarded-For": CLIENT };
const ADMIN = { Authorization: `Bearer ${ADMIN_TOKEN}`, "Content-Type": "application/json", ...FROM_CLIENT };

interface Row {
  action: string;
  entity_type: string;
  entity_id: string;
  agent_name: string | null;
  target_key: string | null;
  origin: string | null;
  ip_hash: string | null;
  detail_json: string | null;
}

let t: TestApp;
let lines: Record<string, unknown>[];

beforeEach(() => {
  t = createTestApp({}, { now: () => NOW });
  lines = [];
  const take = (line: unknown) => { try { lines.push(JSON.parse(String(line))); } catch { /* not ours */ } };
  vi.spyOn(console, "log").mockImplementation(take);
  vi.spyOn(console, "error").mockImplementation(take);
  vi.spyOn(console, "warn").mockImplementation(take);
});
afterEach(() => { vi.restoreAllMocks(); });

const rowsOf = (action: string) =>
  t.h.db.prepare("SELECT * FROM activity_log WHERE action = ? ORDER BY rowid").all(action) as Row[];
const onlyRow = (action: string) => {
  const rows = rowsOf(action);
  expect(rows).toHaveLength(1);
  return rows[0];
};
const auditLines = (event: string) => lines.filter((l) => l.msg === "audit" && l.event === event);
const everything = () => JSON.stringify(t.h.db.prepare("SELECT * FROM activity_log").all()) + JSON.stringify(lines);

const adminPost = (path: string, body?: unknown) =>
  t.app.request(path, { method: "POST", headers: ADMIN, body: body === undefined ? undefined : JSON.stringify(body) });

async function dashboardForm(path: string, fields: Record<string, string>) {
  const { cookie } = await signIn(t.app, ADMIN_TOKEN);
  return t.app.request(path, formPost({ csrf: csrfFor(cookie), ...fields }, { Cookie: cookie, ...FROM_CLIENT }));
}

async function mint() {
  const res = await adminPost("/api/admin/registration-tokens", { label: "anna laptop", name_prefix: "anna-" });
  expect(res.status).toBe(201);
  return (await res.json()) as { registration_token: { id: string }; token: string };
}

function registerWith(token: string, name: string) {
  return t.app.request("/api/register/agents", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...FROM_CLIENT },
    body: JSON.stringify({ name }),
  });
}

function meshRegister(token: string, args: Record<string, unknown>) {
  return t.app.request("/mcp", {
    method: "POST",
    headers: { ...MCP_HEADERS, Authorization: `Bearer ${token}`, ...FROM_CLIENT },
    body: rpc("tools/call", { name: "mesh_register", arguments: args }),
  });
}

const agentNamed = (name: string) => t.h.agents.getByName(name) as Agent;

describe("one row per door: actor, target, origin, address", () => {
  it("the dashboard", async () => {
    const res = await dashboardForm("/agents/create", { name: "Scout" });
    expect(res.status).toBe(302);
    expect(onlyRow("agent_created")).toMatchObject({
      entity_id: agentNamed("Scout").id, agent_name: "admin", target_key: "scout", origin: "dashboard", ip_hash: hashIP(CLIENT),
    });
    expect(auditLines("agent_created")).toEqual([
      expect.objectContaining({ actor: "admin", target: "scout", origin: "dashboard" }),
    ]);
  });

  it("the admin API", async () => {
    const res = await adminPost("/api/admin/agents", { name: "scout" });
    expect(res.status).toBe(201);
    expect(onlyRow("agent_created")).toMatchObject({
      agent_name: "admin:api", target_key: "scout", origin: "admin_api", ip_hash: hashIP(CLIENT),
    });
    expect(auditLines("agent_created")).toEqual([
      expect.objectContaining({ actor: "admin:api", target: "scout", origin: "admin_api" }),
    ]);
  });

  it("the register route", async () => {
    const { registration_token, token } = await mint();
    expect((await registerWith(token, "anna-vibe")).status).toBe(201);
    expect(onlyRow("agent_created")).toMatchObject({
      agent_name: `register:${registration_token.id}`, target_key: "anna-vibe", origin: "register", ip_hash: hashIP(CLIENT),
    });
    expect(auditLines("agent_created")).toEqual([
      expect.objectContaining({ actor: `register:${registration_token.id}`, target: "anna-vibe", origin: "register" }),
    ]);
  });

  it("the connect page", async () => {
    const res = await dashboardForm("/agents/connect/create", { name: "scout" });
    expect(res.status).toBe(302);
    expect(onlyRow("agent_created")).toMatchObject({
      agent_name: "admin", target_key: "scout", origin: "connect", ip_hash: hashIP(CLIENT),
    });
    expect(auditLines("agent_created")).toEqual([
      expect.objectContaining({ actor: "admin", target: "scout", origin: "connect" }),
    ]);
  });
});

describe("the rest of the lifecycle", () => {
  it("writes revoke, reactivate, reset and delete with target and origin", async () => {
    const { id } = t.h.agents.create("scout").agent;
    await adminPost("/api/admin/agents/scout/revoke");
    await adminPost("/api/admin/agents/scout/reactivate");
    await adminPost("/api/admin/agents/scout/reset-token");
    await dashboardForm("/agents/delete", { id });
    for (const [action, actor, origin] of [
      ["agent_revoked", "admin:api", "admin_api"],
      ["agent_reactivated", "admin:api", "admin_api"],
      ["agent_token_reset", "admin:api", "admin_api"],
      ["agent_deleted", "admin", "dashboard"],
    ]) {
      expect(onlyRow(action!)).toMatchObject({ entity_id: id, agent_name: actor, target_key: "scout", origin, ip_hash: hashIP(CLIENT) });
      expect(auditLines(action!)).toHaveLength(1);
    }
  });

  it("writes the old and the new name for a rename", async () => {
    const { id } = t.h.agents.create("scout").agent;
    await dashboardForm("/agents/rename", { id, name: "ranger" });
    const row = onlyRow("agent_renamed");
    expect(row).toMatchObject({ agent_name: "admin", target_key: "scout", origin: "dashboard" });
    expect(JSON.parse(row.detail_json!)).toEqual({ old: { name: "scout" }, new: { name: "ranger" } });
  });

  it("carries the caller through to the webhook a token reset removes", async () => {
    t.h.agents.create("scout");
    t.h.webhooks.set("scout", { url: "https://hooks.example.com/t", authMode: "standard_webhooks", includeBroadcasts: false, types: null, minPriority: "low" }, undefined, "admin");
    await adminPost("/api/admin/agents/scout/reset-token");
    expect(onlyRow("webhook_deleted")).toMatchObject({
      agent_name: "admin:api", target_key: "scout", origin: "admin_api", ip_hash: hashIP(CLIENT),
    });
    expect(auditLines("webhook_deleted")).toHaveLength(1);
  });

  it("keeps every new token out of rows and lines", async () => {
    t.h.agents.create("scout");
    const reset = (await (await adminPost("/api/admin/agents/scout/reset-token")).json()) as { token: string };
    await adminPost("/api/admin/agents/scout/revoke");
    const back = (await (await adminPost("/api/admin/agents/scout/reactivate")).json()) as { token: string };
    expect(onlyRow("agent_token_reset").detail_json).toBeNull();
    expect(everything()).not.toContain(reset.token);
    expect(everything()).not.toContain(back.token);
  });
});

describe("agent_profile_changed", () => {
  it("writes old and new when mesh_register changes role and capabilities", async () => {
    const { plaintextToken } = t.h.agents.create("scout");
    await meshRegister(plaintextToken, { role: "deploy", capabilities: ["a"] });
    await meshRegister(plaintextToken, { role: "review", capabilities: ["a", "b"] });

    const rows = rowsOf("agent_profile_changed");
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ agent_name: "scout", target_key: "scout", origin: "presence", ip_hash: hashIP(CLIENT) });
    expect(JSON.parse(rows[0].detail_json!)).toEqual({
      old: { role: null, capabilities: null }, new: { role: "deploy", capabilities: ["a"] },
    });
    expect(JSON.parse(rows[1].detail_json!)).toEqual({
      old: { role: "deploy", capabilities: ["a"] }, new: { role: "review", capabilities: ["a", "b"] },
    });
    expect(auditLines("agent_profile_changed")[1]).toMatchObject({ actor: "scout", target: "scout", origin: "presence" });
  });

  it("names only the field that changed", async () => {
    const { plaintextToken } = t.h.agents.create("scout");
    await meshRegister(plaintextToken, { role: "deploy", capabilities: ["a"] });
    await meshRegister(plaintextToken, { role: "review", capabilities: ["a"] });
    expect(JSON.parse(rowsOf("agent_profile_changed")[1].detail_json!)).toEqual({ old: { role: "deploy" }, new: { role: "review" } });
  });

  it("writes nothing for the same values, for working_on alone, or for a bare touch", async () => {
    const { plaintextToken } = t.h.agents.create("scout");
    await meshRegister(plaintextToken, { role: "deploy", capabilities: ["a"] });
    await meshRegister(plaintextToken, { role: "deploy", capabilities: ["a"], working_on: "delivering x" });
    await meshRegister(plaintextToken, { working_on: "delivering y" });
    await t.h.presence.touch("scout");
    expect(rowsOf("agent_profile_changed")).toHaveLength(1);
  });
});

describe("?agent= finds what happened TO an agent", () => {
  const found = (name: string) => t.h.activity.list({ agent_name: name, limit: 50, offset: 0 }).data.map((r) => r.action);

  it("finds created and deleted, although the operator did both", async () => {
    await dashboardForm("/agents/create", { name: "scout" });
    await dashboardForm("/agents/delete", { id: agentNamed("scout").id });
    await dashboardForm("/agents/create", { name: "other" });
    expect(found("scout").sort()).toEqual(["agent_created", "agent_deleted"]);
    expect(found("SCOUT")).toHaveLength(2);
  });

  it("still matches the actor", async () => {
    await dashboardForm("/agents/create", { name: "scout" });
    expect(found("admin")).toContain("agent_created");
  });

  it("follows a rename by key, and does not give the freed name the old history", async () => {
    const { id } = t.h.agents.create("scout").agent;
    t.h.agents.rename(id, "ranger");
    expect(found("ranger").sort()).toEqual(["agent_created", "agent_renamed"]);
    t.h.agents.create("scout");
    expect(found("scout")).toEqual(["agent_created"]);
    expect(t.h.activity.list({ agent_name: "scout", limit: 50, offset: 0 }).data[0].entity_id).toBe(agentNamed("scout").id);
  });

  it("shows both on the Log page, and topActors counts the same set", async () => {
    await dashboardForm("/agents/create", { name: "scout" });
    await dashboardForm("/agents/delete", { id: agentNamed("scout").id });
    const { cookie } = await signIn(t.app, ADMIN_TOKEN);
    const html = await (await t.app.request("/log?tab=audit&agent=scout", { headers: { Cookie: cookie, Accept: "text/html" } })).text();
    expect(html).toContain("You created scout");
    expect(html).toContain("You deleted scout");
    expect(t.h.activity.topActors({ agent_name: "scout", limit: 5 })).toEqual([{ agent_name: "admin", count: 2 }]);
  });
});

describe("registration tokens in the audit", () => {
  it("records minting and revoking, once each, without the token", async () => {
    const { registration_token: { id }, token } = await mint();
    await adminPost(`/api/admin/registration-tokens/${id}/revoke`);
    await adminPost(`/api/admin/registration-tokens/${id}/revoke`);

    const created = onlyRow("registration_token_created");
    expect(created).toMatchObject({
      entity_type: "registration_token", entity_id: id, agent_name: "admin:api", target_key: null, origin: "admin_api", ip_hash: hashIP(CLIENT),
    });
    expect(JSON.parse(created.detail_json!)).toEqual({
      new: { label: "anna laptop", name_prefix: "anna-", expires_at: null, max_per_hour: 10 },
    });
    const revoked = onlyRow("registration_token_revoked");
    expect(revoked).toMatchObject({ entity_id: id, agent_name: "admin:api", origin: "admin_api" });
    expect(JSON.parse(revoked.detail_json!).old).toEqual({ revoked_at: null });

    for (const event of ["registration_token_created", "registration_token_revoked"]) {
      expect(auditLines(event)).toEqual([expect.objectContaining({ actor: "admin:api", origin: "admin_api", entity_id: id })]);
    }
    expect(everything()).not.toContain(token);
    expect(everything()).not.toContain(token.split("_").slice(2).join("_"));
  });

  it("keeps the created agent's token out as well", async () => {
    const { token } = await mint();
    const body = (await (await registerWith(token, "anna-vibe")).json()) as { token: string };
    expect(everything()).not.toContain(body.token);
    expect(everything()).not.toContain(token);
  });
});
