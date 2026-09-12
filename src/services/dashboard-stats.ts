// Read-side aggregations powering the dashboard (per-agent activity
// histograms, incident counter, thread and per-agent message totals). Kept
// separate from home-stats.ts because these are wider per-hour rollups that
// only the dashboard screens consume.

import type Database from "better-sqlite3";

const HOURS_PER_DAY = 24;
const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = HOURS_PER_DAY * MS_PER_HOUR;

/** 24-bucket array of message counts (sender or receiver) for the
 *  trailing 24 hours. Index 0 is "23-24h ago", index 23 is "0-1h ago". */
export type HourlyHeat = number[];

export function getAgentHeat(
  db: Database.Database,
  agentId: string,
  now: Date = new Date(),
): HourlyHeat {
  const since = new Date(now.getTime() - MS_PER_DAY).toISOString();
  const rows = db
    .prepare(
      `SELECT created_at FROM messages
       WHERE created_at > ?
         AND (from_agent = ? COLLATE NOCASE OR to_agent = ? COLLATE NOCASE)`,
    )
    .all(since, agentId, agentId) as Array<{ created_at: string }>;

  const buckets = new Array<number>(HOURS_PER_DAY).fill(0);
  for (const row of rows) {
    const ageMs = now.getTime() - new Date(row.created_at).getTime();
    if (ageMs < 0 || ageMs >= MS_PER_DAY) continue;
    const idx = HOURS_PER_DAY - 1 - Math.floor(ageMs / MS_PER_HOUR);
    if (idx >= 0 && idx < HOURS_PER_DAY) buckets[idx]! += 1;
  }
  return buckets;
}

/** SQL predicate for the incident family: the plain `incident` type that
 *  `RECOMMENDED_MESSAGE_TYPES` publishes, plus `alert` and the older
 *  `incident_acknowledged` / `incident_response` variants.
 *  `alias` is the table alias to qualify the column with, e.g. `"m"`. */
export function incidentTypeSql(alias = ""): string {
  const col = alias ? `${alias}.type` : "type";
  return `(${col} = 'incident' OR ${col} = 'alert' OR ${col} LIKE 'incident\\_%' ESCAPE '\\')`;
}

export const INCIDENT_TYPE_SQL = incidentTypeSql();

/** Incident-flavoured messages in the trailing 24h window. */
export function getIncidents24h(
  db: Database.Database,
  now: Date = new Date(),
): number {
  const since = new Date(now.getTime() - MS_PER_DAY).toISOString();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count FROM messages
       WHERE created_at > ? AND ${INCIDENT_TYPE_SQL}`,
    )
    .get(since) as { count: number };
  return row.count;
}

/** Total distinct conversation threads (a thread is messages sharing a
 *  correlation_id, or a single message if it has no correlation_id). */
export function getThreadsCount(db: Database.Database): number {
  const row = db
    .prepare(
      "SELECT COUNT(*) AS count FROM (SELECT DISTINCT COALESCE(correlation_id, id) FROM messages)",
    )
    .get() as { count: number };
  return row.count;
}

/** 24h message count per agent (sender or receiver), keyed by agent name. */
export function getAgentMsgCounts24h(
  db: Database.Database,
  now: Date = new Date(),
): Map<string, number> {
  const since = new Date(now.getTime() - MS_PER_DAY).toISOString();
  const rows = db
    .prepare(
      `SELECT agent, COUNT(*) AS count FROM (
         SELECT from_agent AS agent FROM messages WHERE created_at > ?
         UNION ALL
         SELECT to_agent   AS agent FROM messages WHERE created_at > ?
       ) GROUP BY agent COLLATE NOCASE`,
    )
    .all(since, since) as Array<{ agent: string; count: number }>;
  const out = new Map<string, number>();
  for (const r of rows) out.set(r.agent.toLowerCase(), r.count);
  return out;
}
