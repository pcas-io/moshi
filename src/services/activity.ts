import { ulid } from "ulidx";
import type Database from "better-sqlite3";
import type { Activity, PaginatedResult } from "../types";
import { log as writeLog } from "./logger";

/**
 * The identity the operator writes under. `auth.ts` resolves the admin
 * session to the literal name "admin"; a few older rows have no name at
 * all. Both mean "you" to a reader, so the views and `topActors` fold
 * them together instead of showing two actors.
 */
export const OPERATOR_ACTOR = "admin";

export function isOperatorActor(agentName: string | null | undefined): boolean {
  return agentName === undefined || agentName === null || agentName === OPERATOR_ACTOR;
}

/**
 * Where an audited action came from (migration 0016, `activity_log.origin`).
 * `dashboard`: the Agents page; `admin_api`: `/api/admin`; `register`:
 * `/api/register` with a registration token; `connect`: the connect flow;
 * `presence`: an agent's own `mesh_register`.
 */
export const AUDIT_ORIGINS = ["dashboard", "admin_api", "register", "connect", "presence"] as const;
export type AuditOrigin = (typeof AUDIT_ORIGINS)[number];

/**
 * Who did it, from where. Passed from the route that knows (the dashboard,
 * the admin API, the register route, the connect page) down to the service
 * that writes the row. `ip_hash` is `hashIP` of the client address, never the
 * address itself.
 */
export interface AuditBy {
  actor: string;
  origin: AuditOrigin;
  ip_hash?: string | null;
}

/** Older callers name the actor only; they still write a row, without origin. */
export function auditByOf(by: string | AuditBy | undefined): Partial<AuditBy> {
  if (by === undefined) return {};
  return typeof by === "string" ? { actor: by } : by;
}

/** A value before and after: what `detail_json` holds where something changed. */
export interface AuditDetail {
  old?: unknown;
  new?: unknown;
}

export interface ActivityLogParams {
  action: string;
  entity_type: string;
  entity_id: string;
  summary?: string;
  agent_name?: string;
  /** The actor's inbox key (migration 0011). `agent_name` is a label and a
   *  rename rewrites the message history but no audit row; whatever has to
   *  find this row again asks by key. */
  agent_key?: string;
  /** The inbox key of the agent the row is ABOUT (migration 0016). */
  target_key?: string | null;
  origin?: AuditOrigin | null;
  ip_hash?: string | null;
  /** Stored as JSON. Never a token or a secret. */
  detail?: AuditDetail | null;
}

/** Rolling windows the Log route accepts as `?range=`. */
export const ACTIVITY_RANGES = ["15m", "1h", "24h", "all"] as const;
export type ActivityRange = (typeof ACTIVITY_RANGES)[number];

const RANGE_MS: Record<ActivityRange, number> = {
  "15m": 15 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  all: Number.POSITIVE_INFINITY,
};

export function parseActivityRange(value: string | undefined | null): ActivityRange | undefined {
  return ACTIVITY_RANGES.find((r) => r === value);
}

