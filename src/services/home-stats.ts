import type Database from "better-sqlite3";
import type { PresenceService } from "./presence.js";

/**
 * Aggregate counts for the dashboard home page. Pulls the `totalAgents`
 * and `recentMessages` figures from SQLite (both are persistent
 * aggregates — they don't care about liveness) and the `onlineAgents`
 * count from `PresenceService` so every view in the app agrees on the
 * definition of "online".
 *
 * Using PresenceService here is the fix for the dashboard divergence
 * bug: previously `onlineAgents` was computed as `is_active = 1 AND
 * last_seen_at > 10min`, which mixed authentication (is_active) with
 * liveness (last_seen_at) and used a crude 10-minute heuristic against
 * SQLite only. That could over- or under-report relative to what
 * `mesh_status` was showing. Now both views read the same 4-state
 * presence derived from NATS KV + last_seen_at.
 */

export interface HomeStats {
  /** Total agents ever registered (active + revoked). */
  totalAgents: number;
  /** Agents currently `presence === "live"` — i.e. in the NATS KV
   *  presence bucket within the last liveMs window. */
  onlineAgents: number;
  /** Messages created within the last 24 hours. */
  recentMessages: number;
}

export async function getHomeStats(
  db: Database.Database,
  presence: PresenceService,
): Promise<HomeStats> {
  const totalAgentsRow = db
    .prepare("SELECT COUNT(*) as count FROM agents")
    .get() as { count: number };

  const counts = await presence.countByState();

  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const recentMessagesRow = db
    .prepare("SELECT COUNT(*) as count FROM messages WHERE created_at > ?")
    .get(dayAgo) as { count: number };

  return {
    totalAgents: totalAgentsRow.count,
    onlineAgents: counts.live,
    recentMessages: recentMessagesRow.count,
  };
}
