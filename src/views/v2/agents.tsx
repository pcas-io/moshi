// V2 Agents — "Daylight" roster (GET /agents, admin only).
//
// Left: a six-column table that scrolls horizontally inside its card instead
// of squeezing. Right: the detail aside for the selected agent, which lives in
// ./agents-detail.tsx together with the delete-confirm modal.
//
// The screen carries no client state except that modal: the filter and the
// selection both live in the query string (?presence=, ?inspect=), so reload
// and the back button both work.
//
// Creating an agent and handing out its token moved to /agents/connect — a
// token that only existed until the next reload had no business here.
//
// The page frame (1400px, clamped gutters, 32/56 padding) comes from
// V2Layout's container; nothing below re-declares it. COPY_SCRIPT likewise
// stays out: layout.tsx injects the one copy handler for every page, and this
// screen has nothing to copy.

import { InlineScript } from "../nonce.js";
import type { FC } from "hono/jsx";
import { raw } from "hono/html";
import type { Presence } from "../../services/presence.js";
import { V2Layout } from "./layout.js";
import { V2TokenBand } from "./token-band.js";
import { PRESENCE_WORD, V2Avatar, V2Dot } from "./components.js";
import { V2_TOKENS } from "./tokens.js";
import type { V2AgentsAgent } from "./agents-detail.js";
import {
  AGENTS_CSS, AGENTS_JS, CARD_PANEL, DeleteModal, DetailAside, ON_SOLID, fmtRel,
} from "./agents-detail.js";

const T = V2_TOKENS;

// The loader in services/v2-agents-data.ts imports the row shape from here.
export type { V2AgentsAgent } from "./agents-detail.js";

export interface V2AgentsProps {
  agents: V2AgentsAgent[];
  csrfToken: string;
  /** Server flash: expired form, name validation, reset/revoke/delete failure. */
  error?: string;
  /** `?inspect=` — the agent the aside describes. */
  inspectId?: string;
  /** `?presence=` — "live" | "stale" | "off"; "off" covers offline and never. */
  presenceFilter?: string;
  /**
   * Plaintext token from a `reset-token` (or a direct `POST /agents/create`),
   * handed over exactly once. Creating an agent moved to the connect flow, but
   * resetting did not — and a reset with nowhere to show the new value would
   * lock the agent out silently.
   */
  newToken?: string;
  userRole?: string;
  userName?: string;
}

// ── Shape and colour ────────────────────────────────────────────

/** Header row and agent row share one track list; drift would misalign them. */
const ROW_GRID =
  "display:grid;grid-template-columns:38px 1.1fr 1fr 1.3fr 96px 92px;gap:14px";

/** The selected-row wash sits between `card` and `greenSoft`; no token for it. */
const SELECTED_ROW_BG = "#f6fbf7";

// Every string below 13px here uses `faint`: `dim` clears 4.5:1 only at 13px
// and up, and `faint` is the darker of the two.

/** The selection marker is an inset shadow: a border would shift the 38px column. */
const SELECTED_MARK = `inset 3px 0 0 ${T.green}`;

/**
 * `PRESENCE_WORD.never` reads "never seen", which is two words and a different
 * claim. This column carries one word, and `never` groups with `offline` under
 * the Asleep filter, so it reads "asleep" here — the aside sentence is where
 * the distinction is actually made.
 */
const TABLE_WORD: Record<Presence, string> = { ...PRESENCE_WORD, never: "asleep" };

// ── Filter pills ────────────────────────────────────────────────

type PresenceFilter = "live" | "stale" | "off";

function isPresenceFilter(value: string | undefined): value is PresenceFilter {
  return value === "live" || value === "stale" || value === "off";
}

