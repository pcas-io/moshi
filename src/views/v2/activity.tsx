// Log · Audit trail tab — the event stream and the "Busiest today" aside
// for `/log?tab=audit`.
//
// This file used to be a page (`V2ActivityPage`) that also did the
// filtering: it counted entities and applied the time range over the 50
// rows it had already fetched. Both are SQL now (`ActivityService.list`,
// `ActivityService.topActors`), so this file only renders.

import type { Child, FC } from "hono/jsx";
import type { Activity, PaginatedResult } from "../../types.js";
import type { ActivityActorCount } from "../../services/activity.js";
import { ADMIN_API_ACTOR, isOperatorActor, registerActorTokenId } from "../../services/activity.js";
import { V2Avatar, avatarRadius } from "./components.js";
import { V2_FONT_FAMILY_MONO, V2_TOKENS, kindColors } from "./tokens.js";
import { BROADCAST_RECIPIENT, LOG_CARD_STYLE, LOG_EMPTY_TEXT, LogEmptyBlock } from "./messages.js";

const T = V2_TOKENS;

// A row that wraps, not a grid: 56px 26px 1fr 150px plus gaps and padding
// was 314 px before the sentence got a pixel, and at 360 px it read "tria…".
// Time and emblem keep their width, the sentence takes what is left and,
// when that is too little, a whole line of its own; the kind pill stays at
// the right edge on either line.
const ROW = "display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px";
const TIME = "flex:0 0 56px";
const SENTENCE = "flex:1 1 220px;min-width:0;overflow-wrap:anywhere";
const PILL = "margin-left:auto";

/** COPY §8 — an audit row names a thing, not a table. */
const ENTITY_LABELS: Record<string, string> = {
  message: "message",
  session: "sign-in",
  agent: "agent change",
  registration_token: "registration token",
};

export function entityLabel(entityType: string): string {
  return ENTITY_LABELS[entityType] ?? entityType;
}

/**
 * Names the write side quotes into its summaries: `Agent "scout" created`,
 * `Agent "old" renamed to "new"`. Parsing them back is the only way to put
 * the name in a sentence without rewriting every producer of an audit row.
 */
function quotedNames(summary: string | null): string[] {
  if (!summary) return [];
  return Array.from(summary.matchAll(/"([^"]+)"/g), (m) => m[1]);
}

/** COPY §8 — the operator reads their own events as "You". */
export const OPERATOR_LABEL = "You";

/**
 * Who did it, as the sentence names them. "You" belongs to the operator and
 * to nobody else: the admin API and a registration token are other actors,
 * even though an operator set them up.
 */
export function actorLabel(agentName: string | null | undefined): string {
  if (isOperatorActor(agentName)) return OPERATOR_LABEL;
  if (agentName === ADMIN_API_ACTOR) return "Admin API";
  const tokenId = registerActorTokenId(agentName);
  return tokenId !== null ? `Registration token ${tokenId}` : (agentName as string);
}

/** An actor that is no agent, so "its webhook" could not mean its own. */
function actsForAnother(agentName: string | null | undefined): boolean {
  return isOperatorActor(agentName) || agentName === ADMIN_API_ACTOR || registerActorTokenId(agentName) !== null;
}

/**
 * An audit row as a sentence about a person (COPY §8).
 *
 * The action strings are the snake_case ones the services actually write
 * (`grep -rn 'action: "' src`), not the dotted names the copy deck guesses
 * at. There is no distinct MCP action: an agent checking in over MCP and
 * the operator signing in are both `auth_login`, told apart by whether the
 * actor is the operator.
 *
 * Anything unparseable falls back to the stored summary, then to the raw
 * action — which is on the row's `title` either way.
 */
