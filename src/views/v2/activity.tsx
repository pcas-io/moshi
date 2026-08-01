// V2 Activity — SENTINEL Dark event stream + filter sidebar + top actors.

import type { FC } from "hono/jsx";
import type { Activity, PaginatedResult } from "../../types.js";
import { V2Layout } from "./layout.js";
import { V2Card, V2Avatar, entityColor } from "./components.js";
import { V2_TOKENS, greenGlow } from "./tokens.js";

export interface V2ActivityProps {
  result: PaginatedResult<Activity>;
  filterEntity?: string;
  filterRange?: string;
  agentIds: Record<string, string>;
  agentRoles: Record<string, string | null>;
  userRole?: string;
  csrfToken?: string;
}

const MONO = "var(--v2-font-mono)";
const GRID = "46px 22px 84px minmax(160px,1fr) minmax(0,140px)";

const RANGE_OPTIONS: ReadonlyArray<readonly [string, string, number]> = [
  ["15m",   "Last 15m",  15 * 60 * 1000],
  ["1h",    "Last 1h",   60 * 60 * 1000],
  ["24h",   "Last 24h",  24 * 60 * 60 * 1000],
  ["all",   "All time",  Number.POSITIVE_INFINITY],
];

function fmtTime(iso: string): string {
  return new Date(iso).toTimeString().slice(0, 5);
}

function fmtHeadDate(): string {
  return new Date().toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short", year: "numeric" }).toUpperCase();
}

function buildUrl(params: Record<string, string | undefined>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) u.set(k, v);
  const qs = u.toString();
  return qs ? `/activity?${qs}` : "/activity";
}

const AdminBadge: FC<{ size?: number }> = ({ size = 18 }) => (
  <span style={`width:${size}px;height:${size}px;border-radius:4px;background:${V2_TOKENS.btn3};border:1px solid #3a3a3a;color:${V2_TOKENS.accent};display:inline-flex;align-items:center;justify-content:center;font-size:${size < 16 ? 8 : 9}px;font-weight:700;font-family:${MONO};flex-shrink:0`}>A</span>
);