const FilterPills: FC<{
  filter?: PresenceFilter;
  counts: { total: number; live: number; stale: number; off: number };
}> = ({ filter, counts }) => {
  // Counts come from the full roster, never the filtered list, so the row reads
  // the same whichever pill is active.
  const pills: ReadonlyArray<readonly [string, number, PresenceFilter | undefined]> = [
    ["All", counts.total, undefined],
    ["Online", counts.live, "live"],
    ["Quiet", counts.stale, "stale"],
    ["Asleep", counts.off, "off"],
  ];
  return (
    <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:18px">
      {pills.map(([label, count, value]) => {
        const active = filter === value;
        return (
          // Only the active pill states a background. An inactive one leaves
          // the property to `.d-pill`, which owns its resting `card` fill and
          // its `sunk` hover — an inline value would outrank the hover rule.
          <a
            key={label}
            aria-current={active ? "true" : undefined}
            class={active ? undefined : "d-pill"}
            href={value ? `/agents?presence=${value}` : "/agents"}
            style={
              `font-size:13.5px;font-weight:${active ? 600 : 400};padding:8px 14px;` +
              `border-radius:${T.radiusPill}px;cursor:pointer;` +
              `border:1px solid ${active ? T.lineStrong : T.line};` +
              (active ? `background:${T.subtle};` : "") +
              `color:${active ? T.ink : T.dim};text-decoration:none;white-space:nowrap`
            }
          >
            {`${label} ${count}`}
          </a>
        );
      })}
    </div>
  );
};

// ── Table ───────────────────────────────────────────────────────

const TableEmptyState: FC = () => (
  <div style="padding:44px 20px;text-align:center;display:flex;flex-direction:column;align-items:center;gap:14px">
    <div style={`font-size:14.5px;color:${T.dim}`}>
      No agents yet · まだ — connect your first one.
    </div>
    <a
      class="d-solid"
      href="/agents/connect"
      style={
        `background:${T.green};border:none;color:${ON_SOLID};font-size:14px;font-weight:600;` +
        "padding:9px 16px;border-radius:9px;cursor:pointer;text-decoration:none"
      }
    >
      Connect an agent
    </a>
  </div>
);

const AgentRow: FC<{ agent: V2AgentsAgent; selected: boolean; href: string }> = ({
  agent, selected, href,
}) => (
  // A selected row keeps its wash on hover, so it does not take `d-row`. An
  // unselected one states no background at all: an inline `background` — even
  // `transparent` — outranks `.d-row:hover` and would kill the hover fill.
  <a
    aria-current={selected ? "true" : undefined}
    class={selected ? undefined : "d-row"}
    href={href}
    style={
      `${ROW_GRID};padding:12px 20px;align-items:center;` +
      `border-bottom:1px solid ${T.lineRow};cursor:pointer;` +
      (selected ? `background:${SELECTED_ROW_BG};box-shadow:${SELECTED_MARK};` : "") +
      "text-decoration:none;color:inherit"
    }
  >
    <V2Avatar name={agent.name} role={agent.role} size={34} bordered />
    <div style="min-width:0">
      <div style="display:flex;align-items:center;gap:7px">
        {/* A deactivated agent dims its name — the only deactivation signal on
            this side, now that the active/disabled token column is gone. */}
        <span
          style={
            `font-size:14.5px;font-weight:600;color:${agent.is_active ? T.ink : T.dim};` +
            "overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
          }
        >
          {agent.name}
        </span>
        <V2Dot presence={agent.presence} size={8} />
      </div>
      <div style={`font-size:12.5px;color:${T.faint}`}>{TABLE_WORD[agent.presence]}</div>
    </div>
    <span
      style={`font-size:13.5px;color:${T.body};overflow:hidden;text-overflow:ellipsis;white-space:nowrap`}
    >
      {agent.role ?? "—"}
    </span>
    <span
      style={
        `font-size:13.5px;color:${agent.working_on ? T.body : T.faint};` +
        "overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
      }
    >
      {agent.working_on || "Nothing announced"}
    </span>
    {/* The selected row washes to #f6fbf7, where `dim` drops to 4.29:1. */}
    <span style={`font-size:13px;color:${T.faint};white-space:nowrap`}>
      {fmtRel(agent.last_seen_at)}
    </span>
    <span
      style={`font-size:14px;font-weight:600;text-align:right;color:${agent.msg24 > 0 ? T.ink : T.faint}`}
    >
      {agent.msg24}
    </span>
  </a>
);

