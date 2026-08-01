// V2 Messages — SENTINEL Dark message log with routing chips + wide table.

import type { FC } from "hono/jsx";
import type { MessageView } from "../../services/message-queries.js";
import type { PaginatedResult } from "../../types.js";
import { V2Layout } from "./layout.js";
import { V2Btn, V2Avatar, typeColor } from "./components.js";
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

const MONO = "var(--v2-font-mono)";
const GRID = "52px 1fr 92px 1.1fr 120px 52px 2fr";

function fmtDayHM(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return d.toTimeString().slice(0, 5);
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" }) + " " + d.toTimeString().slice(0, 5);
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

const RoutingChip: FC<{
  value: string;
  label: string;
  dot?: string;
  active: boolean;
  agentFilter?: string;
  query?: string;
}> = ({ value, label, dot, active, agentFilter, query }) => {
  const href = buildUrl("/messages", { routing: value || undefined, agent: agentFilter, q: query });
  return (
    <a class={`v2-chip${value ? " v2-chip--mono" : ""}${active ? " active" : ""}`} href={href}>
      {dot && <span style={`width:6px;height:6px;border-radius:50%;background:${dot};display:inline-block`} />}
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
      <div class="v2-pad" style="padding-top:26px;padding-bottom:26px">
        <div style="display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap">
          <div>
            <div class="v2-eyebrow" style="margin-bottom:6px">READ-ONLY LOG — FROM SET SERVER-SIDE</div>
            <h1 class="v2-h1">Messages <span style={`color:${V2_TOKENS.textFaint};font-weight:400`}>· {total}</span></h1>
          </div>
          <V2Btn href="/conversations">Threads →</V2Btn>
        </div>
        <div style={`font-family:${MONO};font-size:10.5px;color:${V2_TOKENS.textMute};padding-top:8px`}>
          payload ≤ 256 KB · context ≤ 2048 chars · 60 msg/min global cap · retention 30d
        </div>

        <form method="get" action="/messages" style="display:flex;gap:8px;align-items:center;padding-top:16px;flex-wrap:wrap">
          <input class="v2-input" type="text" name="q" placeholder="Search context, correlation_id…" value={query ?? ""} style="width:280px;max-width:100%;font-size:11.5px;padding:9px 12px" />
          <input class="v2-input" type="text" name="agent" placeholder="from/to filter" value={filterAgent ?? ""} style="width:160px;font-size:11.5px;padding:9px 12px" />
          {filterRouting && <input type="hidden" name="routing" value={filterRouting} />}
          <V2Btn type="submit">Apply</V2Btn>
          {(filterAgent || query) && <V2Btn href={buildUrl("/messages", { routing: filterRouting })} kind="ghost">clear</V2Btn>}
          <span style="flex:1" />
          <RoutingChip value="" label="Routing · All" active={!filterRouting} agentFilter={filterAgent} query={query} />
          <RoutingChip value="direct" label="direct" dot={V2_TOKENS.textDim} active={filterRouting === "direct"} agentFilter={filterAgent} query={query} />
          <RoutingChip value="broadcast" label="broadcast" dot={V2_TOKENS.warn} active={filterRouting === "broadcast"} agentFilter={filterAgent} query={query} />
          <span
            title="Routing mode capability:* is spec'd but not yet implemented."
            class="v2-chip v2-chip--mono"
            style="opacity:0.6;cursor:help;border-color:#2a2a2a;color:#555555"
          >
            <span style={`width:6px;height:6px;border-radius:50%;background:${V2_TOKENS.info};display:inline-block`} />
            capability:* <span style="font-size:9px;color:#555555">· spec'd</span>
          </span>
        </form>

        <div class="v2-card" style="margin-top:14px">
          <div style="overflow-x:auto">
            <div style="min-width:960px">
              <div style={`display:grid;grid-template-columns:${GRID};gap:12px;padding:10px 18px;font-size:9.5px;letter-spacing:0.14em;text-transform:uppercase;color:${V2_TOKENS.textFaint};font-weight:600;border-bottom:1px solid ${V2_TOKENS.line}`}>
                <span>Time</span><span>From</span><span>Routing</span><span>To</span><span>Type</span><span>Prio</span><span>Context · required</span>
              </div>
              {filtered.length === 0 ? (
                <div style={`padding:36px;text-align:center;font-family:${MONO};font-size:11px;color:${V2_TOKENS.textMute}`}>
                  なし · no messages for this filter
                </div>
              ) : filtered.map((m) => {
                const r = routingOf(m.to);
                const rc = routingColor(r);
                const tc = typeColor(m.type);
                return (
                  <div style={`display:grid;grid-template-columns:${GRID};gap:12px;padding:9px 18px;align-items:center;border-top:1px solid ${V2_TOKENS.lineRow}`}>
                    <span style={`font-family:${MONO};font-size:10.5px;color:${V2_TOKENS.textMute}`}>{fmtDayHM(m.created_at)}</span>
                    <div style="display:flex;align-items:center;gap:8px;overflow:hidden">
                      <V2Avatar agentId={agentIds[m.from] ?? m.from} role={agentRoles[m.from] ?? undefined} size={18} />
                      <span style="font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{m.from}</span>
                    </div>
                    <span style={`font-family:${MONO};font-size:9.5px;color:${rc};border:1px solid ${rc};border-radius:2px;padding:1px 7px;text-align:center;letter-spacing:0.05em`}>{r}</span>
                    {r === "broadcast" ? (
                      <span style={`font-family:${MONO};font-size:10px;color:${V2_TOKENS.warn};letter-spacing:0.08em`}>※ ALL LIVE AGENTS</span>
                    ) : r === "capability" ? (
                      <span style={`font-family:${MONO};font-size:10.5px;color:${V2_TOKENS.info};overflow:hidden;text-overflow:ellipsis;white-space:nowrap`}>{m.to}</span>
                    ) : (
                      <div style="display:flex;align-items:center;gap:8px;overflow:hidden">
                        <V2Avatar agentId={agentIds[m.to] ?? m.to} role={agentRoles[m.to] ?? undefined} size={18} />
                        <span style="font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{m.to}</span>
                      </div>
                    )}
                    <span style={`font-family:${MONO};font-size:9.5px;color:${tc};border:1px solid ${tc};border-radius:2px;padding:1px 7px;text-align:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;letter-spacing:0.03em`}>{m.type}</span>
                    <span style={`font-family:${MONO};font-size:9.5px;color:${m.priority === "high" ? V2_TOKENS.danger : V2_TOKENS.textMute};letter-spacing:0.08em;text-transform:uppercase`}>{m.priority}</span>
                    <span style="font-size:12px;color:#a8a8a8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{m.context}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {(offset > 0 || has_more) && (
          <div style={`display:flex;align-items:center;gap:14px;padding-top:16px;font-family:${MONO};font-size:11px;color:${V2_TOKENS.textMute}`}>
            {offset > 0
              ? <a href={buildUrl("/messages", { agent: filterAgent, routing: filterRouting, q: query, offset: String(prevOff) })} style={`color:${V2_TOKENS.accent};letter-spacing:0.08em;text-decoration:none`}>← NEWER</a>
              : <span style="color:#3a3a3a;letter-spacing:0.08em">← NEWER</span>}
            <span>{offset + 1}–{Math.min(offset + limit, total)} of {total}</span>
            {has_more
              ? <a href={buildUrl("/messages", { agent: filterAgent, routing: filterRouting, q: query, offset: String(nextOff) })} style={`color:${V2_TOKENS.accent};letter-spacing:0.08em;text-decoration:none`}>OLDER →</a>
              : <span style="color:#3a3a3a;letter-spacing:0.08em">OLDER →</span>}
          </div>
        )}
      </div>
    </V2Layout>
  );
};
