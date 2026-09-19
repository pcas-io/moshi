// The authenticated request carries the agent's inbox key, read from its
// record at auth time. Found in review: the /mcp route used to look the
// agent up a second time BY NAME and fall back to lower(name) on a miss.
// With names and keys decoupled that guess can be another agent's inbox,
// and mesh_receive acks what it pulls.

import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { initDatabase } from "../src/services/db";
import { AgentService } from "../src/services/agent";
import { ActivityService } from "../src/services/activity";
import { PresenceService } from "../src/services/presence";
import { authMiddleware } from "../src/auth";
import type { Env, AppVariables } from "../src/types";

const ADMIN_TOKEN = "a".repeat(40);

function build() {
  const db = initDatabase(":memory:");
  const agents = new AgentService(db, new ActivityService(db));
  const presence = new PresenceService(db, {
    async updatePresence() {},
    async getPresence() { return new Map(); },
  });
  const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.env = { NATS_URL: "nats://x", MESH_ADMIN_TOKEN: ADMIN_TOKEN };
    await next();
  });
  app.use("*", authMiddleware(agents, presence));
  app.all("/mcp", (c) => c.json(c.get("agent")));
  return { app, agents };
}

const bearer = (token: string): RequestInit => ({
  method: "POST",
  headers: { Authorization: `Bearer ${token}` },
});

describe("authMiddleware — inbox key on the request", () => {
  it("hands the route the key from the agent's record", async () => {
    const { app, agents } = build();
    const { plaintextToken } = agents.create("Scout");
    const who = await (await app.request("/mcp", bearer(plaintextToken))).json();
    expect(who).toEqual({ name: "Scout", role: "agent", inbox_key: "scout" });
  });

  it("keeps the key and follows the name after a rename, on the same token", async () => {
    const { app, agents } = build();
    const { agent, plaintextToken } = agents.create("scout");
    await app.request("/mcp", bearer(plaintextToken)); // warm the token cache
    agents.rename(agent.id, "scout-eu");
    const who = await (await app.request("/mcp", bearer(plaintextToken))).json();
    expect(who).toEqual({ name: "scout-eu", role: "agent", inbox_key: "scout" });
  });

  it("gives the admin no inbox key: it has no inbox", async () => {
    const { app } = build();
    const who = await (await app.request("/mcp", bearer(ADMIN_TOKEN))).json();
    expect(who).toEqual({ name: "admin", role: "admin" });
  });
});