/** Local midnight of `now`, as the ISO string the table stores. */
export function startOfDayIso(now: number = Date.now()): string {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

/**
 * Filters shared by `list` and `topActors`. They are applied in SQL, so
 * both the page and its `total` describe the same set — the dashboard
 * used to filter the 50 rows it had already fetched, which made every
 * count a count-within-a-page and moved the page boundary silently.
 */
export interface ActivityFilter {
  /** An agent's name: rows it did (actor) OR rows about it (`target_key`). */
  agent_name?: string;
  /** The inbox key `agent_name` resolves to. Set by the service, not by callers. */
  agent_key?: string;
  entity_type?: string;
  /** Free text over summary/action/actor, plus an exact entity id. */
  q?: string;
  /** Rolling window measured back from `now`. "all"/omitted = unbounded. */
  range?: ActivityRange;
  /** Absolute lower bound, inclusive. ANDed with `range` when both are set. */
  since?: string;
  /** Clock for `range`. Injectable so the queries are testable. */
  now?: number;
}

export interface ActivityActorCount {
  /** `OPERATOR_ACTOR` for the operator's own events. */
  agent_name: string;
  count: number;
}

interface SqlFilter {
  where: string;
  bindings: unknown[];
}

/** Escape LIKE metacharacters so what the reader typed matches literally. */
function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

function buildFilter(f: ActivityFilter): SqlFilter {
  const conditions: string[] = [];
  const bindings: unknown[] = [];

  // Blank reads as "no filter", the way `listMessageItems` treats it: a bare
  // `?agent=` in a bookmarked URL must not empty the whole log.
  const agentName = f.agent_name?.trim();
  if (agentName) {
    // Actor OR target: the operator does most of what happens TO an agent,
    // and those rows carry "admin" as actor. The target is a key, so a
    // renamed agent is found under its new name with its whole history.
    conditions.push("(agent_name = ? COLLATE NOCASE OR target_key = ?)");
    bindings.push(agentName, f.agent_key ?? agentName.toLowerCase());
  }
  const q = f.q?.trim();
  if (q) {
    // entity_id is matched exactly: pasting a message id finds its row.
    conditions.push(
      "(summary LIKE ? ESCAPE '\\' OR action LIKE ? ESCAPE '\\'" +
        " OR agent_name LIKE ? ESCAPE '\\' OR entity_id = ?)",
    );
    const like = likePattern(q);
    bindings.push(like, like, like, q);
  }
  const entityType = f.entity_type?.trim();
  if (entityType) {
    conditions.push("entity_type = ?");
    bindings.push(entityType);
  }
  if (f.since !== undefined) {
    conditions.push("created_at >= ?");
    bindings.push(f.since);
  }
  const windowMs = f.range ? RANGE_MS[f.range] : Number.POSITIVE_INFINITY;
  if (Number.isFinite(windowMs)) {
    conditions.push("created_at >= ?");
    bindings.push(new Date((f.now ?? Date.now()) - windowMs).toISOString());
  }

  return {
    where: conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "",
    bindings,
  };
}

export class ActivityService {
  constructor(private db: Database.Database) {}

  log(params: ActivityLogParams): Activity {
    const id = ulid();
    const created_at = new Date().toISOString();
    const detail_json = params.detail ? JSON.stringify(params.detail) : null;

    this.db
      .prepare(
        `INSERT INTO activity_log (id, action, entity_type, entity_id, summary, agent_name, agent_key,
                                   target_key, origin, ip_hash, detail_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        params.action,
        params.entity_type,
        params.entity_id,
        params.summary ?? null,
        params.agent_name ?? null,
        params.agent_key ?? null,
        params.target_key ?? null,
        params.origin ?? null,
        params.ip_hash ?? null,
        detail_json,
        created_at,
      );

    return {
      id,
      action: params.action,
      entity_type: params.entity_type,
      entity_id: params.entity_id,
      summary: params.summary ?? null,
      agent_name: params.agent_name ?? null,
      target_key: params.target_key ?? null,
      origin: params.origin ?? null,
      detail_json,
      created_at,
    };
  }

  /**
   * An audited lifecycle event: the row, and one structured log line with
   * event, actor, target and origin, so the trail survives in the container
   * log as well. The line carries nothing else on purpose: no summary, no
   * detail, never a token or a secret, never the address hash.
   */
  audit(params: ActivityLogParams): Activity {
    const row = this.log(params);
    writeLog("info", "audit", {
      event: params.action,
      actor: params.agent_name ?? OPERATOR_ACTOR,
      target: params.target_key ?? null,
      origin: params.origin ?? null,
      entity_id: params.entity_id,
    });
    return row;
  }

  /** The inbox key a name stands for now, or the lower-cased name: a deleted
   *  agent's key was its lower-cased name unless it had to be suffixed. */
  private withKey<F extends ActivityFilter>(f: F): F {
    const name = f.agent_name?.trim();
    if (!name || f.agent_key) return f;
    const row = this.db.prepare("SELECT inbox_key FROM agents WHERE name = ? COLLATE NOCASE").get(name) as
      | { inbox_key: string | null }
      | undefined;
    return { ...f, agent_key: row?.inbox_key ?? name.toLowerCase() };
  }

  list(params: ActivityFilter & { limit: number; offset: number }): PaginatedResult<Activity> {
    const { limit, offset } = params;
    const { where, bindings } = buildFilter(this.withKey(params));

    const data = this.db
      .prepare(`SELECT * FROM activity_log${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...bindings, limit, offset) as Activity[];

    const countRow = this.db
      .prepare(`SELECT COUNT(*) as total FROM activity_log${where}`)
      .get(...bindings) as { total: number } | undefined;

    const total = countRow?.total ?? 0;

    return {
      data,
      has_more: offset + data.length < total,
      total,
      limit,
      offset,
    };
  }

  /**
   * Busiest actors for the "Busiest today" aside. Counts every matching
   * row, not the page on screen, so the bars are real totals.
   */
  topActors(params: ActivityFilter & { limit: number }): ActivityActorCount[] {
    const { where, bindings } = buildFilter(this.withKey(params));

    return this.db
      .prepare(
        `SELECT COALESCE(agent_name, ?) AS agent_name, COUNT(*) AS count
         FROM activity_log${where}
         GROUP BY COALESCE(agent_name, ?)
         ORDER BY count DESC, agent_name ASC
         LIMIT ?`,
      )
      .all(OPERATOR_ACTOR, ...bindings, OPERATOR_ACTOR, params.limit) as ActivityActorCount[];
  }

  rotate(retentionDays: number): number {
    const cutoff = new Date(
      Date.now() - retentionDays * 24 * 60 * 60 * 1000,
    ).toISOString();
    const result = this.db
      .prepare("DELETE FROM activity_log WHERE created_at < ?")
      .run(cutoff);
    return result.changes;
  }

  rotateMessages(retentionDays: number): number {
    const cutoff = new Date(
      Date.now() - retentionDays * 24 * 60 * 60 * 1000,
    ).toISOString();
    const result = this.db
      .prepare("DELETE FROM messages WHERE created_at < ?")
      .run(cutoff);
    return result.changes;
  }

  logAsync(params: ActivityLogParams): void {
    try {
      this.log(params);
    } catch {
      // fire-and-forget: silently catch errors
    }
  }
}
