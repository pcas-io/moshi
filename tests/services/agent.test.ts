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
    expect(() => agents.create("claude code")).toThrow(/letters, digits/);
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
      expect(() => agents.rename(agent.id, bad)).toThrow(/letters, digits/);
    }
    expect(agents.getByName("agent-a")?.name).toBe("agent-a");
  });

  it("refuses to rename onto an existing name (case-insensitive) with a readable error", () => {
    const { agent } = agents.create("agent-a");
    agents.create("agent-b");
    expect(() => agents.rename(agent.id, "AGENT-B")).toThrow(/already an agent called/);
    // Pure case change of the own name stays allowed.
    expect(agents.rename(agent.id, "Agent-A")).toBe(true);
    expect(agents.getByName("agent-a")?.name).toBe("Agent-A");
  });

  // ── The inbox key: the address stays, the name is a label ───────
  // Names used to BE the NATS address (subject + durable names), so a
  // rename moved the agent away from its own unread mail. The key is
  // assigned once and never changes.

  function keyOf(name: string): string | null {
    const row = db.prepare("SELECT inbox_key FROM agents WHERE name = ? COLLATE NOCASE").get(name) as
      | { inbox_key: string | null }
      | undefined;
    return row?.inbox_key ?? null;
  }

  function insertMessage(id: string, from: string, to: string, createdAt: string): void {
    db.prepare(
      `INSERT INTO messages (id, from_agent, to_agent, type, payload, context, created_at)
       VALUES (?, ?, ?, 'info', 'p', 'c', ?)`,
    ).run(id, from, to, createdAt);
  }

  it("gives a new agent an inbox key derived from its name, lower-cased", () => {
    const { agent } = agents.create("Dex-EU");
    expect(agent.inbox_key).toBe("dex-eu");
    expect(keyOf("Dex-EU")).toBe("dex-eu");
    expect(agents.getByName("dex-eu")?.inbox_key).toBe("dex-eu");
  });

  it("keeps the inbox key across a rename", () => {
    const { agent } = agents.create("scout");
    agents.rename(agent.id, "scout-eu");
    expect(keyOf("scout-eu")).toBe("scout");
  });

  it("hands a fresh key to a new agent that reuses a renamed agent's old name", () => {
    const { agent } = agents.create("scout");
    agents.rename(agent.id, "scout-eu");
    const second = agents.create("scout").agent;
    expect(second.inbox_key).not.toBe("scout");
    expect(second.inbox_key.startsWith("scout-")).toBe(true);
    expect(isValidAgentName(second.inbox_key)).toBe(true); // still NATS-safe
    expect(keyOf("scout-eu")).toBe("scout");
  });

  it("never lets a key end in -broadcast: that is another agent's broadcast durable", () => {
    agents.create("ops");
    const { agent } = agents.create("ops-broadcast");
    expect(agent.inbox_key.endsWith("-broadcast")).toBe(false);
    expect(agent.inbox_key.startsWith("ops-broadcast-")).toBe(true);
  });

  it("keeps a suffixed key inside the 64-character name shape", () => {
    const long = "a".repeat(64);
    const { agent } = agents.create(long);
    agents.rename(agent.id, "short");
    const second = agents.create(long).agent;
    expect(second.inbox_key.length).toBeLessThanOrEqual(64);
    expect(second.inbox_key).not.toBe(long);
  });

  it("rewrites message history to the new name, whatever case the sender typed", () => {
    const { agent } = agents.create("scout");
    const after = new Date(Date.parse(agent.created_at) + 1000).toISOString();
    insertMessage("m1", "scout", "ops", after);
    insertMessage("m2", "ops", "SCOUT", after);
    insertMessage("m3", "ops", "someone-else", after);
    agents.rename(agent.id, "scout-eu");
    const rows = db.prepare("SELECT id, from_agent, to_agent FROM messages ORDER BY id").all();
    expect(rows).toEqual([
      { id: "m1", from_agent: "scout-eu", to_agent: "ops" },
      { id: "m2", from_agent: "ops", to_agent: "scout-eu" },
      { id: "m3", from_agent: "ops", to_agent: "someone-else" },
    ]);
  });

  it("leaves rows that predate the agent alone: they belong to an earlier holder of the name", () => {
    insertMessage("old", "scout", "ops", "2020-01-01T00:00:00.000Z");
    const { agent } = agents.create("scout");
    agents.rename(agent.id, "scout-eu");
    expect(db.prepare("SELECT from_agent FROM messages WHERE id = 'old'").get()).toEqual({ from_agent: "scout" });
  });

  it("never rewrites the audit trail", () => {
    const { agent } = agents.create("scout");
    activity.log({ action: "message_sent", entity_type: "message", entity_id: "m1", summary: "scout → ops", agent_name: "scout" });
    agents.rename(agent.id, "scout-eu");
    const names = db.prepare("SELECT agent_name FROM activity_log WHERE action = 'message_sent'").all();
    expect(names).toEqual([{ agent_name: "scout" }]);
  });

  it("rejects reserved names on create and rename, in any case", () => {
    const { agent } = agents.create("agent-a");
    for (const reserved of ["admin", "Admin", "broadcast", "BROADCAST"]) {
      expect(isValidAgentName(reserved)).toBe(false);
      expect(() => agents.create(reserved)).toThrow(/reserved/);
      expect(() => agents.rename(agent.id, reserved)).toThrow(/reserved/);
    }
    expect(agents.getByName("agent-a")?.name).toBe("agent-a");
  });

  it("speaks English in its errors: they surface in the dashboard", () => {
    expect(() => agents.create("claude code")).toThrow(/letters, digits/);
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

  it("leaves the consumers alone on rename: deleting them orphaned unread mail", async () => {
    const { agents, calls } = setup();
    const { agent } = agents.create("cleanup-old");
    agents.rename(agent.id, "cleanup-new");
    await new Promise((r) => setImmediate(r));
    expect(calls).toHaveLength(0);
  });

  it("cleans up by inbox key, so a renamed agent's consumers are still found", async () => {
    const { agents, calls } = setup();
    const { agent } = agents.create("cleanup-old");
    agents.rename(agent.id, "cleanup-new");
    agents.revokeById(agent.id);
    await new Promise((r) => setImmediate(r));
    expect(calls).toEqual([{ agent: "cleanup-old" }]);
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