export function auditSentence(ev: Activity): string {
  const fallback = ev.summary ?? ev.action;
  const names = quotedNames(ev.summary);
  const actor = actorLabel(ev.agent_name);

  switch (ev.action) {
    case "message_sent": {
      const pair = /^(\S+)\s*→\s*(\S+)/.exec(ev.summary ?? "");
      const from = pair?.[1] ?? ev.agent_name;
      const to = pair?.[2];
      if (!from || !to) return fallback;
      return to === BROADCAST_RECIPIENT ? `${from} messaged everyone` : `${from} messaged ${to}`;
    }
    case "message_stored": {
      const pair = /^(\S+)\s*→\s*(\S+)/.exec(ev.summary ?? "");
      const from = pair?.[1] ?? ev.agent_name;
      const to = pair?.[2];
      if (!from || !to) return fallback;
      // The message was delivered before; only the history row was missing.
      return to === BROADCAST_RECIPIENT
        ? `${from}'s message to everyone reached the history late`
        : `${from}'s message to ${to} reached the history late`;
    }
    case "message_expired": {
      const pair = /^(\S+)\s*→\s*(\S+):/.exec(ev.summary ?? "");
      return pair ? `${pair[1]}'s message to ${pair[2]} expired before it was read` : fallback;
    }
    case "message_dead_letter":
      return ev.agent_name ? `${ev.agent_name} never acknowledged a message; the broker gave up on it` : fallback;
    case "read_not_recorded":
      return ev.agent_name ? `${ev.agent_name} was handed a message; the read could not be stored` : fallback;
    case "auth_login":
      return isOperatorActor(ev.agent_name)
        ? "You signed in — session cookie issued"
        : `${ev.agent_name} checked in over MCP`;
    case "agent_created":
      // The connect page is the operator's too; it says which door was used.
      return names[0] ? `${actor} created ${names[0]}${ev.origin === "connect" ? " via Connect" : ""}` : fallback;
    case "agent_revoked":
      return names[0] ? `${actor} deactivated ${names[0]}` : fallback;
    case "agent_reactivated":
      return names[0] ? `${actor} reactivated ${names[0]}` : fallback;
    case "agent_renamed":
      return names[0] && names[1] ? `${actor} renamed ${names[0]} to ${names[1]}` : fallback;
    case "agent_token_reset":
      return names[0] ? `${actor} reset ${names[0]}'s token` : fallback;
    case "agent_deleted":
      return names[0] ? `${actor} deleted ${names[0]}` : fallback;
    case "agent_profile_changed": {
      const changed = /changed its (.+)$/.exec(ev.summary ?? "")?.[1];
      return names[0] && changed ? `${names[0]} changed its ${changed}` : fallback;
    }
    case "registration_token_created":
      return `${actor} created registration token ${ev.entity_id}`;
    case "registration_token_revoked":
      return `${actor} revoked registration token ${ev.entity_id}`;
    case "webhook_set":
      if (!names[0]) return fallback;
      return isOperatorActor(ev.agent_name) ? `You set ${names[0]}'s webhook` : `${names[0]} set its webhook`;
    case "webhook_deleted":
      if (!names[0]) return fallback;
      return actsForAnother(ev.agent_name) ? `${actor} removed ${names[0]}'s webhook` : `${names[0]} removed its webhook`;
    case "webhook_failed":
      return names[0] ? `A call of ${names[0]}'s webhook failed for good` : fallback;
    case "webhook_disabled":
      return names[0] ? `${names[0]}'s webhook was switched off after five failed calls in a row` : fallback;
    default:
      return fallback;
  }
}

/**
 * The actor: an emblem for an agent, a lettered box for the operator.
 * 11px text uses `faint`; `dim` is 3.95:1 on `subtle`.
 */
const ActorCell: FC<{ name: string | null; role?: string | null; size: number }> = ({
  name, role, size,
}) => {
  if (name !== null && !isOperatorActor(name)) {
    return <V2Avatar name={name} role={role} size={size} bordered />;
  }
  return (
    <span
      style={`width:${size}px;height:${size}px;border-radius:${avatarRadius(size)}px;background:${T.subtle};` +
        `border:1px solid ${T.line};color:${T.faint};display:inline-flex;align-items:center;` +
        `justify-content:center;font-size:11px;font-weight:600;flex-shrink:0`}
    >
      {OPERATOR_LABEL}
    </span>
  );
};