export const V2ActivityPage: FC<V2ActivityProps> = ({
  result, filterEntity, filterRange, agentIds, agentRoles, userRole, csrfToken,
}) => {
  const { data: activities, total, has_more, offset, limit } = result;
  const now = Date.now();
  const rangeMs = RANGE_OPTIONS.find(([k]) => k === filterRange)?.[2] ?? Number.POSITIVE_INFINITY;
  const visible = activities.filter((a) =>
    (!filterEntity || a.entity_type === filterEntity)
    && (now - new Date(a.created_at).getTime() <= rangeMs)
  );

  // Side-panel counts/totals over the full page (not just visible).
  const entityCounts = new Map<string, number>();
  for (const a of activities) entityCounts.set(a.entity_type, (entityCounts.get(a.entity_type) ?? 0) + 1);

  const actorCounts = new Map<string, number>();
  for (const a of activities) {
    const k = a.agent_name ?? "admin";
    actorCounts.set(k, (actorCounts.get(k) ?? 0) + 1);
  }
  const topActors = [...actorCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const topMax = Math.max(1, ...topActors.map(([, n]) => n));

  return (
    <V2Layout title="Activity" active="LOG" userRole={userRole} csrfToken={csrfToken}>
      <div class="v2-pad" style="padding-top:26px;padding-bottom:26px">
        <div style="display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap">
          <div>
            <div class="v2-eyebrow" style="margin-bottom:6px">AUDIT LOG — RETENTION 90D</div>
            <h1 class="v2-h1">Activity <span style={`color:${V2_TOKENS.textFaint};font-weight:400`}>· {total} events</span></h1>
          </div>
          <div style={`font-family:${MONO};font-size:10.5px;color:${V2_TOKENS.textMute}`}>
            {fmtHeadDate()} · <span style={`color:${V2_TOKENS.accent}`}>● STREAMING</span>
          </div>
        </div>

        <div style="display:flex;flex-wrap:wrap;gap:12px;padding-top:20px;align-items:flex-start">
          {/* Stream */}
          <div style="flex:1 1 560px;min-width:0">
            <V2Card title="Stream"
              right={<span style={`font-family:${MONO};font-size:10px;color:${V2_TOKENS.accent};letter-spacing:0.1em`}>● LIVE</span>}>
              {visible.length === 0 ? (
                <div style={`padding:36px;text-align:center;font-family:${MONO};font-size:11px;color:${V2_TOKENS.textMute}`}>
                  なし · no events for this filter
                </div>
              ) : visible.map((ev) => {
                const ec = entityColor(ev.entity_type);
                const ag = ev.agent_name
                  ? { id: agentIds[ev.agent_name] ?? ev.agent_name, role: agentRoles[ev.agent_name] ?? undefined }
                  : null;
                return (
                  <div style={`display:grid;grid-template-columns:${GRID};align-items:center;gap:13px;padding:9px 18px;border-top:1px solid ${V2_TOKENS.lineRow}`}>
                    <span style={`font-family:${MONO};font-size:10.5px;color:${V2_TOKENS.textMute}`}>{fmtTime(ev.created_at)}</span>
                    {ag ? <V2Avatar agentId={ag.id} role={ag.role} size={18} /> : <AdminBadge />}
                    <span style={`font-family:${MONO};font-size:9.5px;color:${ec};border:1px solid ${ec};border-radius:2px;padding:1px 7px;text-align:center;letter-spacing:0.05em`}>{ev.entity_type}</span>
                    <span style={`font-size:12.5px;color:${V2_TOKENS.textBody};overflow:hidden;text-overflow:ellipsis;white-space:nowrap`}>{ev.summary ?? ev.action}</span>
                    <span style={`font-family:${MONO};font-size:10px;color:${V2_TOKENS.textMute};text-align:right;letter-spacing:0.04em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap`}>{ev.action}</span>
                  </div>
                );
              })}
            </V2Card>
          </div>

          {/* Sidebar */}
          <div style="flex:0 1 280px;min-width:250px;display:flex;flex-direction:column;gap:12px">
            <V2Card title="Filters">
              <div style="padding:14px 16px">
                <div style={`font-size:9.5px;letter-spacing:0.18em;text-transform:uppercase;color:${V2_TOKENS.textFaint};font-weight:600;margin-bottom:7px`}>Entity</div>
                {(["message", "session", "agent"] as const).map((k) => {
                  const n = entityCounts.get(k) ?? 0;
                  const active = filterEntity === k;
                  const col = entityColor(k);
                  return (
                    <a href={buildUrl({ entity: active ? undefined : k, range: filterRange })}
                      style={`display:flex;align-items:center;gap:9px;padding:7px 10px;border-radius:3px;background:${active ? V2_TOKENS.chip : "transparent"};border:1px solid ${active ? "#3a3a3a" : "transparent"};font-family:${MONO};font-size:11px;color:${V2_TOKENS.textBody};margin-bottom:3px;text-decoration:none`}>
                      <span style={`width:8px;height:8px;background:${col};display:inline-block`} />
                      <span style="flex:1">{k}</span>
                      <span style={`color:${V2_TOKENS.textMute};font-size:10.5px`}>{n}</span>
                    </a>
                  );
                })}
                <div style={`font-size:9.5px;letter-spacing:0.18em;text-transform:uppercase;color:${V2_TOKENS.textFaint};font-weight:600;margin:14px 0 7px`}>Time</div>
                {RANGE_OPTIONS.map(([key, label]) => {
                  const active = (filterRange ?? "all") === key;
                  return (
                    <a href={buildUrl({ entity: filterEntity, range: key })}
                      style={`display:block;padding:7px 10px;border-radius:3px;background:${active ? V2_TOKENS.chip : "transparent"};border:1px solid ${active ? "#3a3a3a" : "transparent"};font-size:11.5px;color:${active ? V2_TOKENS.text : V2_TOKENS.textDim};margin-bottom:3px;text-decoration:none;font-weight:${active ? "600" : "400"}`}>
                      {label}
                    </a>
                  );
                })}
              </div>
            </V2Card>

            <V2Card title="Top Actors">
              <div style="padding:14px 16px">
                {topActors.length === 0 ? (
                  <div style={`color:${V2_TOKENS.textMute};font-family:${MONO};font-size:11px;text-align:center;padding:8px`}>まだ · no actors yet</div>
                ) : topActors.map(([name, n]) => {
                  const ag = agentIds[name] ? { id: agentIds[name], role: agentRoles[name] ?? undefined } : null;
                  return (
                    <div style="margin-bottom:11px">
                      <div style="display:flex;align-items:center;gap:8px;font-size:12px;margin-bottom:4px">
                        {ag ? <V2Avatar agentId={ag.id} role={ag.role} size={15} /> : <AdminBadge size={15} />}
                        <span style="flex:1">{name}</span>
                        <span style={`font-family:${MONO};font-size:10.5px;color:${V2_TOKENS.textMute}`}>{n}</span>
                      </div>
                      <div style={`height:4px;background:${V2_TOKENS.chip};border-radius:2px;overflow:hidden`}>
                        <div style={`width:${Math.round((n / topMax) * 100)}%;height:100%;background:${V2_TOKENS.accent};box-shadow:0 0 6px ${greenGlow(0.5)}`} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </V2Card>
          </div>
        </div>

        {(offset > 0 || has_more) && (
          <div style={`display:flex;align-items:center;gap:14px;padding-top:16px;font-family:${MONO};font-size:11px;color:${V2_TOKENS.textMute}`}>
            {offset > 0
              ? <a href={buildUrl({ entity: filterEntity, range: filterRange, offset: String(Math.max(0, offset - limit)) })} style={`color:${V2_TOKENS.accent};letter-spacing:0.08em;text-decoration:none`}>← NEWER</a>
              : <span style="color:#3a3a3a;letter-spacing:0.08em">← NEWER</span>}
            <span>{offset + 1}–{Math.min(offset + limit, total)} of {total}</span>
            {has_more
              ? <a href={buildUrl({ entity: filterEntity, range: filterRange, offset: String(offset + limit) })} style={`color:${V2_TOKENS.accent};letter-spacing:0.08em;text-decoration:none`}>OLDER →</a>
              : <span style="color:#3a3a3a;letter-spacing:0.08em">OLDER →</span>}
          </div>
        )}
      </div>
    </V2Layout>
  );
};