const AgentsTable: FC<{
  visible: V2AgentsAgent[];
  selectedId: string | null;
  filter?: PresenceFilter;
}> = ({ visible, selectedId, filter }) => (
  // min-width:0 is load-bearing: without it the flex item refuses to shrink and
  // the scroller below never engages.
  <div style={`flex:1 1 600px;min-width:0;${CARD_PANEL}`}>
    {/* No rows, no column headers and no scroller: six labels over nothing,
        with a horizontal scrollbar under them, is furniture, not information. */}
    <div style={visible.length === 0 ? "" : "overflow-x:auto"}>
      <div style={visible.length === 0 ? "" : "min-width:720px"}>
        {visible.length > 0 && (
        <div
          style={
            `${ROW_GRID};padding:13px 20px;font-size:12.5px;color:${T.faint};` +
            `border-bottom:1px solid ${T.lineSoft};background:${T.sunk}`
          }
        >
          <span />
          <span>Agent</span>
          <span>Role</span>
          <span>Working on</span>
          <span>Last seen</span>
          <span style="text-align:right">Today</span>
        </div>
        )}
        {visible.map((a) => (
          <AgentRow
            key={a.id}
            agent={a}
            selected={a.id === selectedId}
            href={`/agents?inspect=${encodeURIComponent(a.id)}${filter ? `&presence=${filter}` : ""}`}
          />
        ))}
      </div>
    </div>
    {/* Outside the scroller on purpose. Inside the 720px track the first-run
        message and its button would start at x≈360 on a phone — off-screen
        until you drag the table sideways, on the one screen a new user sees
        first. Rows need the track; a centred sentence does not. */}
    {visible.length === 0 && <TableEmptyState />}
  </div>
);

// ── Error flash ─────────────────────────────────────────────────

const ErrorBand: FC<{ error: string }> = ({ error }) => (
  <div
    style={
      `background:${T.redSoft};border:1px solid ${T.redLine};border-radius:${T.radiusBox}px;` +
      "padding:18px 20px;display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap;margin-bottom:18px"
    }
  >
    <span
      aria-hidden="true"
      style={
        `width:26px;height:26px;border-radius:9px;background:${T.red};color:${ON_SOLID};` +
        "display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0"
      }
    >
      !
    </span>
    <div style="flex:1 1 320px;min-width:0">
      <div style="font-size:15px;font-weight:600;margin-bottom:3px">That didn't work</div>
      <div style={`font-size:14px;color:${T.body}`}>{error}</div>
    </div>
  </div>
);

// ── Page ────────────────────────────────────────────────────────

export const V2AgentsPage: FC<V2AgentsProps> = ({
  agents, csrfToken, error, inspectId, presenceFilter, newToken, userRole, userName,
}) => {
  const total = agents.length;
  const live = agents.filter((a) => a.presence === "live").length;
  const stale = agents.filter((a) => a.presence === "stale").length;
  const off = total - live - stale;

  const filter = isPresenceFilter(presenceFilter) ? presenceFilter : undefined;
  const visible = filter
    ? agents.filter((a) =>
        filter === "off"
          ? a.presence === "offline" || a.presence === "never"
          : a.presence === filter)
    : agents;

  // A filter that matches nothing still keeps an aside — on the inspected
  // agent, or failing that the first one on the roster. `null` therefore only
  // happens with an empty roster, the one case that renders no aside at all.
  const inspected: V2AgentsAgent | null =
    agents.find((a) => a.id === inspectId)
    ?? visible.find((a) => a.presence === "live")
    ?? visible[0]
    ?? agents[0]
    ?? null;

  return (
    <V2Layout title="Agents" active="AGENTS" userRole={userRole} userName={userName} csrfToken={csrfToken}>
      {raw(`<style>${AGENTS_CSS}</style>`)}
      <div style="margin-bottom:18px">
        <h1 style="margin:0 0 6px;font-size:clamp(24px,3vw,30px);font-weight:600;letter-spacing:-0.025em">
          Agents
        </h1>
        <p style={`margin:0;font-size:15px;color:${T.body};max-width:64ch`}>
          {`${total} registered, ${live} awake. Tokens are hashed — reset one and the old value dies instantly.`}
        </p>
      </div>

      {newToken && <V2TokenBand token={newToken} />}
      {error && <ErrorBand error={error} />}

      <FilterPills filter={filter} counts={{ total, live, stale, off }} />

      {/* The one m-rise on this screen: the split row, never the table rows. */}
      <div class="m-rise" style="display:flex;gap:18px;flex-wrap:wrap;align-items:flex-start">
        <AgentsTable visible={visible} selectedId={inspected?.id ?? null} filter={filter} />
        {inspected && <DetailAside agent={inspected} csrfToken={csrfToken} />}
      </div>

      {inspected && <DeleteModal agent={inspected} csrfToken={csrfToken} />}
      {inspected && <InlineScript code={AGENTS_JS} />}
    </V2Layout>
  );
};
