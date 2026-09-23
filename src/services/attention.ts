// The needs-attention list behind Home's amber band.
//
// The band is derived, not decorative: it renders only when this returns a
// non-empty list. Three sources, in the priority order the design handoff
// states (README.md §State):
//
//   1. active agents that have not checked in for ~24h,
//   2. incident messages from the last 24h that nobody has answered,
//   3. whatever the backend health check already knows.
//
// Sentences are composed here rather than in the view so the view stays a
// view. `agent` is rendered in 600 weight, `text` follows it.

import type Database from "better-sqlite3";
import { incidentTypeSql } from "./dashboard-stats.js";
import { threadHref } from "./thread-link.js";
import type { HealthResult } from "./health.js";

const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

/** An agent is overdue once it has been silent for this long. */
export const ATTENTION_SILENCE_MS = MS_PER_DAY;

export type AttentionKind = "stale_agent" | "open_incident" | "backend";

export interface AttentionItem {
  kind: AttentionKind;
  /** Agent the item is about, rendered in 600 weight. Absent for backend items. */
  agent?: string;
  /** The rest of the sentence, following the agent name. */
  text: string;
  /** Where "review" takes the operator. */
  href: string;
}

export interface AttentionInput {
  db: Database.Database;
  health?: HealthResult | null;
  now?: Date;
  /** Hard cap on items collected per source, so one noisy source cannot flood. */
  maxPerSource?: number;
}

interface StaleRow {
  name: string;
  last_seen_at: string | null;
  created_at: string;
}

interface IncidentRow {
  id: string;
  from_agent: string;
  context: string;
  payload: string;
  correlation_id: string | null;
}

/** "3 days" / "31 hours" — whole units, never a decimal. */
function silenceFor(ms: number): string {
  const days = Math.floor(ms / MS_PER_DAY);
  if (days >= 2) return `${days} days`;
  const hours = Math.max(1, Math.floor(ms / MS_PER_HOUR));
  return hours === 1 ? "an hour" : `${hours} hours`;
}

/** First sentence or clause, trimmed to fit one line of the band. */
function shorten(text: string, max = 72): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const stop = flat.search(/[.!?](\s|$)/);
  const head = stop > 0 && stop < max ? flat.slice(0, stop) : flat;
  return head.length > max ? `${head.slice(0, max - 1).trimEnd()}…` : head;
}

function staleAgents(db: Database.Database, now: Date, limit: number): AttentionItem[] {
  const cutoff = new Date(now.getTime() - ATTENTION_SILENCE_MS).toISOString();
  const rows = db
    .prepare(
      `SELECT name, last_seen_at, created_at FROM agents
       WHERE is_active = 1
         AND COALESCE(last_seen_at, created_at) < ?
       ORDER BY COALESCE(last_seen_at, created_at) ASC
       LIMIT ?`,
    )
    .all(cutoff, limit) as StaleRow[];

  return rows.map((r) => {
    const href = `/agents?inspect=&presence=off#${encodeURIComponent(r.name)}`;
    if (!r.last_seen_at) {
      return {
        kind: "stale_agent" as const,
        agent: r.name,
        text: "has a token but has never called in",
        href,
      };
    }
    const silent = now.getTime() - new Date(r.last_seen_at).getTime();
    return {
      kind: "stale_agent" as const,
      agent: r.name,
      text: `hasn't checked in for ${silenceFor(silent)}`,
      href,
    };
  });
}

/**
 * An incident counts as open while nobody else has spoken in its thread.
 * There is no ack flag on a message, and inventing one would change the
 * wire format; "somebody answered" is the closest honest signal we have.
 */
function openIncidents(db: Database.Database, now: Date, limit: number): AttentionItem[] {
  const since = new Date(now.getTime() - MS_PER_DAY).toISOString();
  const rows = db
    .prepare(
      `SELECT m.id, m.from_agent, m.context, m.payload, m.correlation_id
       FROM messages m
       WHERE m.created_at > ?
         AND ${incidentTypeSql("m")}
         AND NOT EXISTS (
           SELECT 1 FROM messages r
           WHERE COALESCE(r.correlation_id, r.id) = COALESCE(m.correlation_id, m.id)
             AND r.created_at > m.created_at
             AND r.from_agent <> m.from_agent COLLATE NOCASE
         )
       ORDER BY m.created_at DESC
       LIMIT ?`,
    )
    .all(since, limit) as IncidentRow[];

  return rows.map((r) => ({
    kind: "open_incident" as const,
    agent: r.from_agent,
    text: `reports ${shorten(r.context || r.payload)}, still unanswered`,
    href: threadHref(r.correlation_id ?? r.id),
  }));
}

function backendTrouble(health: HealthResult): AttentionItem[] {
  const items: AttentionItem[] = [];
  if (health.nats !== "connected") {
    items.push({
      kind: "backend",
      text: "NATS is not connected — messages cannot be delivered right now",
      href: "/health",
    });
  }
  if (health.db !== "ok") {
    items.push({
      kind: "backend",
      text: "The database is not responding — history and presence are stale",
      href: "/health",
    });
  }
  return items;
}

export function buildAttentionItems(
  { db, health, now = new Date(), maxPerSource = 5 }: AttentionInput,
): AttentionItem[] {
  return [
    ...staleAgents(db, now, maxPerSource),
    ...openIncidents(db, now, maxPerSource),
    ...(health ? backendTrouble(health) : []),
  ];
}
