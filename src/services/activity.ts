import { ulid } from "ulidx";
import type Database from "better-sqlite3";
import type { Activity, PaginatedResult } from "../types";

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
  agent_name?: string;
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
    conditions.push("agent_name = ? COLLATE NOCASE");
    bindings.push(agentName);
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

  log(params: {
    action: string;
    entity_type: string;
    entity_id: string;
    summary?: string;
    agent_name?: string;
  }): Activity {
    const id = ulid();
    const created_at = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO activity_log (id, action, entity_type, entity_id, summary, agent_name, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        params.action,
        params.entity_type,
        params.entity_id,
        params.summary ?? null,
        params.agent_name ?? null,
        created_at,
      );

    return {
      id,
      action: params.action,
      entity_type: params.entity_type,
      entity_id: params.entity_id,
      summary: params.summary ?? null,
      agent_name: params.agent_name ?? null,
      created_at,
    };
  }

  list(params: ActivityFilter & { limit: number; offset: number }): PaginatedResult<Activity> {
    const { limit, offset } = params;
    const { where, bindings } = buildFilter(params);

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
    const { where, bindings } = buildFilter(params);

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

  logAsync(params: {
    action: string;
    entity_type: string;
    entity_id: string;
    summary?: string;
    agent_name?: string;
  }): void {
    try {
      this.log(params);
    } catch {
      // fire-and-forget: silently catch errors
    }
  }
}
