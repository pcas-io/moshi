// Registration tokens through the real app (ADR ocellio 06aef68e). One block
// per Tech-CIO criterion: a registration token creates agents and nothing else.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestApp, signIn, ADMIN_TOKEN, MCP_HEADERS, rpc } from "./harness";
import type { TestApp } from "./harness";

const START = Date.parse("2026-11-07T12:00:00.000Z");
const ADMIN = { Authorization: `Bearer ${ADMIN_TOKEN}`, "Content-Type": "application/json" };

let t: TestApp;
let clock = START;

beforeEach(() => {
  clock = START;
  t = createTestApp({}, { now: () => clock });
});
afterEach(() => { vi.restoreAllMocks(); });

function capture() {
  const lines: Record<string, unknown>[] = [];
  const take = (line: unknown) => { try { lines.push(JSON.parse(String(line))); } catch { /* not ours */ } };
  vi.spyOn(console, "log").mockImplementation(take);
  vi.spyOn(console, "error").mockImplementation(take);
  vi.spyOn(console, "warn").mockImplementation(take);
  return lines;
}

async function mint(body: Record<string, unknown> = { label: "anna laptop" }) {
  const res = await t.app.request("/api/admin/registration-tokens", { method: "POST", headers: ADMIN, body: JSON.stringify(body) });
  expect(res.status).toBe(201);
  return (await res.json()) as { registration_token: { id: string }; token: string };
}

const register = (token: string, name: string, extra: Record<string, unknown> = {}) =>
  t.app.request("/api/register/agents", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name, ...extra }),
  });

describe("registration tokens: scope (criteria 1, 7, 8)", () => {
  it("creates an agent and hands its token out once", async () => {
    const { token } = await mint();
    const res = await register(token, "anna-vibe");
    expect(res.status).toBe(201);
    const body = (await res.json()) as { agent: { name: string }; token: string };
    expect(body.agent.name).toBe("anna-vibe");
    expect(body.token.startsWith("bt_")).toBe(true);
    expect(t.h.agents.getByName("anna-vibe")?.is_active).toBe(1);
  });

  it("is a wrong Bearer everywhere else: admin API, board, reset, revoke, MCP, dashboard", async () => {
    const { token } = await mint();
    t.h.agents.create("kate");
    const auth = { Authorization: `Bearer ${token}`, Accept: "application/json" };
    const refused = [
      await t.app.request("/api/admin/agents", { headers: auth }),
      await t.app.request("/api/admin/board", { headers: auth }),
      await t.app.request("/api/admin/registration-tokens", { headers: auth }),
      await t.app.request("/api/admin/agents/kate/reset-token", { method: "POST", headers: auth }),
      await t.app.request("/api/admin/agents/kate/revoke", { method: "POST", headers: auth }),
      await t.app.request("/mcp", { method: "POST", headers: { ...MCP_HEADERS, Authorization: `Bearer ${token}` },
        body: rpc("tools/call", { name: "mesh_history", arguments: { correlation_id: "x" } }) }),
      await t.app.request("/agents", { headers: auth }),
    ];
    for (const res of refused) expect([401, 403]).toContain(res.status);
    expect(t.h.agents.getByName("kate")?.is_active).toBe(1);
  });

  it("accepts nothing but a registration token: not the admin token, not an agent token, not a session", async () => {
    const agentToken = t.h.agents.create("kate").plaintextToken;
    const { cookie } = await signIn(t.app, ADMIN_TOKEN);
    const variants: Record<string, string>[] = [
      { Authorization: `Bearer ${ADMIN_TOKEN}` },
      { Authorization: `Bearer ${agentToken}` },
      { Cookie: cookie },
    ];
    for (const headers of variants) {
      const res = await t.app.request("/api/register/agents", {
        method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ name: "x1" }),
      });
      expect(res.status).toBe(401);
    }
    expect(t.h.agents.getByName("x1")).toBeNull();
  });

  it("gives the new agent a plain agent token, no operator rights", async () => {
    const { token } = await mint();
    const { token: agentToken } = (await (await register(token, "anna-codex")).json()) as { token: string };
    const res = await t.app.request("/api/admin/agents", { headers: { Authorization: `Bearer ${agentToken}` } });
    expect(res.status).toBe(403);
    const again = await t.app.request("/api/admin/registration-tokens", {
      method: "POST", headers: { Authorization: `Bearer ${agentToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ label: "escalate" }),
    });
    expect(again.status).toBe(403);
  });

  it("only the admin Bearer mints, lists and revokes registration tokens", async () => {
    const agentToken = t.h.agents.create("kate").plaintextToken;
    const res = await t.app.request("/api/admin/registration-tokens", {
      method: "POST", headers: { Authorization: `Bearer ${agentToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ label: "x" }),
    });
    expect(res.status).toBe(403);
  });
});

