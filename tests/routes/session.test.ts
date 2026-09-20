// POST /login and logout, extracted from index.tsx so they can be tested.

import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "fs";
import type { AppVariables, Env } from "../../src/types";
import { generateCsrfToken, generateSessionCookie, loginCsrfBinding, csrfBindingOf, readSessionCookie, LOGIN_COOKIE, SESSION_COOKIE } from "../../src/auth";
import { AgentService } from "../../src/services/agent";
import { ActivityService } from "../../src/services/activity";
import { createSessionRoutes } from "../../src/routes/session";

const ADMIN_TOKEN = "a".repeat(40);
const SECRET = "c".repeat(40);

function db(): Database.Database {
  const d = new Database(":memory:");
  for (const f of readdirSync("migrations").filter((x) => x.endsWith(".sql")).sort()) d.exec(readFileSync(`migrations/${f}`, "utf-8"));
  return d;
}

function build(agents: AgentService, secureCookie: boolean) {
  const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.env = { NATS_URL: "nats://x", MESH_ADMIN_TOKEN: ADMIN_TOKEN, MESH_COOKIE_SECRET: SECRET } as Env;
    await next();
  });
  app.route("/", createSessionRoutes({ agents, secureCookie }));
  return app;
}

const form = (fields: Record<string, string>, cookie?: string): RequestInit => ({
  method: "POST", body: new URLSearchParams(fields),
  headers: { "Content-Type": "application/x-www-form-urlencoded", ...(cookie ? { Cookie: cookie } : {}) },
});

// The sign-in page's pre-session cookie and a form token that fits it.
const NONCE = "n".repeat(24);
const PRE = `${LOGIN_COOKIE}=${NONCE}`;
const loginCsrf = () => generateCsrfToken(SECRET, loginCsrfBinding(NONCE));

describe("POST /login", () => {
  let agents: AgentService;
  let token: string;
  beforeEach(() => {
    const d = db();
    agents = new AgentService(d, new ActivityService(d));
    token = agents.create("scout").plaintextToken;
  });

  it("sends a missing token back to the form instead of crashing", async () => {
    const res = await build(agents, true).request("/login", form({ csrf: loginCsrf() }, PRE));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login?error=1");
  });

  it("sends a missing csrf field back to the form instead of crashing", async () => {
    const res = await build(agents, true).request("/login", form({ token }));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login?error=expired");
  });

  it("signs in and sets a Secure, HttpOnly, SameSite=Lax cookie when told to", async () => {
    const res = await build(agents, true).request("/login", form({ csrf: loginCsrf(), token, next: "/log?tab=audit" }, PRE));
    expect(res.headers.get("location")).toBe("/log?tab=audit");
    const cookie = res.headers.getSetCookie().find((l) => l.startsWith("mesh_session=")) ?? "";
    expect(cookie).toContain("mesh_session=");
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/;\s*Secure/i);
  });

  it("names the agent by id in the session, never by name or token", async () => {
    const res = await build(agents, true).request("/login", form({ csrf: loginCsrf(), token }, PRE));
    const value = decodeURIComponent((res.headers.getSetCookie().find((l) => l.startsWith("mesh_session=")) ?? "").split(";")[0].slice("mesh_session=".length));
    const claims = readSessionCookie(value, SECRET);
    expect(claims).toMatchObject({ kind: "agent", id: agents.getByName("scout")!.id });
    expect(value).not.toContain("scout");
    expect(value).not.toContain(token);
  });

  it("refuses a form token that was not made for this browser's sign-in page", async () => {
    const app = build(agents, true);
    for (const [csrf, cookie] of [
      [generateCsrfToken(SECRET, loginCsrfBinding("m".repeat(24))), PRE],
      [loginCsrf(), undefined],
      [loginCsrf(), `${LOGIN_COOKIE}=short`],
      [generateCsrfToken(SECRET, "session:admin::x"), PRE],
    ] as const) {
      const res = await app.request("/login", form({ csrf, token }, cookie));
      expect(res.headers.get("location")).toBe("/login?error=expired");
      expect(res.headers.getSetCookie().join("\n")).not.toContain("mesh_session=");
    }
  });

  it("leaves Secure off when told to, or sign-in over plain http would break", async () => {
    const res = await build(agents, false).request("/login", form({ csrf: loginCsrf(), token }, PRE));
    const line = res.headers.getSetCookie().find((l) => l.startsWith("mesh_session=")) ?? "";
    expect(line).toContain("mesh_session=");
    expect(line).not.toMatch(/;\s*Secure/i);
  });

  it("never follows a hostile next", async () => {
    for (const next of ["//evil.example", "/\t/evil.example/login", "https://evil.example", "/\\evil.example", "/.//evil.example", "/x/..//evil.example", "/%2e//evil.example"]) {
      const res = await build(agents, true).request("/login", form({ csrf: loginCsrf(), token, next }, PRE));
      expect(res.headers.get("location"), JSON.stringify(next)).toBe("/");
    }
  });

  it("logs out by clearing the cookie with the same attributes", async () => {
    const session = generateSessionCookie({ kind: "admin", id: "", tokenHash: "h".repeat(64) }, SECRET);
    const csrf = generateCsrfToken(SECRET, csrfBindingOf(readSessionCookie(session, SECRET)!));
    const res = await build(agents, true).request("/logout", form({ csrf }, `${SESSION_COOKIE}=${encodeURIComponent(session)}`));
    expect(res.headers.get("location")).toBe("/login");
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/mesh_session=;/);
    expect(cookie).toMatch(/;\s*Secure/i);
  });

  it("has no GET /logout any more", async () => {
    const res = await build(agents, true).request("/logout");
    expect(res.status).toBe(404);
  });
});
