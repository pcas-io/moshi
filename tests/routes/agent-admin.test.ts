// Route tests for the admin rename action behind the Agents page.
//
// The route existed without a UI and without tests. It drives the real
// AgentService on an in-memory database, so what is asserted here is what an
// operator gets when they press the button.

import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "fs";
import type { AppVariables, Env, RequestAgent } from "../../src/types";
import { generateCsrfToken } from "../../src/auth";
import { AgentService, AGENT_NAME_RULE } from "../../src/services/agent";
import { ActivityService } from "../../src/services/activity";
import { getFlash } from "../../src/services/flash";
import { createAgentAdminRoutes } from "../../src/routes/agent-admin";

const SECRET = "test-cookie-secret";
/** Stands in for a session: the routes only ever see it through the context. */
const BINDING = "session:admin::test";
const ADMIN: RequestAgent = { name: "admin", role: "admin" };
const NON_ADMIN: RequestAgent = { name: "dex-eu", role: "agent" };

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  for (const file of readdirSync("migrations").filter((f) => f.endsWith(".sql")).sort()) {
    db.exec(readFileSync(`migrations/${file}`, "utf-8"));
  }
  return db;
}

function buildApp(who: RequestAgent | null, agents: AgentService) {
  const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    // What the auth middleware leaves behind: who, and whose forms count.
    c.env = { NATS_URL: "nats://x", MESH_ADMIN_TOKEN: "a".repeat(40), MESH_COOKIE_SECRET: SECRET } as Env;
    c.set("agent", who);
    c.set("csrfBinding", BINDING);
    await next();
  });
  app.route("/agents", createAgentAdminRoutes({ agents }));
  return app;
}

function form(fields: Record<string, string>): RequestInit {
  return {
    method: "POST",
    body: new URLSearchParams(fields),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  };
}

/** The flash a redirect carries, read the way the Agents page reads it. */
function flashOf(res: Response): { error?: string } | null {
  const location = res.headers.get("location") ?? "";
  return getFlash(new URL(location, "http://x").searchParams.get("flash") ?? undefined);
}

describe("POST /agents/rename", () => {
  let agents: AgentService;
  let id: string;

  beforeEach(() => {
    const db = createTestDb();
    agents = new AgentService(db, new ActivityService(db));
    id = agents.create("scout").agent.id;
    agents.create("ops");
  });

  const rename = (who: RequestAgent | null, fields: Record<string, string>) =>
    buildApp(who, agents).request("/agents/rename", form(fields));

  it("refuses a non-admin", async () => {
    const res = await rename(NON_ADMIN, { csrf: generateCsrfToken(SECRET, BINDING), id, name: "scout-eu" });
    expect(res.status).toBe(403);
    expect(agents.getByName("scout")).not.toBeNull();
  });

  it("renames and lands back on the agent it renamed", async () => {
    const res = await rename(ADMIN, { csrf: generateCsrfToken(SECRET, BINDING), id, name: "  scout-eu  " });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/agents?inspect=${id}`);
    expect(agents.getByName("scout-eu")?.id).toBe(id);
    expect(agents.getByName("scout")).toBeNull();
  });

  it("rejects a stale form without renaming, and stays on the agent", async () => {
    const res = await rename(ADMIN, { csrf: "stale.token", id, name: "scout-eu" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain(`inspect=${id}`);
    expect(flashOf(res)?.error).toBe("That form expired. Reload the page and try again.");
    expect(agents.getByName("scout")).not.toBeNull();
  });

  it("says so when the agent is gone, instead of landing on someone else's form", async () => {
    const res = await rename(ADMIN, { csrf: generateCsrfToken(SECRET, BINDING), id: "01NOPE", name: "scout-eu" });
    const location = res.headers.get("location") ?? "";
    expect(location).not.toContain("inspect=");
    expect(flashOf(res)?.error).toBe("That agent no longer exists. Reload the page.");
  });

  it("treats a missing id the same way", async () => {
    const res = await rename(ADMIN, { csrf: generateCsrfToken(SECRET, BINDING), name: "scout-eu" });
    expect(res.headers.get("location") ?? "").not.toContain("inspect=");
    expect(flashOf(res)?.error).toBe("That agent no longer exists. Reload the page.");
  });

  it("percent-encodes a hostile id on the way into the Location header", async () => {
    const hostile = "x\r\nSet-Cookie: a=b&flash=zz#//evil.example";
    const res = await rename(ADMIN, { csrf: "stale.token", id: hostile, name: "scout-eu" });
    const location = res.headers.get("location") ?? "";
    expect(location.startsWith("/agents?inspect=")).toBe(true);
    expect(location).not.toMatch(/[\r\n#]/);
    expect(location).toContain(encodeURIComponent(hostile));
  });

  it("asks for a name when the field is empty", async () => {
    const res = await rename(ADMIN, { csrf: generateCsrfToken(SECRET, BINDING), id, name: "   " });
    expect(flashOf(res)?.error).toBe("Give the agent a name.");
  });

  it("explains the name rule in the handoff's words and keeps the agent selected", async () => {
    const res = await rename(ADMIN, { csrf: generateCsrfToken(SECRET, BINDING), id, name: "scout eu" });
    const location = res.headers.get("location") ?? "";
    expect(location).toContain(`inspect=${id}`);
    expect(flashOf(res)?.error).toBe(AGENT_NAME_RULE);
    expect(agents.getByName("scout")).not.toBeNull();
  });

  it("refuses a reserved name", async () => {
    const res = await rename(ADMIN, { csrf: generateCsrfToken(SECRET, BINDING), id, name: "Admin" });
    expect(flashOf(res)?.error).toContain("reserved");
    expect(agents.getByName("scout")).not.toBeNull();
  });

  it("refuses a name another agent holds, in English", async () => {
    const res = await rename(ADMIN, { csrf: generateCsrfToken(SECRET, BINDING), id, name: "OPS" });
    expect(flashOf(res)?.error).toContain("already an agent called OPS");
  });
});

describe("admin actions — a request without a csrf field", () => {
  // validateCsrfToken used to call token.lastIndexOf on undefined: all six
  // actions answered 500 with a stack trace in the log instead of refusing.
  it("is refused with the expired-form flash on every action, and nothing happens", async () => {
    const db = createTestDb();
    const agents = new AgentService(db, new ActivityService(db));
    const id = agents.create("scout").agent.id;
    for (const action of ["create", "revoke", "reactivate", "rename", "reset-token", "delete"]) {
      const res = await buildApp(ADMIN, agents).request(`/agents/${action}`, form({ id, name: "scout-eu" }));
      expect(res.status, action).toBe(302);
      expect(flashOf(res)?.error, action).toBe("That form expired. Reload the page and try again.");
    }
    expect(agents.getByName("scout")?.is_active).toBe(1);
  });

  it("treats an uploaded file in a text field as missing, not as a crash", async () => {
    const db = createTestDb();
    const agents = new AgentService(db, new ActivityService(db));
    const id = agents.create("scout").agent.id;
    const body = new FormData();
    body.set("csrf", generateCsrfToken(SECRET, BINDING));
    body.set("id", id);
    body.set("name", new File(["x"], "name.txt"));
    const res = await buildApp(ADMIN, agents).request("/agents/rename", { method: "POST", body });
    expect(res.status).toBe(302);
    expect(flashOf(res)?.error).toBe("Give the agent a name.");
  });
});
