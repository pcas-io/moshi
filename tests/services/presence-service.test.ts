import { describe, it, expect, beforeEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { initDatabase } from "../../src/services/db";
import { AgentService } from "../../src/services/agent";
import { ActivityService } from "../../src/services/activity";
import {
  PresenceService,
  type NatsPresenceBackend,
} from "../../src/services/presence";

function createTestDb(): Database.Database {
  return initDatabase(":memory:");
}

/**
 * Fake NATS KV presence bucket. Stores the last-written payload per agent
 * and models the real `NatsService` surface the presence service needs.
 */
function createFakeNats(): NatsPresenceBackend & {
  store: Map<string, Record<string, unknown>>;
  updateFailures: number;
  failOnUpdate: boolean;
  failOnGet: boolean;
} {
  const store = new Map<string, Record<string, unknown>>();
  const self = {
    store,
    updateFailures: 0,
    failOnUpdate: false,
    failOnGet: false,
    async updatePresence(agentName: string, data: Record<string, unknown>) {
      if (self.failOnUpdate) {
        self.updateFailures++;
        throw new Error("nats unavailable");
      }
      store.set(agentName, {
        ...data,
        timestamp: new Date().toISOString(),
      });
    },
    async getPresence() {
      if (self.failOnGet) throw new Error("nats unavailable");
      return new Map<string, unknown>(store);
    },
  };
  return self;
}

describe("PresenceService.touch", () => {
  let db: Database.Database;
  let activity: ActivityService;
  let agents: AgentService;
  let nats: ReturnType<typeof createFakeNats>;
  let presence: PresenceService;

  beforeEach(() => {
    db = createTestDb();
    activity = new ActivityService(db);
    agents = new AgentService(db, activity);
    nats = createFakeNats();
    presence = new PresenceService(db, nats);
    agents.create("alpha");
  });

  it("updates SQLite last_seen_at on touch", async () => {
    await presence.touch("alpha");
    const row = db
      .prepare("SELECT last_seen_at FROM agents WHERE name = ?")
      .get("alpha") as { last_seen_at: string | null };
    expect(row.last_seen_at).toBeTruthy();
    const deltaMs = Date.now() - new Date(row.last_seen_at!).getTime();
    expect(deltaMs).toBeLessThan(5000);
  });

  it("writes to NATS KV on touch", async () => {
    await presence.touch("alpha", {
      role: "deployer",
      capabilities: ["deploy", "rollback"],
      working_on: "prod release",
    });
    const entry = nats.store.get("alpha");
    expect(entry).toBeDefined();
    expect(entry!.role).toBe("deployer");
    expect(entry!.capabilities).toEqual(["deploy", "rollback"]);
    expect(entry!.working_on).toBe("prod release");
  });

  it("matches agent name case-insensitively on SQLite update", async () => {
    await presence.touch("ALPHA");
    const row = db
      .prepare("SELECT last_seen_at FROM agents WHERE name = ?")
      .get("alpha") as { last_seen_at: string | null };
    expect(row.last_seen_at).toBeTruthy();
  });

  it("persists role / capabilities / working_on to SQLite when supplied", async () => {
    await presence.touch("alpha", {
      role: "deployer",
      capabilities: ["deploy"],
      working_on: "release",
    });
    const row = db
      .prepare("SELECT role, capabilities, working_on FROM agents WHERE name = ?")
      .get("alpha") as {
      role: string | null;
      capabilities: string | null;
      working_on: string | null;
    };
    expect(row.role).toBe("deployer");
    expect(JSON.parse(row.capabilities!)).toEqual(["deploy"]);
    expect(row.working_on).toBe("release");
  });

  it("touching only with last_seen (no meta) does not overwrite existing role", async () => {
    await presence.touch("alpha", { role: "deployer" });
    await presence.touch("alpha"); // second touch, no meta
    const row = db
      .prepare("SELECT role FROM agents WHERE name = ?")
      .get("alpha") as { role: string | null };
    expect(row.role).toBe("deployer");
  });

  it("NATS KV failure is swallowed and does not throw — SQLite still updated", async () => {
    nats.failOnUpdate = true;
    await expect(presence.touch("alpha")).resolves.toBeUndefined();
    expect(nats.updateFailures).toBe(1);
    const row = db
      .prepare("SELECT last_seen_at FROM agents WHERE name = ?")
      .get("alpha") as { last_seen_at: string | null };
    expect(row.last_seen_at).toBeTruthy();
  });
});

describe("PresenceService.list", () => {
  let db: Database.Database;
  let activity: ActivityService;
  let agents: AgentService;
  let nats: ReturnType<typeof createFakeNats>;
  let presence: PresenceService;

  beforeEach(() => {
    db = createTestDb();
    activity = new ActivityService(db);
    agents = new AgentService(db, activity);
    nats = createFakeNats();
    presence = new PresenceService(db, nats);
  });

  it("returns empty list when no agents registered", async () => {
    const result = await presence.list();
    expect(result).toEqual([]);
  });

  it("classifies an agent with an active NATS KV entry as live", async () => {
    agents.create("alpha");
    await presence.touch("alpha", { role: "deployer" });
    const result = await presence.list();
    expect(result).toHaveLength(1);
    expect(result[0].agent.name).toBe("alpha");
    expect(result[0].presence).toBe("live");
    expect(result[0].liveMeta).toEqual({
      role: "deployer",
      capabilities: undefined,
      working_on: undefined,
    });
  });

  it("classifies an agent never seen and not in KV as never", async () => {
    agents.create("alpha");
    // No touch, no last_seen_at
    const result = await presence.list();
    expect(result[0].presence).toBe("never");
    expect(result[0].liveMeta).toBeNull();
    expect(result[0].effectiveLastSeen).toBeNull();
  });

  it("classifies an agent last seen 1h ago (not in KV) as stale", async () => {
    agents.create("alpha");
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    db.prepare("UPDATE agents SET last_seen_at = ? WHERE name = ?").run(
      oneHourAgo,
      "alpha",
    );
    const result = await presence.list();
    expect(result[0].presence).toBe("stale");
    expect(result[0].effectiveLastSeen).toBe(oneHourAgo);
  });

  it("classifies an agent last seen 48h ago (not in KV) as offline", async () => {
    agents.create("alpha");
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    db.prepare("UPDATE agents SET last_seen_at = ? WHERE name = ?").run(
      twoDaysAgo,
      "alpha",
    );
    const result = await presence.list();
    expect(result[0].presence).toBe("offline");
  });

  it("uses NATS KV timestamp for effectiveLastSeen when live", async () => {
    agents.create("alpha");
    const oldIso = new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString();
    db.prepare("UPDATE agents SET last_seen_at = ? WHERE name = ?").run(
      oldIso,
      "alpha",
    );
    // Now touch — NATS KV gets a fresh timestamp
    await presence.touch("alpha");
    const result = await presence.list();
    expect(result[0].presence).toBe("live");
    // effectiveLastSeen should come from KV (recent), not from old SQLite row
    expect(new Date(result[0].effectiveLastSeen!).getTime()).toBeGreaterThan(
      new Date(oldIso).getTime(),
    );
  });

  it("degrades to db-only presence when NATS KV read fails", async () => {
    agents.create("alpha");
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    db.prepare("UPDATE agents SET last_seen_at = ? WHERE name = ?").run(
      fiveMinAgo,
      "alpha",
    );
    nats.failOnGet = true;
    const result = await presence.list();
    expect(result).toHaveLength(1);
    // NATS unavailable ⇒ not live. last_seen_at < 24h ⇒ stale.
    expect(result[0].presence).toBe("stale");
  });

  it("returns revoked agents in the list (is_active is independent of presence)", async () => {
    const { agent } = agents.create("alpha");
    await presence.touch("alpha");
    agents.revokeById(agent.id);
    const result = await presence.list();
    expect(result).toHaveLength(1);
    // Still shows up, and it's still live — is_active=0 does not flip presence
    expect(result[0].presence).toBe("live");
    expect(result[0].agent.is_active).toBe(0);
  });
});

describe("PresenceService.countByState", () => {
  let db: Database.Database;
  let activity: ActivityService;
  let agents: AgentService;
  let nats: ReturnType<typeof createFakeNats>;
  let presence: PresenceService;

  beforeEach(() => {
    db = createTestDb();
    activity = new ActivityService(db);
    agents = new AgentService(db, activity);
    nats = createFakeNats();
    presence = new PresenceService(db, nats);
  });

  it("returns all zeros for an empty mesh", async () => {
    const counts = await presence.countByState();
    expect(counts).toEqual({ live: 0, stale: 0, offline: 0, never: 0 });
  });

  it("counts 1 live, 1 stale, 1 offline, 1 never", async () => {
    agents.create("liveOne");
    agents.create("staleOne");
    agents.create("offlineOne");
    agents.create("neverOne");

    await presence.touch("liveOne");

    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    db.prepare("UPDATE agents SET last_seen_at = ? WHERE name = ?").run(
      fiveMinAgo,
      "staleOne",
    );

    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    db.prepare("UPDATE agents SET last_seen_at = ? WHERE name = ?").run(
      twoDaysAgo,
      "offlineOne",
    );
    // neverOne: no touch, no last_seen_at

    const counts = await presence.countByState();
    expect(counts).toEqual({ live: 1, stale: 1, offline: 1, never: 1 });
  });
});
