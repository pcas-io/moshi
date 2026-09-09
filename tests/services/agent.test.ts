import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "fs";
import { AgentService, hashToken, isValidAgentName } from "../../src/services/agent";
import { ActivityService } from "../../src/services/activity";

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  const migrationFiles = readdirSync("migrations").filter((f) => f.endsWith(".sql")).sort();
  for (const file of migrationFiles) {
    db.exec(readFileSync(`migrations/${file}`, "utf-8"));
  }
  return db;
}

describe("AgentService", () => {
  let db: Database.Database;
  let activity: ActivityService;
  let agents: AgentService;

  beforeEach(() => {
    db = createTestDb();
    activity = new ActivityService(db);
    agents = new AgentService(db, activity);
  });

  it("validates agent names (NATS subject/durable safety)", () => {
    // Valid
    for (const n of ["agent-a", "Agent-A", "dex_eu", "claude-code", "a1", "x"]) {
      expect(isValidAgentName(n)).toBe(true);
    }
    // Invalid — would corrupt mesh.agents.<name>.inbox / agent-<name>
    for (const n of ["claude code", "a.b", "-lead", "a/b", "a*b", "a>b", "a b", ""]) {
      expect(isValidAgentName(n)).toBe(false);
    }
  });

  it("create() rejects a name with a space", () => {
    expect(() => agents.create("claude code")).toThrow(/NATS|Leerzeichen|2.64/);
    // and nothing was persisted
    expect(agents.getByName("claude code")).toBeNull();
  });

  it("creates agent with token", () => {
    const result = agents.create("agent-a");
    expect(result.agent.name).toBe("agent-a");
    expect(result.plaintextToken).toMatch(/^bt_/);
    expect(result.plaintextToken.length).toBeGreaterThanOrEqual(35);
  });

  it("rejects duplicate names case-insensitively", () => {
    agents.create("Agent-A");
    expect(() => agents.create("agent-a")).toThrow();
  });

  it("finds agent by token hash", () => {
    const { plaintextToken } = agents.create("agent-a");
    const hash = hashToken(plaintextToken);
    const found = agents.getByTokenHash(hash);
    expect(found?.name).toBe("agent-a");
  });

  it("deactivated agent not found by token", () => {
    const { agent, plaintextToken } = agents.create("agent-a");
    agents.revokeById(agent.id);
    const found = agents.getByTokenHash(hashToken(plaintextToken));
    expect(found).toBeNull();
  });

  it("finds agent by name case-insensitively", () => {
    agents.create("Agent-A");
    const found = agents.getByName("agent-a");
    expect(found?.name).toBe("Agent-A");
  });

  it("reactivates with new token", () => {
    const { agent } = agents.create("agent-a");
    agents.revokeById(agent.id);
    const result = agents.reactivate(agent.id);
    expect(result).not.toBeNull();
    expect(result!.plaintextToken).toMatch(/^bt_/);
    const found = agents.getByTokenHash(hashToken(result!.plaintextToken));
    expect(found?.is_active).toBe(1);
  });

  it("resets token", () => {
    const { agent, plaintextToken: oldToken } = agents.create("agent-a");
    const result = agents.resetToken(agent.id);
    expect(result).not.toBeNull();
    expect(agents.getByTokenHash(hashToken(oldToken))).toBeNull();
    expect(
      agents.getByTokenHash(hashToken(result!.plaintextToken))?.name,
    ).toBe("agent-a");
  });

  it("renames agent", () => {
    const { agent } = agents.create("agent-a");
    const renamed = agents.rename(agent.id, "agent-b");
    expect(renamed).toBe(true);
    const found = agents.getByName("agent-b");
    expect(found?.name).toBe("agent-b");
    expect(agents.getByName("agent-a")).toBeNull();
  });

  it("rejects NATS-unsafe names on rename, like create does (C6)", () => {
    const { agent } = agents.create("agent-a");
    for (const bad of ["claude code", "a.b", "*", "", "x/y"]) {
      expect(() => agents.rename(agent.id, bad)).toThrow(/NATS/);
    }
    expect(agents.getByName("agent-a")?.name).toBe("agent-a");
  });

  it("refuses to rename onto an existing name (case-insensitive) with a readable error", () => {
    const { agent } = agents.create("agent-a");
    agents.create("agent-b");
    expect(() => agents.rename(agent.id, "AGENT-B")).toThrow(/bereits vergeben/);
    // Pure case change of the own name stays allowed.
    expect(agents.rename(agent.id, "Agent-A")).toBe(true);
    expect(agents.getByName("agent-a")?.name).toBe("Agent-A");
  });

  it("lists agents without token_hash", () => {
    agents.create("agent-b");
    agents.create("agent-a");
    const list = agents.list();
    expect(list).toHaveLength(2);
    expect(list[0].name).toBe("agent-a");
    expect(list[1].name).toBe("agent-b");
    expect((list[0] as any).token_hash).toBeUndefined();
  });
});

