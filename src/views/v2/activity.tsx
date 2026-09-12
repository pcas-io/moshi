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
import { isOperatorActor } from "../../services/activity.js";
import { V2Avatar, avatarRadius } from "./components.js";
import { V2_FONT_FAMILY_MONO, V2_TOKENS, kindColors } from "./tokens.js";
import { BROADCAST_RECIPIENT, LOG_CARD_STYLE, LOG_EMPTY_TEXT, LogEmptyBlock } from "./messages.js";

const T = V2_TOKENS;

const GRID = "display:grid;grid-template-columns:56px 26px 1fr 150px;gap:14px";
const ELLIPSIS = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap";

/** COPY §8 — an audit row names a thing, not a table. */
const ENTITY_LABELS: Record<string, string> = {
  message: "message",
  session: "sign-in",
  agent: "agent change",
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

  switch (ev.action) {
    case "message_sent": {
      const pair = /^(\S+)\s*→\s*(\S+)/.exec(ev.summary ?? "");
      const from = pair?.[1] ?? ev.agent_name;
      const to = pair?.[2];
      if (!from || !to) return fallback;
      return to === BROADCAST_RECIPIENT ? `${from} messaged everyone` : `${from} messaged ${to}`;
    }
    case "auth_login":
      return isOperatorActor(ev.agent_name)
        ? "You signed in — session cookie issued"
        : `${ev.agent_name} checked in over MCP`;
    case "agent_created":
      return names[0] ? `You created ${names[0]}` : fallback;
    case "agent_revoked":
      return names[0] ? `You deactivated ${names[0]}` : fallback;
    case "agent_reactivated":
      return names[0] ? `You reactivated ${names[0]}` : fallback;
    case "agent_renamed":
      return names[0] && names[1] ? `You renamed ${names[0]} to ${names[1]}` : fallback;
    case "agent_token_reset":
      return names[0] ? `You reset ${names[0]}'s token` : fallback;
    case "agent_deleted":
      return names[0] ? `You deleted ${names[0]}` : fallback;
    default:
      return fallback;
  }
}

/** COPY §8 — the operator reads their own events as "You". */
export const OPERATOR_LABEL = "You";

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
              style={`${GRID};padding:12px 20px;align-items:center;border-bottom:1px solid ${T.lineRow}`}
            >
              <span style={`font-family:${V2_FONT_FAMILY_MONO};font-size:12.5px;color:${T.faint}`}>
                {new Date(ev.created_at).toTimeString().slice(0, 5)}
              </span>
              <ActorCell
                name={ev.agent_name}
                role={ev.agent_name ? agentRoles[ev.agent_name] : undefined}
                size={26}
              />
              {/* The raw action stays reachable for debugging. */}
              <span style={`font-size:13.5px;color:${T.ink};${ELLIPSIS}`} title={ev.action}>
                {auditSentence(ev)}
              </span>
              <span
                style={`font-size:12.5px;color:${ink};background:${ground};padding:3px 10px;` +
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
