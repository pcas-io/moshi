import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { initDatabase } from "../src/services/db";
import { AgentService } from "../src/services/agent";
import { ActivityService } from "../src/services/activity";
import { PresenceService } from "../src/services/presence";
import {
  authMiddleware,
  isBrowserNavigation,
  safeNextPath,
} from "../src/auth";
import type { Env, AppVariables } from "../src/types";

const ADMIN_TOKEN = "a".repeat(40);

function buildApp() {
  const db = initDatabase(":memory:");
  const activity = new ActivityService(db);
  const agents = new AgentService(db, activity);
  const presence = new PresenceService(db, {
    async updatePresence() {},
    async getPresence(agentNames: string[]) { return new Map(); },
  });
  const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.env = { NATS_URL: "nats://x", MESH_ADMIN_TOKEN: ADMIN_TOKEN };
    await next();
  });
  app.use("*", authMiddleware(agents, presence));
  app.get("/", (c) => c.text("home"));
  app.get("/agents", (c) => c.text("agents"));
  app.all("/mcp", (c) => c.json({ ok: true }));
  return app;
}

describe("unauthenticated browser navigation (C1)", () => {
  it("redirects a browser GET to /login with the original path as next", async () => {
    const app = buildApp();
    const res = await app.request("/agents?presence=live", {
      headers: { Accept: "text/html,application/xhtml+xml" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      `/login?next=${encodeURIComponent("/agents?presence=live")}`,
    );
  });

  it("still answers JSON 401 + discovery header for API-style requests", async () => {
    const app = buildApp();
    const json = await app.request("/", { headers: { Accept: "application/json" } });
    expect(json.status).toBe(401);
    expect(json.headers.get("www-authenticate")).toContain("oauth-protected-resource");

    const noAccept = await app.request("/");
    expect(noAccept.status).toBe(401);
  });

  it("never redirects /mcp, POSTs, or requests that carried a bearer token", async () => {
    const app = buildApp();
    const mcp = await app.request("/mcp", { headers: { Accept: "text/html" } });
    expect(mcp.status).toBe(401);

    const post = await app.request("/agents", { method: "POST", headers: { Accept: "text/html" } });
    expect(post.status).toBe(401);

    const badToken = await app.request("/", {
      headers: { Accept: "text/html", Authorization: "Bearer bt_wrong" },
    });
    expect(badToken.status).toBe(401);
  });

  it("passes authenticated requests through", async () => {
    const app = buildApp();
    const res = await app.request("/", {
      headers: { Accept: "text/html", Authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.status).toBe(200);
  });
});

describe("isBrowserNavigation", () => {
  it("requires GET + HTML accept + no bearer", () => {
    const base = { method: "GET", path: "/", accept: "text/html", authorization: undefined };
    expect(isBrowserNavigation(base)).toBe(true);
    expect(isBrowserNavigation({ ...base, accept: "*/*" })).toBe(false);
    expect(isBrowserNavigation({ ...base, method: "DELETE" })).toBe(false);
    expect(isBrowserNavigation({ ...base, path: "/mcp" })).toBe(false);
    expect(isBrowserNavigation({ ...base, authorization: "Bearer x" })).toBe(false);
  });
});

describe("safeNextPath", () => {
  it("accepts same-origin relative paths only", () => {
    expect(safeNextPath("/agents?presence=live")).toBe("/agents?presence=live");
    expect(safeNextPath(undefined)).toBe("/");
    expect(safeNextPath("")).toBe("/");
    expect(safeNextPath("https://evil.example/")).toBe("/");
    expect(safeNextPath("//evil.example/")).toBe("/");
    expect(safeNextPath("/\\evil.example")).toBe("/");
    expect(safeNextPath("/login?next=/x")).toBe("/");
    expect(safeNextPath("/logout")).toBe("/");
  });
});
