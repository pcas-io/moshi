// V2 Messages — Soft Pastel message log with filter chips and sticky table.

import type { FC } from "hono/jsx";
import type { MessageView } from "../../services/message-queries.js";
import type { PaginatedResult } from "../../types.js";
import { V2Layout } from "./layout.js";
import { V2Card, V2Btn, V2Tag, V2Avatar } from "./components.js";
import { V2_TOKENS } from "./tokens.js";

export interface V2MessagesProps {
  result: PaginatedResult<MessageView>;
  filterAgent?: string;
  filterRouting?: string; // "direct" | "broadcast" | "" (capability deferred)
  query?: string;
  agentRoles: Record<string, string | null>;
  agentIds: Record<string, string>;
  userRole?: string;
  csrfToken?: string;
}

// Routing-mode filter chips. `capability` is shown but disabled — the
// routing mode itself is spec'd as Option A (server-side fan-out, see
// plexus design-spec entities:8r7p8odnnl1ys956xp5n) but not yet implemented
// in the backend. We surface it so future arrivals know the slot exists.
const ROUTING_FILTERS: ReadonlyArray<readonly [string, string, string, boolean]> = [
  ["",          "Routing · all", "",                false],
  ["direct",    "direct",        V2_TOKENS.text,    false],
  ["broadcast", "broadcast",     V2_TOKENS.warn,    false],
  ["capability","capability:*",  V2_TOKENS.info,    true ], // disabled
];

const CAPABILITY_ROUTING_DOC =
  "https://plexus.nxio.me/entities/entities:8r7p8odnnl1ys956xp5n";

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return d.toTimeString().slice(0, 5);
}

function fmtDayHM(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return d.toTimeString().slice(0, 5);
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" }) + " " + fmtTime(iso);
}

function typeColor(type: string): string {
  switch (type) {
    case "answer": return V2_TOKENS.accent2;
    case "question": return V2_TOKENS.info;
    case "info": return V2_TOKENS.textDim;
    case "alert":
    case "incident_response": return V2_TOKENS.danger;
    case "incident_acknowledged": return V2_TOKENS.warn;
    case "review_request": return V2_TOKENS.warn;
    default: return V2_TOKENS.text;
  }
}

function buildUrl(base: string, params: Record<string, string | undefined>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) u.set(k, v);
  const qs = u.toString();
  return qs ? `${base}?${qs}` : base;
}

function routingOf(to: string): "direct" | "broadcast" | "capability" {
  if (to === "broadcast") return "broadcast";
  if (to.startsWith("capability:")) return "capability";
  return "direct";
}

function routingColor(r: "direct" | "broadcast" | "capability"): string {
  return r === "broadcast" ? V2_TOKENS.warn : r === "capability" ? V2_TOKENS.info : V2_TOKENS.textDim;
}

// Routing chip — clickable except when disabled (then it links to the
// plexus design spec for the not-yet-implemented routing mode).
const RoutingChip: FC<{ value: string; label: string; color: string; disabled: boolean; active: boolean; agentFilter?: string; query?: string }> = ({ value, label, color, disabled, active, agentFilter, query }) => {
  const baseStyle = `padding:6px 12px;border-radius:999px;font-size:12px;border:1px solid ${V2_TOKENS.line2};background:${active ? "rgba(255,255,255,0.7)" : "transparent"};color:${active ? V2_TOKENS.text : V2_TOKENS.textDim};display:flex;align-items:center;gap:6px;text-decoration:none;font-family:${value === "" ? V2_TOKENS.text : "'JetBrains Mono', monospace"};font-weight:${active ? 600 : 500}`;
  const dot = color
    ? `<span style="width:7px;height:7px;background:${color};border-radius:50%;display:inline-block;box-shadow:inset 0 1px 0 rgba(255,255,255,0.45),0 0 0 2px ${color}30"></span>`
    : "";
  if (disabled) {
    return (
      <a
        href={CAPABILITY_ROUTING_DOC}
        target="_blank"
        rel="noopener noreferrer"
        title="Routing mode `capability:*` is spec'd but not yet implemented (plexus entities:8r7p8odnnl1ys956xp5n). Click to open the design spec."
        style={`${baseStyle};opacity:0.45;cursor:help`}
      >
        {color && <span style={`width:7px;height:7px;background:${color};border-radius:50%;display:inline-block`} />}
        {label} <span style={`font-size:10px;color:${V2_TOKENS.textMute}`}>· spec'd</span>
      </a>
    );
  }
  const href = buildUrl("/messages", { routing: value || undefined, agent: agentFilter, q: query });
  return (
    <a href={href} style={baseStyle}>
      {color && <span style={`width:7px;height:7px;background:${color};border-radius:50%;display:inline-block`} />}
      {label}
    </a>
  );
};