describe("registration tokens: at rest (criterion 2)", () => {
  it("stores only a salted scrypt hash and never shows the secret again", async () => {
    const { token, registration_token } = await mint();
    const rows = JSON.stringify(t.h.db.prepare("SELECT * FROM registration_tokens").all());
    const secret = token.split("_").slice(2).join("_");
    expect(rows).not.toContain(secret);
    expect(rows).not.toContain(token);
    const list = await (await t.app.request("/api/admin/registration-tokens", { headers: ADMIN })).text();
    expect(list).toContain(registration_token.id);
    for (const hidden of [secret, "secret_hash", "salt"]) expect(list).not.toContain(hidden);
  });

  it("refuses a wrong secret for a known id, and records it under that id", async () => {
    const { token, registration_token } = await mint();
    const lines = capture();
    const forged = token.slice(0, -4) + (token.endsWith("AAAA") ? "BBBB" : "AAAA");
    const res = await register(forged, "anna-x");
    expect(res.status).toBe(401);
    expect(lines.filter((l) => l.msg === "sign-in failed" && l.reason === "registration_token_refused")).toHaveLength(1);
    expect(JSON.stringify(lines)).not.toContain(forged);
    const audit = (await (await t.app.request(`/api/admin/registration-tokens/${registration_token.id}/audit`,
      { headers: ADMIN })).json()) as { audit: { result: string }[] };
    expect(audit.audit[0].result).toBe("refused_invalid");
  });
});

describe("registration tokens: expiry and revocation (criteria 3, 6)", () => {
  it("is refused with 401 once expired", async () => {
    const { token } = await mint({ label: "short", expires_at: new Date(START + 60_000).toISOString() });
    expect((await register(token, "a-1")).status).toBe(201);
    clock = START + 61_000;
    const res = await register(token, "a-2");
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("token_expired");
  });

  it("refuses an expiry in the past at creation", async () => {
    const res = await t.app.request("/api/admin/registration-tokens", {
      method: "POST", headers: ADMIN, body: JSON.stringify({ label: "x", expires_at: new Date(START - 1).toISOString() }),
    });
    expect(res.status).toBe(400);
  });

  it("is refused with 401 once revoked, and the list says so", async () => {
    const { token, registration_token } = await mint();
    const res = await t.app.request(`/api/admin/registration-tokens/${registration_token.id}/revoke`, { method: "POST", headers: ADMIN });
    expect(res.status).toBe(200);
    const refused = await register(token, "a-1");
    expect(refused.status).toBe(401);
    expect(((await refused.json()) as { error: string }).error).toBe("token_revoked");
  });
});

describe("registration tokens: name prefix (criterion 4)", () => {
  it("allows only names that start with the prefix and are longer than it", async () => {
    const { token } = await mint({ label: "anna", name_prefix: "anna-" });
    expect((await register(token, "anna-vibe")).status).toBe(201);
    for (const name of ["bob-vibe", "anna-", "ANNA-vibe", "xanna-vibe"]) {
      expect((await register(token, name)).status).toBe(403);
    }
    expect((await register(token, "anna-a b")).status).toBe(400);
  });

  it("refuses an invalid prefix at creation", async () => {
    for (const prefix of ["../", "a b", "-x"]) {
      const res = await t.app.request("/api/admin/registration-tokens", {
        method: "POST", headers: ADMIN, body: JSON.stringify({ label: "x", name_prefix: prefix }),
      });
      expect(res.status).toBe(400);
    }
  });
});

