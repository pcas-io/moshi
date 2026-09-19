// POST /login and logout, extracted from index.tsx so they can be tested.

import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "fs";
import type { AppVariables, Env } from "../../src/types";
import { generateCsrfToken } from "../../src/auth";
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

const form = (fields: Record<string, string>): RequestInit => ({
  method: "POST", body: new URLSearchParams(fields),
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
});

describe("POST /login", () => {
  let agents: AgentService;
  let token: string;
  beforeEach(() => {
    const d = db();
    agents = new AgentService(d, new ActivityService(d));
    token = agents.create("scout").plaintextToken;
  });

  it("sends a missing token back to the form instead of crashing", async () => {
    const res = await build(agents, true).request("/login", form({ csrf: generateCsrfToken(SECRET) }));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login?error=1");
  });

  it("sends a missing csrf field back to the form instead of crashing", async () => {
    const res = await build(agents, true).request("/login", form({ token }));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login?error=1");
  });

  it("signs in and sets a Secure, HttpOnly, SameSite=Lax cookie when told to", async () => {
    const res = await build(agents, true).request("/login", form({ csrf: generateCsrfToken(SECRET), token, next: "/log?tab=audit" }));
    expect(res.headers.get("location")).toBe("/log?tab=audit");
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("mesh_session=");
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toMatch(/;\s*Secure/i);
  });

  it("leaves Secure off when told to, or sign-in over plain http would break", async () => {
    const res = await build(agents, false).request("/login", form({ csrf: generateCsrfToken(SECRET), token }));
    expect(res.headers.get("set-cookie") ?? "").not.toMatch(/;\s*Secure/i);
  });

  it("never follows a hostile next", async () => {
    for (const next of ["//evil.example", "/\t/evil.example/login", "https://evil.example", "/\\evil.example", "/.//evil.example", "/x/..//evil.example", "/%2e//evil.example"]) {
      const res = await build(agents, true).request("/login", form({ csrf: generateCsrfToken(SECRET), token, next }));
      expect(res.headers.get("location"), JSON.stringify(next)).toBe("/");
    }
  });

  it("logs out by clearing the cookie with the same attributes", async () => {
    const res = await build(agents, true).request("/logout", { method: "POST" });
    expect(res.headers.get("location")).toBe("/login");
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/mesh_session=;/);
    expect(cookie).toMatch(/;\s*Secure/i);
  });
});