export const V2MessagesPage: FC<V2MessagesProps> = ({
  result, filterAgent, filterRouting, query, agentIds, agentRoles, userRole, csrfToken,
}) => {
  const { data: messages, total, has_more, offset, limit } = result;
  const filtered = messages
    .filter((m) => !filterRouting || routingOf(m.to) === filterRouting)
    .filter((m) => !query || m.context.toLowerCase().includes(query.toLowerCase()));
  const prevOff = Math.max(0, offset - limit);
  const nextOff = offset + limit;

  return (
    <V2Layout title="Messages" active="MESSAGES" userRole={userRole} csrfToken={csrfToken}>
      <div style="padding:24px 32px">
        <div style="display:flex;align-items:baseline;gap:14px;margin-bottom:4px">
          <h1 class="v2-h1">Messages</h1>
          <span style={`color:${V2_TOKENS.textMute};font-family:${V2_TOKENS.text}`}>{total}</span>
          <div style="flex:1" />
          <V2Btn href="/conversations">Threads</V2Btn>
        </div>
        <p style={`color:${V2_TOKENS.textDim};margin:0 0 16px;font-size:12.5px;font-family:${V2_TOKENS.text}`}>
          read-only · payload ≤ 256 KB · context ≤ 2048 chars · <code>from</code> set server-side · 60 msg/min global cap
        </p>

        <form method="get" action="/messages" style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap;align-items:center">
          <input class="v2-input" type="text" name="q" placeholder="Search context, correlation_id…" value={query ?? ""} style="width:320px" />
          <input class="v2-input v2-input--mono" type="text" name="agent" placeholder="from/to filter" value={filterAgent ?? ""} style="width:180px" />
          {filterRouting && <input type="hidden" name="routing" value={filterRouting} />}
          <V2Btn type="submit">Apply</V2Btn>
          {(filterAgent || query) && <V2Btn href={buildUrl("/messages", { routing: filterRouting })} kind="ghost">clear</V2Btn>}
          <div style="flex:1" />
          {ROUTING_FILTERS.map(([value, label, col, disabled]) => (
            <RoutingChip
              value={value} label={label} color={col} disabled={disabled}
              active={(filterRouting ?? "") === value && !disabled}
              agentFilter={filterAgent} query={query}
            />
          ))}
        </form>

        <V2Card>
          <div style={`display:grid;grid-template-columns:80px 1.1fr 90px 1.3fr 110px 60px 1.6fr;padding:10px 16px;font-size:10.5px;color:${V2_TOKENS.textMute};letter-spacing:0.08em;text-transform:uppercase;border-bottom:1px solid ${V2_TOKENS.line};gap:12px`}>
            <span>Time</span><span>From</span><span>Routing</span><span>To</span><span>Type</span><span>Prio</span><span>Context · pflicht</span>
          </div>
          {filtered.length === 0 ? (
            <div style={`padding:40px;text-align:center;color:${V2_TOKENS.textMute};font-size:13px`}>
              なし · keine Messages für diesen Filter.
            </div>
          ) : filtered.map((m, i) => {
            const r = routingOf(m.to);
            const rc = routingColor(r);
            return (
              <div style={`display:grid;grid-template-columns:80px 1.1fr 90px 1.3fr 110px 60px 1.6fr;padding:10px 16px;align-items:center;gap:12px;font-size:13px;${i < filtered.length - 1 ? `border-bottom:1px solid ${V2_TOKENS.line};` : ""}`}>
                <span style={`color:${V2_TOKENS.textMute};font-size:11.5px;font-family:${V2_TOKENS.text}`}>{fmtDayHM(m.created_at)}</span>
                <div style="display:flex;align-items:center;gap:8px;overflow:hidden">
                  <V2Avatar agentId={agentIds[m.from] ?? m.from} role={agentRoles[m.from] ?? undefined} size={18} />
                  <span style="font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{m.from}</span>
                </div>
                <V2Tag color={rc}>{r}</V2Tag>
                {r === "broadcast" ? (
                  <span style={`color:${V2_TOKENS.warn};font-size:11.5px;font-family:${V2_TOKENS.text};letter-spacing:0.05em;text-transform:uppercase`}>※ all live</span>
                ) : r === "capability" ? (
                  <span style={`color:${V2_TOKENS.info};font-size:11.5px;font-family:${V2_TOKENS.text}`}>{m.to}</span>
                ) : (
                  <div style="display:flex;align-items:center;gap:8px;overflow:hidden">
                    <V2Avatar agentId={agentIds[m.to] ?? m.to} role={agentRoles[m.to] ?? undefined} size={18} />
                    <span style="font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{m.to}</span>
                  </div>
                )}
                <V2Tag color={typeColor(m.type)}>{m.type}</V2Tag>
                <span style={`font-size:10.5px;color:${m.priority === "high" ? V2_TOKENS.danger : V2_TOKENS.textMute};letter-spacing:0.08em;text-transform:uppercase;font-family:${V2_TOKENS.text}`}>{m.priority}</span>
                <span style={`color:${V2_TOKENS.textDim};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px`}>{m.context}</span>
              </div>
            );
          })}
        </V2Card>

        {(offset > 0 || has_more) && (
          <div style={`display:flex;align-items:center;gap:14px;padding:18px 4px;font-size:12.5px;color:${V2_TOKENS.textMute}`}>
            {offset > 0
              ? <V2Btn href={buildUrl("/messages", { agent: filterAgent, routing: filterRouting, q: query, offset: String(prevOff) })}>← Newer</V2Btn>
              : <span style={`color:${V2_TOKENS.line2}`}>← Newer</span>}
            <span style={`font-family:${V2_TOKENS.text}`}>{offset + 1}–{Math.min(offset + limit, total)} of {total}</span>
            {has_more
              ? <V2Btn href={buildUrl("/messages", { agent: filterAgent, routing: filterRouting, q: query, offset: String(nextOff) })}>Older →</V2Btn>
              : <span style={`color:${V2_TOKENS.line2}`}>Older →</span>}
          </div>
        )}
      </div>
    </V2Layout>
  );
};
