/**
 * Agent Presence — single source of truth.
 *
 * Presence is a derived 4-state signal combining two backing stores:
 *
 * - **NATS KV `mesh-presence` bucket** (auto-expires after `liveMs`): the
 *   "is the agent currently running" signal. Written on any agent
 *   interaction (auth middleware, MCP tool calls). Missing ⇒ not live.
 * - **SQLite `agents.last_seen_at`** (persistent, never cleared): the
 *   audit-trail of when the agent was last seen ever. Used to distinguish
 *   "recently dead" (stale) from "long gone" (offline) from "never used"
 *   (never).
 *
 * Together the two stores derive the `Presence` state via the pure
 * `computePresenceState` function below. This is the ONLY place presence
 * is computed — views, the `/mesh_status` MCP tool, the home dashboard
 * stats and the `/agents` admin table all funnel through here.
 *
 * The `is_active` column on `agents` is NOT part of presence. It's a pure
 * authentication signal ("does the token still work"). Mixing it into
 * presence queries is a bug — a revoked-but-recently-seen agent is still
 * "stale", not "online", and a never-revoked-but-never-seen agent is
 * "never", not "online".
 *
 * Subsequent commits in this refactor add a `PresenceService` class on
 * top of this pure layer that owns the single write-path (`touch()`) and
 * the single read-path (`list()` / `countByState()`).
 */

import type Database from "better-sqlite3";
import type { Agent } from "../types.js";
import { log } from "./logger.js";

export type Presence = "live" | "stale" | "offline" | "never";

/**
 * Time windows that define the state transitions. Centralised so that
 * changing the NATS KV TTL in one place (`nats.ts`) and the stale
 * threshold here gives a consistent answer everywhere.
 *
 * - `liveMs`  — matches the NATS KV bucket TTL (600s = 10min). If the
 *   agent is present in KV, it's live. This is authoritative.
 * - `staleMs` — how long after the last signal an agent still counts as
 *   "recently dead" before being declared offline. 24h is a compromise
 *   between "quick cleanup" and "don't lose context during a maintenance
 *   window".
 */
export const PRESENCE_THRESHOLDS = {
  liveMs: 600_000, // 10 min, equals KV_TTL_MS in nats.ts
  staleMs: 24 * 60 * 60 * 1000, // 24h
} as const;

export interface PresenceMeta {
  role?: string;
  capabilities?: string[];
  working_on?: string;
}

/** An agent joined with its computed presence state — the shape every
 *  view/API layer should consume once the service class is wired in. */
export interface AgentWithPresence {
  agent: Agent;
  presence: Presence;
  /** NATS KV metadata if the agent is live, otherwise null. */
  liveMeta: PresenceMeta | null;
  /** Effective last-seen timestamp: NATS KV `timestamp` if live,
   *  otherwise the SQLite `last_seen_at`. Null only if truly never seen. */
  effectiveLastSeen: string | null;
}

/**
 * Pure presence-state calculation. Takes the KV presence signal and the
 * last_seen_at timestamp; returns the 4-state. Kept pure so it's trivial
 * to unit-test without NATS or SQLite.
 */
export function computePresenceState(
  inPresenceKV: boolean,
  lastSeenAt: string | null,
  now: number = Date.now(),
  thresholds: { staleMs: number } = PRESENCE_THRESHOLDS,
): Presence {
  if (inPresenceKV) return "live";
  if (!lastSeenAt) return "never";
  const lastSeenMs = Date.parse(lastSeenAt);
  if (Number.isNaN(lastSeenMs)) return "never";
  if (now - lastSeenMs < thresholds.staleMs) return "stale";
  return "offline";
}

// ─────────────────────────────────────────────────────────────────────
// PresenceService — single write path + single read path
// ─────────────────────────────────────────────────────────────────────

/**
 * Minimal NATS surface the presence service needs. The real `NatsService`
 * implements this; tests can pass a plain object with the same shape.
 */
export interface NatsPresenceBackend {
  updatePresence(agentName: string, data: Record<string, unknown>): Promise<void>;
  getPresence(): Promise<Map<string, unknown>>;
}

interface RawKvEntry {
  role?: string;
  capabilities?: string[];
  working_on?: string;
  timestamp?: string;
}

