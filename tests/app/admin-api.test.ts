// /api/admin through the real app: only the admin token as Bearer gets in,
// a session cookie never does, and a plaintext token appears once, in the
// answer, and nowhere in the audit log.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestApp, signIn, ADMIN_TOKEN } from "./harness";
import type { TestApp } from "./harness";
import { createMessage, persistMessage } from "../../src/services/message";

const NOW = Date.parse("2026-11-07T12:00:00.000Z");
const ADMIN = { Authorization: `Bearer ${ADMIN_TOKEN}` };
const JSON_HEADERS = { ...ADMIN, "Content-Type": "application/json" };

let t: TestApp;

afterEach(() => { vi.restoreAllMocks(); });

/** The JSON log lines the app writes while a test runs. */
function capture() {
  const lines: Record<string, unknown>[] = [];
  const take = (line: unknown) => { try { lines.push(JSON.parse(String(line))); } catch { /* not ours */ } };
  vi.spyOn(console, "log").mockImplementation(take);
  vi.spyOn(console, "error").mockImplementation(take);
  vi.spyOn(console, "warn").mockImplementation(take);
  return lines;
}

beforeEach(() => {
  t = createTestApp({}, { now: () => NOW });
});

const post = (path: string, body?: unknown, headers: Record<string, string> = JSON_HEADERS) =>
  t.app.request(path, { method: "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) });

describe("/api/admin access", () => {
  it("refuses an agent token", async () => {
    const agentToken = t.h.agents.create("kate").plaintextToken;
    const res = await t.app.request("/api/admin/agents", { headers: { Authorization: `Bearer ${agentToken}` } });
    expect(res.status).toBe(403);
  });

  it("refuses an admin session cookie without the admin Bearer", async () => {
    const { cookie } = await signIn(t.app, ADMIN_TOKEN);
    const res = await t.app.request("/api/admin/agents", { headers: { Cookie: cookie } });
    expect(res.status).toBe(401);
  });

  it("refuses an admin session cookie with a wrong Bearer, even though the middleware falls back to the cookie", async () => {
    const { cookie } = await signIn(t.app, ADMIN_TOKEN);
    const res = await t.app.request("/api/admin/agents", { headers: { Cookie: cookie, Authorization: "Bearer nope" } });
    expect(res.status).toBe(403);
  });

  it("counts and logs a wrong Bearer that came in on a session cookie", async () => {
    const { cookie } = await signIn(t.app, ADMIN_TOKEN);
    const lines = capture();
    const res = await t.app.request("/api/admin/agents", { headers: { Cookie: cookie, Authorization: "Bearer nope" } });
    expect(res.status).toBe(403);
    const failed = lines.filter((l) => l.msg === "sign-in failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ reason: "admin_token_refused", path: "/api/admin/agents" });
    expect(JSON.stringify(lines)).not.toContain("nope");
  });

  it("counts and logs an agent's own token presented as the admin Bearer", async () => {
    const agentToken = t.h.agents.create("kate").plaintextToken;
    const lines = capture();
    await t.app.request("/api/admin/agents", { headers: { Authorization: `Bearer ${agentToken}` } });
    expect(lines.filter((l) => l.msg === "sign-in failed" && l.reason === "admin_token_refused")).toHaveLength(1);
  });

  it("logs nothing for the right admin Bearer", async () => {
    const lines = capture();
    await t.app.request("/api/admin/agents", { headers: ADMIN });
    expect(lines.filter((l) => l.msg === "sign-in failed")).toHaveLength(0);
  });

  it("refuses an anonymous request", async () => {
    const res = await t.app.request("/api/admin/agents", { headers: { Accept: "application/json" } });
    expect(res.status).toBe(401);
  });

  it("answers no-store", async () => {
    const res = await t.app.request("/api/admin/agents", { headers: ADMIN });
    expect(res.headers.get("Cache-Control")).toContain("no-store");
  });

  it("caps the body at 4 KB", async () => {
    const res = await post("/api/admin/agents", { name: "x", pad: "y".repeat(5000) });
    expect(res.status).toBe(413);
  });
});

describe("/api/admin agent lifecycle", () => {
  it("creates an agent and returns its token once, never in the audit log", async () => {
    const res = await post("/api/admin/agents", { name: "cockpit-nico" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { agent: { name: string; is_active: boolean }; token: string };
    expect(body.agent).toMatchObject({ name: "cockpit-nico", is_active: true });
    expect(body.token.length).toBeGreaterThan(20);
    const audit = JSON.stringify(t.h.db.prepare("SELECT * FROM activity_log").all());
    expect(audit).toContain("cockpit-nico");
    expect(audit).not.toContain(body.token);
    // The token works.
    const status = await t.app.request("/api/admin/agents", { headers: { Authorization: `Bearer ${body.token}` } });
    expect(status.status).toBe(403);
    expect(t.h.agents.getByName("cockpit-nico")?.is_active).toBe(1);
  });

  it("answers 409 name_taken for a name that exists in another case, without database text", async () => {
    t.h.agents.create("vibe");
    const res = await post("/api/admin/agents", { name: "VIBE" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("name_taken");
    expect(body.message).toContain("already an agent called VIBE");
    expect(JSON.stringify(body)).not.toMatch(/UNIQUE|constraint/i);
    expect(t.h.agents.list().filter((a) => a.name.toLowerCase() === "vibe")).toHaveLength(1);
  });

  it("logs its actions as admin:api, apart from the dashboard", async () => {
    await post("/api/admin/agents", { name: "kate" });
    await post("/api/admin/agents/kate/revoke");
    const actors = t.h.db.prepare("SELECT agent_name FROM activity_log WHERE action IN ('agent_created','agent_revoked')").all() as { agent_name: string }[];
    expect(actors.map((a) => a.agent_name)).toEqual(["admin:api", "admin:api"]);
  });

  it("logs a revoke once, not again for an agent already revoked", async () => {
    t.h.agents.create("kate");
    expect((await post("/api/admin/agents/kate/revoke")).status).toBe(200);
    expect((await post("/api/admin/agents/kate/revoke")).status).toBe(200);
    const revoked = t.h.db.prepare("SELECT COUNT(*) AS n FROM activity_log WHERE action = 'agent_revoked'").get() as { n: number };
    expect(revoked.n).toBe(1);
  });

  it("refuses reserved and invalid names and bad bodies", async () => {
    expect((await post("/api/admin/agents", { name: "admin" })).status).toBe(400);
    expect((await post("/api/admin/agents", { name: "a b" })).status).toBe(400);
    expect((await post("/api/admin/agents", {})).status).toBe(400);
    expect((await post("/api/admin/agents", ["x"])).status).toBe(400);
    expect((await post("/api/admin/agents", { name: "ok", avatar: 5 })).status).toBe(400);
    expect((await post("/api/admin/agents", { name: "ok", avatar: "a".repeat(65) })).status).toBe(400);
    expect((await post("/api/admin/agents", { name: "ok", avatar: "avatar-21" })).status).toBe(201);
    const raw = await t.app.request("/api/admin/agents", { method: "POST", headers: JSON_HEADERS, body: "{" });
    expect(raw.status).toBe(400);
  });

  it("lists agents without hashes or keys", async () => {
    t.h.agents.create("kate");
    const res = await t.app.request("/api/admin/agents", { headers: ADMIN });
    const text = await res.text();
    expect(text).toContain('"name":"kate"');
    expect(text).not.toContain("token_hash");
    expect(text).not.toContain("inbox_key");
  });

  it("resets, revokes and reactivates by name or id", async () => {
    const created = t.h.agents.create("vibe");
    const reset = await post("/api/admin/agents/vibe/reset-token");
    expect(reset.status).toBe(200);
    const { token } = (await reset.json()) as { token: string };
    expect(token).not.toBe(created.plaintextToken);

    expect((await post(`/api/admin/agents/${created.agent.id}/revoke`)).status).toBe(200);
    expect(t.h.agents.getByName("vibe")?.is_active).toBe(0);
    expect((await post("/api/admin/agents/vibe/reset-token")).status).toBe(409);

    const back = await post("/api/admin/agents/vibe/reactivate");
    expect(back.status).toBe(200);
    expect((await post("/api/admin/agents/vibe/reactivate")).status).toBe(409);
    expect((await post("/api/admin/agents/nobody/revoke")).status).toBe(404);
  });
});

describe("/api/admin/board", () => {
  it("returns who has the ball, without payload or context", async () => {
    t.h.agents.create("kate");
    t.h.agents.create("tech");
    const m = createMessage({ from: "kate", to: "tech", type: "review_request", payload: "SECRET PAYLOAD", context: "SECRET CONTEXT" });
    m.created_at = new Date(NOW - 5 * 60_000).toISOString();
    persistMessage(t.h.db, m, { toKey: "tech" });
    const res = await t.app.request("/api/admin/board", { headers: ADMIN });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("SECRET");
    const board = JSON.parse(text) as { inPlay: { holder: string; type: string }[] };
    expect(board.inPlay[0]).toMatchObject({ holder: "tech", type: "review_request" });
  });
});
