// Aggregator for the V2 Agents admin page. Pulls everything
// `V2AgentsPage` needs in one place so the route handler stays compact.

import type Database from "better-sqlite3";
import type { PresenceService } from "./presence.js";
import { getAgentHeat, getAgentMsgCounts24h } from "./dashboard-stats.js";
import type { V2AgentsAgent } from "../views/v2/agents.js";

export async function loadV2AgentsData(
  db: Database.Database,
  presence: PresenceService,
): Promise<V2AgentsAgent[]> {
  const entries = await presence.list();
  const counts = getAgentMsgCounts24h(db);

  return entries.map((e) => {
    let caps: string[] = [];
    if (e.agent.capabilities) {
      try {
        const parsed = JSON.parse(e.agent.capabilities);
        if (Array.isArray(parsed)) caps = parsed.map(String);
      } catch {
        // Capabilities was free-form text — split on common separators.
        caps = e.agent.capabilities.split(/[,\s]+/).filter(Boolean);
      }
    }
    return {
      id: e.agent.id,
      name: e.agent.name,
      role: e.liveMeta?.role ?? e.agent.role,
      capabilities: caps,
      is_active: Boolean(e.agent.is_active),
      presence: e.presence,
      msg24: counts.get(e.agent.name.toLowerCase()) ?? 0,
      heat: getAgentHeat(db, e.agent.name),
      last_seen_at: e.effectiveLastSeen,
      created_at: e.agent.created_at,
    };
  });
}
