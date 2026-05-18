import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { initDatabase } from "../../src/services/db";
import { AgentService } from "../../src/services/agent";
import { ActivityService } from "../../src/services/activity";
import { createMessage, persistMessage } from "../../src/services/message";
import { getHomeStats } from "../../src/services/home-stats";
import {
  PresenceService,
  type NatsPresenceBackend,
} from "../../src/services/presence";

function createTestDb(): Database.Database {
  return initDatabase(":memory:");
}

function createFakeNats(): NatsPresenceBackend & {
  store: Map<string, Record<string, unknown>>;
} {
  const store = new Map<string, Record<string, unknown>>();
  return {
    store,
    async updatePresence(agentName: string, data: Record<string, unknown>) {
      store.set(agentName, { ...data, timestamp: new Date().toISOString() });
    },
    async getPresence() {
      return new Map<string, unknown>(store);
    },
  };
}

describe("getHomeStats", () => {
  let db: Database.Database;
  let activity: ActivityService;
  let agents: AgentService;
  let presence: PresenceService;

  beforeEach(() => {
    db = createTestDb();
    activity = new ActivityService(db);
    agents = new AgentService(db, activity);
    presence = new PresenceService(db, createFakeNats());
  });

  it("returns zeros when the DB is empty", async () => {
    const stats = await getHomeStats(db, presence);
    expect(stats).toEqual({
      totalAgents: 0,
      onlineAgents: 0,
      recentMessages: 0,
    });
  });

  it("counts total agents regardless of is_active or presence state", async () => {
    agents.create("a");
    const b = agents.create("b");
    agents.revokeById(b.agent.id); // deactivate b
    agents.create("c");

    const stats = await getHomeStats(db, presence);
    expect(stats.totalAgents).toBe(3);
  });

  it("counts onlineAgents as the number of agents with presence === 'live'", async () => {
    agents.create("liveOne");
    agents.create("staleOne");
    agents.create("offlineOne");
    agents.create("neverOne");

    // liveOne: touched now — in NATS KV → live
    await presence.touch("liveOne");

    // staleOne: last_seen 5 min ago, not in KV → stale
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    db.prepare("UPDATE agents SET last_seen_at = ? WHERE name = ?").run(
      fiveMinAgo,
      "staleOne",
    );

    // offlineOne: last_seen 48h ago, not in KV → offline
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    db.prepare("UPDATE agents SET last_seen_at = ? WHERE name = ?").run(
      twoDaysAgo,
      "offlineOne",
    );

    // neverOne: no touch, no last_seen → never

    const stats = await getHomeStats(db, presence);
    expect(stats.onlineAgents).toBe(1); // only liveOne
    expect(stats.totalAgents).toBe(4);
  });

  it("counts live agents even when they are is_active=0 (presence is independent of auth)", async () => {
    const { agent } = agents.create("zombie");
    await presence.touch("zombie");
    agents.revokeById(agent.id);

    const stats = await getHomeStats(db, presence);
    // zombie is revoked but still in NATS KV → counts as live
    expect(stats.onlineAgents).toBe(1);
  });

  it("counts recentMessages within the last 24h", async () => {
    for (let i = 0; i < 2; i++) {
      const m = createMessage({
        from: "alpha",
        to: "beta",
        type: "info",
        payload: `p${i}`,
        context: "t",
      });
      persistMessage(db, m);
    }
    const old = createMessage({
      from: "alpha",
      to: "beta",
      type: "info",
      payload: "old",
      context: "t",
    });
    old.created_at = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    persistMessage(db, old);

    const stats = await getHomeStats(db, presence);
    expect(stats.recentMessages).toBe(2);
  });
});