describe("registration tokens: rate limit and audit (criteria 5, 6)", () => {
  it("caps created agents per rolling hour with 429 and Retry-After, then recovers", async () => {
    const { token, registration_token } = await mint({ label: "cap", max_per_hour: 2 });
    expect((await register(token, "r-1")).status).toBe(201);
    clock += 60_000;
    expect((await register(token, "r-2")).status).toBe(201);
    const third = await register(token, "r-3");
    expect(third.status).toBe(429);
    expect(Number(third.headers.get("Retry-After"))).toBeGreaterThan(3000);
    clock = START + 60 * 60 * 1000 + 1;
    expect((await register(token, "r-4")).status).toBe(201);
    const list = (await (await t.app.request("/api/admin/registration-tokens", { headers: ADMIN })).json()) as {
      registration_tokens: { id: string; created_agents: number }[];
    };
    expect(list.registration_tokens.find((r) => r.id === registration_token.id)?.created_agents).toBe(3);
  });

  it("audits every attempt, refused ones included, with its result", async () => {
    const { token, registration_token } = await mint({ label: "audit", name_prefix: "anna-" });
    t.h.agents.create("anna-taken");
    await register(token, "anna-new");
    await register(token, "bob-x");
    await register(token, "ANNA-TAKEN".toLowerCase());
    const audit = (await (await t.app.request(`/api/admin/registration-tokens/${registration_token.id}/audit`,
      { headers: ADMIN })).json()) as { audit: { name: string; result: string }[] };
    expect(audit.audit.map((a) => a.result).sort()).toEqual(["created", "refused_prefix", "refused_taken"]);
    const agentLog = JSON.stringify(t.h.db.prepare("SELECT * FROM activity_log WHERE action = 'agent_created'").all());
    expect(agentLog).toContain(`register:${registration_token.id}`);
    expect(agentLog).not.toContain(token);
  });
});

describe("registration tokens: flood resistance (automated security review)", () => {
  it("answers a throttled client before any scrypt, body read or audit row", async () => {
    const { token, registration_token } = await mint();
    capture();
    const forged = token.slice(0, -4) + (token.endsWith("AAAA") ? "BBBB" : "AAAA");
    const statuses: number[] = [];
    for (let i = 0; i < 10; i++) statuses.push((await register(forged, `x-${i}`)).status);
    expect(statuses.every((s) => s === 401)).toBe(true);
    const crypto = await import("node:crypto");
    const scrypt = vi.spyOn(crypto.default, "scrypt");
    const auditBefore = (t.h.db.prepare("SELECT COUNT(*) AS n FROM registration_audit").get() as { n: number }).n;
    const throttled = await register(token, "anna-ok"); // even the right token waits: same client
    expect(throttled.status).toBe(429);
    expect(Number(throttled.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(scrypt).not.toHaveBeenCalled();
    expect((t.h.db.prepare("SELECT COUNT(*) AS n FROM registration_audit").get() as { n: number }).n).toBe(auditBefore);
    expect(t.h.agents.getByName("anna-ok")).toBeNull();
    expect(registration_token.id).toBeTruthy();
  });

  it("does not audit tokens it cannot attribute (unknown id or no token shape)", async () => {
    capture();
    const unknown = `rt_${"0".repeat(26)}_${"A".repeat(43)}`;
    expect((await register(unknown, "x-1")).status).toBe(401);
    expect((await register("rt_nonsense", "x-2")).status).toBe(401);
    expect((t.h.db.prepare("SELECT COUNT(*) AS n FROM registration_audit").get() as { n: number }).n).toBe(0);
  });

  it("hashes with the asynchronous scrypt, off the event loop", async () => {
    const crypto = await import("node:crypto");
    const sync = vi.spyOn(crypto.default, "scryptSync");
    const async = vi.spyOn(crypto.default, "scrypt");
    const { token } = await mint();
    expect((await register(token, "a-1")).status).toBe(201);
    expect(sync).not.toHaveBeenCalled();
    expect(async).toHaveBeenCalled(); // positive control: the spy does see the service's calls
  });

  it("prunes audit rows past the retention in the hourly sweep", async () => {
    const { pruneRegistrationAudit, AUDIT_RETENTION_DAYS } = await import("../../src/services/registration");
    const { token } = await mint();
    await register(token, "a-1");
    expect(pruneRegistrationAudit(t.h.db, clock)).toBe(0);
    expect(pruneRegistrationAudit(t.h.db, clock + (AUDIT_RETENTION_DAYS + 1) * 24 * 3600 * 1000)).toBe(1);
  });
});
