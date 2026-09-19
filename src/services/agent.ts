import crypto from "node:crypto";
import { ulid } from "ulidx";
import type Database from "better-sqlite3";
import type { Agent } from "../types";
import { MAX_AGENTS } from "../types";
import type { ActivityService } from "./activity";
import { log } from "./logger";

// Minimal interface for NATS cleanup — only what AgentService needs.
// Analog to NatsPresence in auth.ts, this keeps the coupling narrow
// and the service unit-testable without a live NATS connection.
// C8: Consumer cleanup on agent lifecycle events (revoke/delete/rename)
// prevents orphaned JetStream consumers from accumulating and eventually
// hitting the per-stream quota.
export interface NatsCleanup {
  deleteConsumer(inboxKey: string): Promise<void>;
}

// An agent's inbox key is born from its name and becomes a NATS subject
// token (`mesh.agents.<key>.inbox`) and part of two JetStream durable names
// (`agent-<key>`, `agent-<key>-broadcast`). NATS subjects forbid spaces /
// `.` / `*` / `>`; durables also forbid `/` and `\`. An unsanitised name
// like "claude code" would silently break routing, so the charset is
// enforced here, at the single source of truth, for names and keys alike.
export const AGENT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/**
 * The same rule for an `<input pattern>`. Written out instead of derived
 * from `AGENT_NAME_RE.source`: HTML compiles patterns with the `v` flag,
 * where a bare trailing `-` inside a character class is a syntax error —
 * and a pattern that fails to compile is ignored, so the field accepts
 * anything. The hyphen is escaped; a test keeps both rules in agreement.
 */
export const AGENT_NAME_PATTERN = "[A-Za-z0-9][A-Za-z0-9_\\-]{0,63}";
/** Wording from the design handoff (COPY.md) — it surfaces in the dashboard. */
export const AGENT_NAME_RULE =
  "1–64 characters: letters, digits, - or _ · must start with a letter or digit · no spaces or dots";

// `broadcast` is the fan-out recipient of mesh_send. `admin` is the operator
// identity: the session-cookie path grants the admin role to that literal
// name, so an agent called "admin" would become an operator by logging in.
const RESERVED_AGENT_NAMES: ReadonlySet<string> = new Set(["admin", "broadcast"]);

export function isReservedAgentName(name: string): boolean {
  return RESERVED_AGENT_NAMES.has(name.toLowerCase());
}

export function reservedNameError(name: string): string {
  return `"${name}" is reserved. Pick another name.`;
}

export function takenNameError(name: string): string {
  return `There's already an agent called ${name}. Pick another name.`;
}

export function isValidAgentName(name: string): boolean {
  return AGENT_NAME_RE.test(name) && !isReservedAgentName(name);
}

/** The NATS address token of an agent. Rows written before migration 0005
 *  ran in the same process, and hand-built fixtures, may lack the column —
 *  their address is what it always was, the lower-cased name. */
export function inboxKeyOf(agent: { name: string; inbox_key?: string | null }): string {
  return agent.inbox_key ?? agent.name.toLowerCase();
}

const BROADCAST_DURABLE_SUFFIX = "-broadcast";
const KEY_SUFFIX_CHARS = 8;

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// In-memory cache: token_hash -> Agent (cleared on mutations)
let tokenCache = new Map<string, Agent>();

export function clearTokenCache(): void {
  tokenCache = new Map();
}

function generateToken(): string {
  const bytes = crypto.randomBytes(32);
  return (
    "bt_" +
    Array.from(bytes)
      .map((b) => b.toString(36))
      .join("")
      .slice(0, 32)
  );
}

export class AgentService {
  constructor(
    private db: Database.Database,
    private activity: ActivityService,
    private nats?: NatsCleanup,
  ) {}

  /**
   * Best-effort cleanup of NATS durable consumers for an agent, addressed
   * by inbox key. Called from revoke/delete — NOT from rename: the key, and
   * with it the consumers and any unread mail, survives a rename. Never
   * throws — failures are logged so the lifecycle operation still succeeds.
   */
  private cleanupNatsConsumers(inboxKey: string, context: string): void {
    if (!this.nats) return;
    this.nats.deleteConsumer(inboxKey).catch((err) => {
      log("warn", "nats consumer cleanup failed", {
        inbox_key: inboxKey,
        context,
        err: String(err),
      });
    });
  }

  /** Throws the user-facing reason when `name` cannot be used. */
  private assertUsableName(name: string): void {
    if (isReservedAgentName(name)) throw new Error(reservedNameError(name));
    if (!AGENT_NAME_RE.test(name)) throw new Error(AGENT_NAME_RULE);
  }