/**
 * `PresenceService` owns:
 *
 * 1. The only write-path: `touch()` updates both NATS KV and the SQLite
 *    `last_seen_at` in a single call, so they can't drift.
 * 2. The only read-path: `list()` / `countByState()` return agents joined
 *    with computed presence. Views never call `nats.getPresence()` or
 *    `db.prepare(SELECT ... FROM agents)` directly.
 *
 * Both sides degrade gracefully if NATS is unavailable: the SQLite path
 * continues to work and presence collapses to `stale`/`offline`/`never`
 * based on last_seen_at alone.
 */
export class PresenceService {
  constructor(
    private readonly db: Database.Database,
    private readonly nats: NatsPresenceBackend,
  ) {}

  /**
   * Record that `agentName` interacted with the mesh right now. Updates
   * both backing stores (SQLite audit trail + NATS KV live signal).
   * NATS failures are logged but never thrown — the audit trail is the
   * fallback and SQLite will still reflect the most recent activity.
   *
   * `meta` fields are optional; any that are supplied overwrite the
   * corresponding SQLite columns. Unsupplied fields are left untouched
   * (so a bare `touch(name)` acts as a pure liveness bump).
   */
  async touch(agentName: string, meta: PresenceMeta = {}): Promise<void> {
    // 1. SQLite — always updated, this is the authoritative audit trail.
    //    Build a dynamic SET clause so that unsupplied meta fields keep
    //    their current value (a bare touch is a pure liveness bump).
    const now = new Date().toISOString();
    const assignments: string[] = ["last_seen_at = ?", "updated_at = ?"];
    const values: unknown[] = [now, now];
    if (meta.role !== undefined) {
      assignments.push("role = ?");
      values.push(meta.role);
    }
    if (meta.capabilities !== undefined) {
      assignments.push("capabilities = ?");
      values.push(JSON.stringify(meta.capabilities));
    }
    if (meta.working_on !== undefined) {
      assignments.push("working_on = ?");
      values.push(meta.working_on);
    }
    values.push(agentName);
    this.db
      .prepare(
        `UPDATE agents SET ${assignments.join(", ")} WHERE name = ? COLLATE NOCASE`,
      )
      .run(...values);

    // 2. NATS KV — best effort, the bucket has its own TTL auto-expire
    try {
      await this.nats.updatePresence(agentName, {
        role: meta.role,
        capabilities: meta.capabilities,
        working_on: meta.working_on,
      });
    } catch (err) {
      log("warn", "presence touch: nats kv update failed", {
        agent: agentName,
        err: String(err),
      });
    }
  }

  /**
   * List every registered agent joined with its computed presence. Reads
   * NATS KV once (so every presence decision in a single request is
   * consistent) and derives the 4-state per agent.
   *
   * `is_active` is intentionally NOT filtered — revoked agents still
   * appear in the list with their real presence. Callers that need to
   * hide them should filter on `entry.agent.is_active` after the fact.
   */
  async list(now: number = Date.now()): Promise<AgentWithPresence[]> {
    const rows = this.db
      .prepare(
        `SELECT id, name, role, capabilities, token_hash, is_active, avatar,
                working_on, last_seen_at, created_at, updated_at
         FROM agents ORDER BY name`,
      )
      .all() as Agent[];

    let kv: Map<string, unknown>;
    try {
      kv = await this.nats.getPresence();
    } catch (err) {
      log("warn", "presence list: nats kv read failed, degrading to db-only", {
        err: String(err),
      });
      kv = new Map();
    }

    return rows.map((agent) => {
      const raw = kv.get(agent.name) as RawKvEntry | undefined;
      const inKV = kv.has(agent.name);
      const effectiveLastSeen = raw?.timestamp ?? agent.last_seen_at ?? null;
      const presence = computePresenceState(inKV, effectiveLastSeen, now);
      const liveMeta: PresenceMeta | null = inKV
        ? {
            role: raw?.role,
            capabilities: raw?.capabilities,
            working_on: raw?.working_on,
          }
        : null;
      return { agent, presence, liveMeta, effectiveLastSeen };
    });
  }

  /** Count agents by presence state. Shares the read-path with `list()`. */
  async countByState(
    now: number = Date.now(),
  ): Promise<Record<Presence, number>> {
    const entries = await this.list(now);
    const counts: Record<Presence, number> = {
      live: 0,
      stale: 0,
      offline: 0,
      never: 0,
    };
    for (const e of entries) counts[e.presence]++;
    return counts;
  }
}
