// Aggregator for the V2 Home page. Pulls everything `V2HomePage` needs
// in one place so the route handler in `src/index.tsx` stays compact.

import type Database from "better-sqlite3";
import type { PresenceService } from "./presence.js";
import type { NatsPingable } from "./health.js";
import { getHomeStats } from "./home-stats.js";
import { loadLatestThread } from "./section-loaders.js";
import { buildAttentionItems } from "./attention.js";
import { checkHealth, type HealthResult } from "./health.js";
import {
  getAgentMsgCounts24h,
  getIncidents24h,
  getThreadsCount,
  incidentTypeSql,
} from "./dashboard-stats.js";
import type {
  V2HomeAgent,
  V2HomeIncident,
  V2HomeProps,
  V2HomeThread,
} from "../views/v2/home.js";

export type V2HomeDataInput = {
  db: Database.Database;
  presence: PresenceService;
  /** Only for the health check behind the needs-attention band. */
  nats?: NatsPingable;
};

const MS_PER_DAY = 24 * 60 * 60 * 1000;

interface IncidentRow {
  created_at: string;
  closed_by: string | null;
  closed_at: string | null;
}

/**
 * The newest incident of the last 24h, plus the first agent who answered it.
 * Home's lead sentence names that agent and how long they took; without this
 * the sentence would be guesswork.
 *
 * "Answered" is the same signal `attention.ts` uses for the inverse case:
 * somebody other than the reporter spoke in the thread afterwards. There is
 * no ack flag on a message and inventing one would change the wire format.
 */
export function getLatestIncident(
  db: Database.Database,
  now: Date = new Date(),
): V2HomeIncident | null {
  const since = new Date(now.getTime() - MS_PER_DAY).toISOString();
  const row = db
    .prepare(
      `SELECT m.created_at,
              (SELECT r.from_agent FROM messages r
                WHERE COALESCE(r.correlation_id, r.id) = COALESCE(m.correlation_id, m.id)
                  AND r.created_at > m.created_at
                  AND r.from_agent <> m.from_agent COLLATE NOCASE
                ORDER BY r.created_at ASC LIMIT 1) AS closed_by,
              (SELECT MIN(r.created_at) FROM messages r
                WHERE COALESCE(r.correlation_id, r.id) = COALESCE(m.correlation_id, m.id)
                  AND r.created_at > m.created_at
                  AND r.from_agent <> m.from_agent COLLATE NOCASE) AS closed_at
       FROM messages m
       WHERE m.created_at > ? AND ${incidentTypeSql("m")}
       ORDER BY m.created_at DESC
       LIMIT 1`,
    )
    .get(since) as IncidentRow | undefined;

  if (!row) return null;
  const openedMs = new Date(row.created_at).getTime();
  const closedMs = row.closed_at ? new Date(row.closed_at).getTime() : null;
  return {
    openedAt: row.created_at,
    closedBy: row.closed_by,
    // Round up: "closed it 0 minutes later" reads as a bug, not as speed.
    minutesToClose: closedMs === null
      ? null
      : Math.max(1, Math.round((closedMs - openedMs) / 60_000)),
  };
}

export async function loadV2HomeData(
  { db, presence, nats }: V2HomeDataInput,
): Promise<Omit<V2HomeProps, "userRole" | "csrfToken">> {
  const presenceEntries = await presence.list();
  const baseStats = await getHomeStats(db, presence, presenceEntries);

  const msgCounts = getAgentMsgCounts24h(db);
  const agents: V2HomeAgent[] = presenceEntries.map((e) => ({
    id: e.agent.id,
    name: e.agent.name,
    role: e.agent.role,
    presence: e.presence,
    msg24: msgCounts.get(e.agent.name.toLowerCase()) ?? 0,
    working_on: e.agent.working_on,
    last_seen_at: e.effectiveLastSeen,
  }));

  const liveThread = loadHomeLatestThread(db);

  // Health feeds the needs-attention band, and a backend that cannot answer
  // must not take the page down with it.
  let health: HealthResult | null = null;
  if (nats) {
    try {
      health = await checkHealth(db, nats);
    } catch {
      health = null;
    }
  }

  const agentsLive = baseStats.onlineAgents;
  const agentsStale = presenceEntries.filter((e) => e.presence === "stale").length;

  return {
    stats: {
      agentsTotal: baseStats.totalAgents,
      agentsLive,
      agentsStale,
      msg24h: baseStats.recentMessages,
      threads: getThreadsCount(db),
      incidents24h: getIncidents24h(db),
    },
    agents,
    attention: buildAttentionItems({ db, health }),
    latestIncident: getLatestIncident(db),
    liveThread,
  };
}


/** The most recently active thread in the shape Home's card draws. */
export function loadHomeLatestThread(db: Database.Database): V2HomeThread | null {
  const t = loadLatestThread(db);
  if (!t) return null;
  return {
    correlation_id: t.thread_id,
    context: t.first_context,
    participants: t.participants,
    messageCount: t.message_count,
    messages: t.messages.map((m) => ({
      id: m.id,
      from: m.from,
      type: m.type,
      payload: m.payload,
      created_at: m.created_at,
    })),
  };
}

/**
 * Everything the "Latest conversation" card needs, for its fragment. The
 * page gets the same thread through loadV2HomeData and the same agents, of
 * which the card reads name, role and presence only. One presence read.
 */
export async function loadHomeLatest(
  { db, presence }: Pick<V2HomeDataInput, "db" | "presence">,
): Promise<{ thread: V2HomeThread | null; agents: Pick<V2HomeAgent, "name" | "role" | "presence">[] }> {
  const entries = await presence.list();
  return {
    thread: loadHomeLatestThread(db),
    agents: entries.map((e) => ({ name: e.agent.name, role: e.agent.role, presence: e.presence })),
  };
}
