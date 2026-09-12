// /agents/connect — the admin guard, step-1 validation and the handshake
// the step-4 poll lives on. No NATS, no SQLite: the route only needs the
// two narrow service interfaces it declares.

import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import type { Agent, AppVariables, Env, RequestAgent } from "../../src/types";
import type { AgentWithPresence } from "../../src/services/presence";
import { generateCsrfToken } from "../../src/auth";
import {
  CONNECT_SESSION_TTL_MS,
  clearConnectSessions,
  createConnectSession,
} from "../../src/services/connect-session";
import {
  createAgentConnectRoutes,
  type ConnectAgentService,
  type ConnectPresenceService,
} from "../../src/routes/agent-connect";

const SECRET = "test-cookie-secret";
const ADMIN: RequestAgent = { name: "admin", role: "admin" };
const NON_ADMIN: RequestAgent = { name: "dex-eu", role: "agent" };

function agentRow(over: Partial<Agent> = {}): Agent {
  return {
    id: "01HZAGENT", name: "dex-eu", role: null, capabilities: null,
    token_hash: "hash", is_active: 1, avatar: null, working_on: null,
    last_seen_at: null, created_at: "2026-09-12T10:00:00.000Z",
    updated_at: "2026-09-12T10:00:00.000Z", ...over,
  };
}

class FakeAgents implements ConnectAgentService {
  rows: Agent[] = [];
  createdBy: string | undefined;
  nextId = 1;

  create(name: string, _avatar?: string, adminName?: string) {
    this.createdBy = adminName;
    const agent = agentRow({ id: `01HZ${this.nextId++}`, name });
    this.rows.push(agent);
    return { agent, plaintextToken: `bt_token_for_${name}` };
  }

  getByName(name: string): Agent | null {
    return this.rows.find((a) => a.name.toLowerCase() === name.toLowerCase()) ?? null;
  }
}

class FakePresence implements ConnectPresenceService {
  constructor(private readonly agents: FakeAgents) {}
  async list(): Promise<AgentWithPresence[]> {
    return this.agents.rows.map((agent) => ({
      agent,
      presence: agent.last_seen_at ? "live" : "never",
      effectiveLastSeen: agent.last_seen_at,
    }));
  }
}

function buildApp(who: RequestAgent | null, agents: FakeAgents) {
  const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.set("agent", who);
    await next();
  });
  app.route(
    "/agents",
    createAgentConnectRoutes({
      agents,
      presence: new FakePresence(agents),
      cookieSecretFor: () => SECRET,
    }),
  );
  return app;
}

function form(fields: Record<string, string>): RequestInit {
  return {
    method: "POST",
    body: new URLSearchParams(fields),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  };
}

let agents: FakeAgents;
beforeEach(() => {
  clearConnectSessions();
  agents = new FakeAgents();
});

describe("GET /agents/connect — admin guard", () => {
  it("sends a non-admin home", async () => {
    const res = await buildApp(NON_ADMIN, agents).request("/agents/connect");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
  });

  it("sends an anonymous visitor home", async () => {
    const res = await buildApp(null, agents).request("/agents/connect");
    expect(res.status).toBe(302);
  });

  it("renders step 1 for an admin", async () => {
    const res = await buildApp(ADMIN, agents).request("/agents/connect");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("What should we call it?");
  });

  it("falls back to step 1 for a nonsense ?step= and to Claude Code for ?client=", async () => {
    const res = await buildApp(ADMIN, agents).request("/agents/connect?step=9&client=emacs");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("What should we call it?");
  });
});