export interface AuditTableProps {
  result: PaginatedResult<Activity>;
  /** Role drives the emblem's stripe colour; the emblem is keyed on the name. */
  agentRoles: Record<string, string | null>;
  /** Pagination row, built by the page so both tabs share one footer. */
  footer?: Child;
}

export const AuditTable: FC<AuditTableProps> = ({ result, agentRoles, footer }) => {
  const rows = result.data;
  return (
    <div class="m-rise" style={`flex:1 1 540px;min-width:0;${LOG_CARD_STYLE}`}>
      {rows.length === 0 ? (
        <LogEmptyBlock />
      ) : (
        rows.map((ev) => {
          const [ink, ground] = kindColors(ev.entity_type);
          return (
            <div
              key={ev.id}
              class="d-row"
              style={`${ROW};padding:12px 20px;border-bottom:1px solid ${T.lineRow}`}
            >
              <span style={`${TIME};font-family:${V2_FONT_FAMILY_MONO};font-size:12.5px;color:${T.faint}`}>
                {new Date(ev.created_at).toTimeString().slice(0, 5)}
              </span>
              <ActorCell
                name={ev.agent_name}
                role={ev.agent_name ? agentRoles[ev.agent_name] : undefined}
                size={26}
              />
              {/* The raw action stays reachable for debugging. */}
              <span style={`${SENTENCE};font-size:13.5px;color:${T.ink}`} title={ev.action}>
                {auditSentence(ev)}
              </span>
              <span
                style={`${PILL};font-size:12.5px;color:${ink};background:${ground};padding:3px 10px;` +
                  `border-radius:${T.radiusPill}px;width:fit-content;white-space:nowrap;text-align:center`}
              >
                {entityLabel(ev.entity_type)}
              </span>
            </div>
          );
        })
      )}
      {footer}
    </div>
  );
};

export interface BusiestTodayProps {
  /** Real totals for the day from `ActivityService.topActors`, not a page count. */
  actors: readonly ActivityActorCount[];
  agentRoles: Record<string, string | null>;
}

export const BusiestTodayAside: FC<BusiestTodayProps> = ({ actors, agentRoles }) => {
  const max = Math.max(1, ...actors.map((a) => a.count));
  return (
    <div
      style={`flex:1 1 280px;min-width:260px;background:${T.card};border:1px solid ${T.line};` +
        `border-radius:${T.radiusCard}px;padding:20px`}
    >
      <h2 style="margin:0 0 4px;font-size:15px;font-weight:600">Busiest today</h2>
      {/* COPY §8 says "By audit events in this page". That sentence described
          the bug IMPLEMENTATION.md asked us to fix: the counts used to be
          computed over the 50 rows on screen. They are day totals from SQL
          now, so the old label would misdescribe its own number. */}
      <div style={`font-size:13px;color:${T.dim};margin-bottom:14px`}>By audit events today</div>
      {actors.length === 0 ? (
        <div style={`font-size:13.5px;color:${T.dim}`}>{LOG_EMPTY_TEXT}</div>
      ) : (
        actors.map((a) => {
          const operator = isOperatorActor(a.agent_name);
          return (
            <div key={a.agent_name} style="margin-bottom:13px">
              <div style="display:flex;align-items:center;gap:9px;font-size:13.5px;margin-bottom:5px">
                <ActorCell name={a.agent_name} role={agentRoles[a.agent_name]} size={22} />
                <span style="flex:1">{operator ? OPERATOR_LABEL : a.agent_name}</span>
                <span style={`font-size:12.5px;color:${T.faint}`}>{a.count}</span>
              </div>
              <div style={`height:6px;background:${T.subtle};border-radius:${T.radiusPill}px;overflow:hidden`}>
                <div style={`width:${Math.round((a.count / max) * 100)}%;height:100%;background:${T.green}`} />
              </div>
            </div>
          );
        })
      )}
    </div>
  );
};