  /**
   * The address for a new agent: its lower-cased name, unless that key is
   * still held by an agent that was renamed away from the name, or would
   * collide with a broadcast durable. `agent-<key>-broadcast` is both the
   * broadcast durable of `<key>` and the inbox durable of an agent keyed
   * `<key>-broadcast`, so the guard runs in both directions: no new key ends
   * in the suffix, and none is a prefix of an existing `…-broadcast` key.
   * Then a short unique suffix keeps the two inboxes apart.
   */
  private allocateInboxKey(name: string): string {
    const base = name.toLowerCase();
    const held = this.db
      .prepare("SELECT 1 FROM agents WHERE inbox_key IN (?, ?)")
      .get(base, base + BROADCAST_DURABLE_SUFFIX);
    if (!held && !base.endsWith(BROADCAST_DURABLE_SUFFIX)) return base;
    const suffix = ulid().toLowerCase().slice(-KEY_SUFFIX_CHARS);
    const room = 64 - KEY_SUFFIX_CHARS - 1;
    return `${base.slice(0, room)}-${suffix}`;
  }

  create(
    name: string,
    avatar?: string,
    adminName?: string,
  ): { agent: Agent; plaintextToken: string } {
    // NATS-safety: reject names that would corrupt subject/durable routing.
    this.assertUsableName(name);

    // Check max agents limit
    const count = this.db
      .prepare("SELECT COUNT(*) as cnt FROM agents WHERE is_active = 1")
      .get() as { cnt: number };
    if (count.cnt >= MAX_AGENTS) {
      throw new Error(`Maximum number of agents (${MAX_AGENTS}) reached`);
    }

    const id = ulid();
    const now = new Date().toISOString();
    const plaintextToken = generateToken();
    const token_hash = hashToken(plaintextToken);
    const inbox_key = this.allocateInboxKey(name);

    this.db
      .prepare(
        `INSERT INTO agents (id, name, inbox_key, name_since, avatar, token_hash, is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(id, name, inbox_key, now, avatar ?? null, token_hash, now, now);

    clearTokenCache();

    this.activity.log({
      action: "agent_created",
      entity_type: "agent",
      entity_id: id,
      summary: `Agent "${name}" created`,
      agent_name: adminName,
    });

    const agent: Agent = {
      id,
      name,
      inbox_key,
      name_since: now,
      role: null,
      capabilities: null,
      token_hash,
      is_active: 1,
      avatar: avatar ?? null,
      working_on: null,
      last_seen_at: null,
      created_at: now,
      updated_at: now,
    };

    return { agent, plaintextToken };
  }

  list(): Omit<Agent, "token_hash">[] {
    return this.db
      .prepare(
        "SELECT id, name, inbox_key, role, capabilities, is_active, avatar, working_on, last_seen_at, created_at, updated_at FROM agents ORDER BY name",
      )
      .all() as Omit<Agent, "token_hash">[];
  }

  getByName(name: string): Agent | null {
    const row = this.db
      .prepare("SELECT * FROM agents WHERE name = ? COLLATE NOCASE")
      .get(name) as Agent | undefined;
    return row ?? null;
  }

  getByTokenHash(hash: string): Agent | null {
    // Check cache first
    const cached = tokenCache.get(hash);
    if (cached) return cached;

    const row = this.db
      .prepare("SELECT * FROM agents WHERE token_hash = ? AND is_active = 1")
      .get(hash) as Agent | undefined;

    if (row) {
      tokenCache.set(hash, row);
    }

    return row ?? null;
  }

  revokeById(id: string, adminName?: string): boolean {
    const agent = this.db
      .prepare("SELECT name, inbox_key FROM agents WHERE id = ?")
      .get(id) as { name: string; inbox_key: string | null } | undefined;

    if (!agent) return false;

    const now = new Date().toISOString();
    const result = this.db
      .prepare("UPDATE agents SET is_active = 0, updated_at = ? WHERE id = ?")
      .run(now, id);

    clearTokenCache();

    if (result.changes > 0) {
      this.activity.log({
        action: "agent_revoked",
        entity_type: "agent",
        entity_id: id,
        summary: `Agent "${agent.name}" revoked`,
        agent_name: adminName,
      });
      // C8: Clean up NATS consumers so revoked agents don't leak
      // durable subscriptions. Fire-and-forget, non-blocking.
      this.cleanupNatsConsumers(inboxKeyOf(agent), "revoke");
      return true;
    }

    return false;
  }

  reactivate(
    id: string,
    adminName?: string,
  ): { plaintextToken: string } | null {
    const agent = this.db
      .prepare("SELECT name, is_active FROM agents WHERE id = ?")
      .get(id) as { name: string; is_active: number } | undefined;

    if (!agent || agent.is_active === 1) return null;

    const now = new Date().toISOString();
    const plaintextToken = generateToken();
    const token_hash = hashToken(plaintextToken);

    this.db
      .prepare(
        "UPDATE agents SET is_active = 1, token_hash = ?, updated_at = ? WHERE id = ?",
      )
      .run(token_hash, now, id);

    clearTokenCache();

    this.activity.log({
      action: "agent_reactivated",
      entity_type: "agent",
      entity_id: id,
      summary: `Agent "${agent.name}" reactivated with new token`,
      agent_name: adminName,
    });

    return { plaintextToken };
  }

  /**
   * Change the label, keep the address. The inbox key — and with it the
   * JetStream consumers, unread mail and the token — stays exactly as it
   * was, so nothing has to move inside NATS and a rename works even while
   * the broker is down.
   *
   * Message history is rewritten to the new name in the same transaction:
   * threads group by participant name and `mesh_reply` resolves the
   * recipient from `from_agent`, so a half-renamed history would split
   * conversations and strand replies. Only rows written since this agent
   * took the name (`name_since`) are touched — before that the name may
   * have belonged to another, since deleted agent, even during this
   * agent's own lifetime. The audit trail is never rewritten; it records
   * the rename itself.
   *
   * Returns false when the agent does not exist, true otherwise — also for
   * an unchanged name, which is a no-op without a write or an audit entry.
   */
  rename(id: string, newName: string, adminName?: string): boolean {
    const agent = this.db
      .prepare("SELECT name, inbox_key, created_at, name_since FROM agents WHERE id = ?")
      .get(id) as
      | { name: string; inbox_key: string | null; created_at: string; name_since: string | null }
      | undefined;

    if (!agent) return false;
    if (newName === agent.name) return true;

    this.assertUsableName(newName);

    const taken = this.db
      .prepare("SELECT id FROM agents WHERE name = ? COLLATE NOCASE AND id != ?")
      .get(newName, id) as { id: string } | undefined;
    if (taken) {
      throw new Error(takenNameError(newName));
    }

    const oldName = agent.name;
    const heldSince = agent.name_since ?? agent.created_at;
    const now = new Date().toISOString();
    const renamed = this.db.transaction((): boolean => {
      // A row can lack a key when it was created by a build from before
      // migration 0005 after a rollback. Pin it to the address it has been
      // using BEFORE the label moves, or the rename would move the address
      // too — the very bug the key exists to prevent.
      if (agent.inbox_key === null) {
        const current = oldName.toLowerCase();
        const taken = this.db
          .prepare("SELECT 1 FROM agents WHERE inbox_key = ? AND id != ?")
          .get(current, id);
        this.db
          .prepare("UPDATE agents SET inbox_key = ? WHERE id = ?")
          .run(taken ? this.allocateInboxKey(oldName) : current, id);
      }
      const result = this.db
        .prepare("UPDATE agents SET name = ?, name_since = ?, updated_at = ? WHERE id = ?")
        .run(newName, now, now, id);
      if (result.changes === 0) return false;
      this.db
        .prepare(
          "UPDATE messages SET from_agent = ? WHERE from_agent = ? COLLATE NOCASE AND created_at >= ?",
        )
        .run(newName, oldName, heldSince);
      this.db
        .prepare(
          "UPDATE messages SET to_agent = ? WHERE to_agent = ? COLLATE NOCASE AND created_at >= ?",
        )
        .run(newName, oldName, heldSince);
      return true;
    })();

    clearTokenCache();

    if (!renamed) return false;

    this.activity.log({
      action: "agent_renamed",
      entity_type: "agent",
      entity_id: id,
      summary: `Agent "${oldName}" renamed to "${newName}"`,
      agent_name: adminName,
    });
    return true;
  }

  deleteById(id: string, adminName?: string): boolean {
    const agent = this.db
      .prepare("SELECT name, inbox_key FROM agents WHERE id = ?")
      .get(id) as { name: string; inbox_key: string | null } | undefined;

    if (!agent) return false;

    const result = this.db
      .prepare("DELETE FROM agents WHERE id = ?")
      .run(id);

    clearTokenCache();

    if (result.changes > 0) {
      // C8: Clean up NATS consumers for the deleted agent.
      this.cleanupNatsConsumers(inboxKeyOf(agent), "delete");
      this.activity.log({
        action: "agent_deleted",
        entity_type: "agent",
        entity_id: id,
        summary: `Agent "${agent.name}" deleted`,
        agent_name: adminName,
      });
      return true;
    }

    return false;
  }

  resetToken(
    id: string,
    adminName?: string,
  ): { plaintextToken: string } | null {
    const agent = this.db
      .prepare("SELECT name, is_active FROM agents WHERE id = ?")
      .get(id) as { name: string; is_active: number } | undefined;

    if (!agent || agent.is_active !== 1) return null;

    const now = new Date().toISOString();
    const plaintextToken = generateToken();
    const token_hash = hashToken(plaintextToken);

    this.db
      .prepare("UPDATE agents SET token_hash = ?, updated_at = ? WHERE id = ?")
      .run(token_hash, now, id);

    clearTokenCache();

    this.activity.log({
      action: "agent_token_reset",
      entity_type: "agent",
      entity_id: id,
      summary: `Token reset for agent "${agent.name}"`,
      agent_name: adminName,
    });

    return { plaintextToken };
  }

}