describe("POST /agents/connect/create", () => {
  it("refuses a non-admin", async () => {
    const res = await buildApp(NON_ADMIN, agents).request(
      "/agents/connect/create",
      form({ csrf: generateCsrfToken(SECRET), name: "dex-eu" }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
    expect(agents.rows).toHaveLength(0);
  });

  it("rejects a missing CSRF token without creating anything", async () => {
    const res = await buildApp(ADMIN, agents).request(
      "/agents/connect/create",
      form({ csrf: "forged", name: "dex-eu" }),
    );
    expect(res.status).toBe(403);
    const html = await res.text();
    expect(html).toContain("That form expired. Reload the page and try again.");
    expect(html).toContain('value="dex-eu"');
    expect(agents.rows).toHaveLength(0);
  });

  it("asks for a name when the field is empty", async () => {
    const res = await buildApp(ADMIN, agents).request(
      "/agents/connect/create",
      form({ csrf: generateCsrfToken(SECRET), name: "   " }),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Give the agent a name.");
  });

  it("explains the naming rule in English, not the German NATS rule", async () => {
    const res = await buildApp(ADMIN, agents).request(
      "/agents/connect/create",
      form({ csrf: generateCsrfToken(SECRET), name: "dex eu.1" }),
    );
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain("must start with a letter or digit");
    expect(html).not.toContain("Buchstaben");
    expect(html).toContain('value="dex eu.1"');
  });

  it("names the collision and points at Agents", async () => {
    agents.create("dex-eu");
    const res = await buildApp(ADMIN, agents).request(
      "/agents/connect/create",
      form({ csrf: generateCsrfToken(SECRET), name: "dex-eu" }),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain(
      "There&#39;s already an agent called dex-eu. Pick another name, " +
        "or reactivate the existing one from Agents.",
    );
    expect(agents.rows).toHaveLength(1);
  });

  it("surfaces a service failure instead of a blank page", async () => {
    const failing = new FakeAgents();
    failing.create = () => {
      throw new Error("Maximum number of agents (100) reached");
    };
    const res = await buildApp(ADMIN, failing).request(
      "/agents/connect/create",
      form({ csrf: generateCsrfToken(SECRET), name: "dex-eu" }),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Maximum number of agents (100) reached");
  });

  it("creates the agent, credits the admin and lands on step 2 with the token", async () => {
    const app = buildApp(ADMIN, agents);
    const res = await app.request(
      "/agents/connect/create",
      form({ csrf: generateCsrfToken(SECRET), name: "dex-eu" }),
    );
    expect(res.status).toBe(302);
    expect(agents.createdBy).toBe("admin");

    const location = res.headers.get("location") ?? "";
    expect(location).toMatch(/^\/agents\/connect\?step=2&s=[^&]+&client=code$/);

    const step2 = await app.request(location);
    const html = await step2.text();
    expect(html).toContain("dex-eu is registered");
    expect(html).toContain("bt_token_for_dex-eu");
  });

  it("keeps the chosen client across the create redirect", async () => {
    const res = await buildApp(ADMIN, agents).request(
      "/agents/connect/create?client=gemini",
      form({ csrf: generateCsrfToken(SECRET), name: "dex-eu" }),
    );
    expect(res.headers.get("location")).toContain("client=gemini");
  });
});

describe("GET /agents/connect/handshake", () => {
  function sessionFor(agent: Agent, createdAt = Date.now()) {
    return createConnectSession(
      { agentId: agent.id, agentName: agent.name, token: "bt_x" },
      createdAt,
    );
  }

  it("refuses a non-admin", async () => {
    const res = await buildApp(NON_ADMIN, agents).request("/agents/connect/handshake?s=x");
    expect(res.status).toBe(403);
  });

  it("reports a stale or unknown ?s= as gone, so the poll can stop", async () => {
    const app = buildApp(ADMIN, agents);
    expect((await app.request("/agents/connect/handshake?s=never-existed")).status).toBe(410);
    expect((await app.request("/agents/connect/handshake")).status).toBe(410);

    const { agent } = agents.create("dex-eu");
    const stale = sessionFor(agent, Date.now() - CONNECT_SESSION_TTL_MS - 1);
    const res = await app.request(`/agents/connect/handshake?s=${stale.key}`);
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ error: "expired" });
  });

  it("404s when the agent is gone but the session is not", async () => {
    const { agent } = agents.create("dex-eu");
    const session = sessionFor(agent);
    agents.rows = [];
    const res = await buildApp(ADMIN, agents).request(`/agents/connect/handshake?s=${session.key}`);
    expect(res.status).toBe(404);
  });

  it("says not seen while the agent has never called in", async () => {
    const { agent } = agents.create("dex-eu");
    const session = sessionFor(agent);
    const res = await buildApp(ADMIN, agents).request(`/agents/connect/handshake?s=${session.key}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      seen: false, last_seen_at: null, role: null, capabilities: [], registered: false,
    });
  });

  it("separates authenticated-once from actually registered", async () => {
    const { agent } = agents.create("dex-eu");
    const session = sessionFor(agent, Date.parse("2026-09-12T10:00:00.000Z"));
    const app = buildApp(ADMIN, agents);

    agent.last_seen_at = "2026-09-12T10:00:08.000Z";
    const seenOnly = await (await app.request(`/agents/connect/handshake?s=${session.key}`)).json();
    expect(seenOnly).toMatchObject({ seen: true, registered: false, role: null, capabilities: [] });
    expect(seenOnly).toHaveProperty("last_seen_at", "2026-09-12T10:00:08.000Z");

    agent.role = "dev-assistant";
    agent.capabilities = JSON.stringify(["typescript", "review"]);
    const registered = await (await app.request(`/agents/connect/handshake?s=${session.key}`)).json();
    expect(registered).toMatchObject({
      seen: true, registered: true, role: "dev-assistant",
      capabilities: ["typescript", "review"],
    });
  });

  it("ignores a handshake that predates the token", async () => {
    const { agent } = agents.create("dex-eu");
    agent.last_seen_at = "2026-09-12T09:00:00.000Z"; // a previous life
    agent.role = "dev-assistant";
    const session = sessionFor(agent, Date.parse("2026-09-12T10:00:00.000Z"));
    const res = await buildApp(ADMIN, agents).request(`/agents/connect/handshake?s=${session.key}`);
    expect(await res.json()).toMatchObject({ seen: false, registered: false });
  });

  it("survives a malformed capabilities column", async () => {
    const { agent } = agents.create("dex-eu");
    agent.last_seen_at = new Date().toISOString();
    agent.capabilities = "{not json";
    const session = sessionFor(agent, Date.now() - 1000);
    const res = await buildApp(ADMIN, agents).request(`/agents/connect/handshake?s=${session.key}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ capabilities: [] });
  });

  it("is never cached", async () => {
    const { agent } = agents.create("dex-eu");
    const session = sessionFor(agent);
    const res = await buildApp(ADMIN, agents).request(`/agents/connect/handshake?s=${session.key}`);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});