// C8: NATS consumer cleanup hooks fire on revoke/delete/rename.
// Uses a fake NatsCleanup implementation that records invocations.
describe("AgentService NATS consumer cleanup (C8)", () => {
  interface Call {
    agent: string;
  }

  function setup() {
    const calls: Call[] = [];
    const fakeNats = {
      deleteConsumer: async (agent: string) => {
        calls.push({ agent });
      },
    };
    const db = createTestDb();
    const activity = new ActivityService(db);
    const agents = new AgentService(db, activity, fakeNats);
    return { agents, calls };
  }

  it("calls deleteConsumer on revoke", async () => {
    const { agents, calls } = setup();
    const { agent } = agents.create("cleanup-a");
    agents.revokeById(agent.id);
    // fire-and-forget — wait for the microtask to resolve
    await new Promise((r) => setImmediate(r));
    expect(calls).toHaveLength(1);
    expect(calls[0].agent).toBe("cleanup-a");
  });

  it("calls deleteConsumer on deleteById", async () => {
    const { agents, calls } = setup();
    const { agent } = agents.create("cleanup-b");
    agents.deleteById(agent.id);
    await new Promise((r) => setImmediate(r));
    expect(calls).toHaveLength(1);
    expect(calls[0].agent).toBe("cleanup-b");
  });

  it("calls deleteConsumer with OLD name on rename", async () => {
    const { agents, calls } = setup();
    const { agent } = agents.create("cleanup-old");
    agents.rename(agent.id, "cleanup-new");
    await new Promise((r) => setImmediate(r));
    // Old consumer is deleted; a new one will be lazily created on the
    // next MCP call under the new name via ensureConsumer.
    expect(calls).toHaveLength(1);
    expect(calls[0].agent).toBe("cleanup-old");
  });

  it("does not call deleteConsumer on reactivate", async () => {
    const { agents, calls } = setup();
    const { agent } = agents.create("cleanup-c");
    agents.revokeById(agent.id);
    agents.reactivate(agent.id);
    await new Promise((r) => setImmediate(r));
    // Only the revoke triggers cleanup; reactivate keeps the same name
    // and ensureConsumer will recreate the consumer on the next MCP call.
    expect(calls).toHaveLength(1);
    expect(calls[0].agent).toBe("cleanup-c");
  });

  it("swallows deleteConsumer errors without breaking the lifecycle op", async () => {
    const calls: Call[] = [];
    const flakyNats = {
      deleteConsumer: async (agent: string) => {
        calls.push({ agent });
        throw new Error("nats down");
      },
    };
    const db = createTestDb();
    const activity = new ActivityService(db);
    const agents = new AgentService(db, activity, flakyNats);

    const { agent } = agents.create("cleanup-d");
    // The revoke itself must still succeed even though cleanup throws.
    const result = agents.revokeById(agent.id);
    await new Promise((r) => setImmediate(r));
    expect(result).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("works without nats dependency (backwards compat)", async () => {
    // AgentService must still function when no NatsCleanup is provided.
    // Both revoke (sets is_active=0) and delete (hard-removes) should
    // complete without errors, and renamed/reactivated should too.
    const db = createTestDb();
    const activity = new ActivityService(db);
    const agents = new AgentService(db, activity);
    const { agent } = agents.create("no-nats");
    expect(agents.revokeById(agent.id)).toBe(true);
    // revoke does not delete — the row is still there with is_active=0
    expect(agents.deleteById(agent.id)).toBe(true);
  });
});
