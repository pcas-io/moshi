// Aggregator for the V2 Home page. Pulls everything `V2HomePage` needs
// in one place so the route handler in `src/index.tsx` stays compact.

import type Database from "better-sqlite3";
import type { ActivityService } from "./activity.js";
import type { PresenceService } from "./presence.js";
import type { NatsService } from "./nats.js";
import { getHomeStats } from "./home-stats.js";
import { listConversations } from "./message-queries.js";
import {
  getAgentHeat,
  getAgentMsgCounts24h,
  getIncidents24h,
  getMeshEdges,
  getThreadsCount,
} from "./dashboard-stats.js";
import type {
  V2HomeAgent,
  V2HomeProps,
  V2HomeThread,
} from "../views/v2/home.js";

export type V2HomeDataInput = {
  db: Database.Database;
  presence: PresenceService;
  activity: ActivityService;
  nats?: NatsService;
};

export async function loadV2HomeData(
  { db, presence, activity, nats }: V2HomeDataInput,
): Promise<Omit<V2HomeProps, "userRole" | "csrfToken">> {
  const [baseStats, presenceEntries, edges] = await Promise.all([
    getHomeStats(db, presence),
    presence.list(),
    Promise.resolve(getMeshEdges(db)),
  ]);

  const msgCounts = getAgentMsgCounts24h(db);
  const agents: V2HomeAgent[] = presenceEntries.map((e) => {
    const name = e.agent.name;
    return {
      id: e.agent.id,
      name,
      role: e.liveMeta?.role ?? e.agent.role,
      presence: e.presence,
      msg24: msgCounts.get(name.toLowerCase()) ?? 0,
      heat: getAgentHeat(db, name),
      working_on: e.liveMeta?.working_on ?? e.agent.working_on,
      last_seen_at: e.effectiveLastSeen,
    };
  });

  const liveThread: V2HomeThread | null = (() => {
    const recent = listConversations(db, { limit: 1, offset: 0 });
    const t = recent.data[0];
    if (!t) return null;
    const participants = Array.from(new Set(t.messages.map((m) => m.from)));
    return {
      correlation_id: t.thread_id,
      participants,
      messages: t.messages.map((m) => ({
        id: m.id,
        from: m.from,
        type: m.type,
        payload: m.payload,
        created_at: m.created_at,
      })),
    };
  })();

  const activities = activity.list({ limit: 6, offset: 0 }).data;

  // Stream stats are best-effort — render a placeholder if NATS is offline.
  let stream: { bytes: number; messages: number; maxAgeSeconds: number; maxBytes: number } | null = null;
  if (nats) {
    try {
      stream = await nats.getStreamStats();
    } catch {
      stream = null;
    }
  }

  const agentsLive = baseStats.onlineAgents;
  const agentsStale = presenceEntries.filter((e) => e.presence === "stale").length;

  return {
    stats: {
      agentsTotal: baseStats.totalAgents,
      agentsLive,
      agentsStale,
      agentsActive: presenceEntries.filter((e) => e.agent.is_active).length,
      msg24h: baseStats.recentMessages,
      threads: getThreadsCount(db),
      incidents24h: getIncidents24h(db),
      stream,
    },
    agents,
    edges,
    liveThread,
    activities,
  };
}
