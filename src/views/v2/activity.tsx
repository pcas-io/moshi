// V2 Activity — Soft Pastel event stream + filter sidebar + top-actors widget.

import type { FC } from "hono/jsx";
import type { Activity, PaginatedResult } from "../../types.js";
import { V2Layout } from "./layout.js";
import { V2Card, V2Btn, V2Tag, V2Avatar } from "./components.js";
import { V2_TOKENS } from "./tokens.js";

export interface V2ActivityProps {
  result: PaginatedResult<Activity>;
  filterEntity?: string;
  filterRange?: string;
  agentIds: Record<string, string>;
  agentRoles: Record<string, string | null>;
  userRole?: string;
  csrfToken?: string;
}

const RANGE_OPTIONS: ReadonlyArray<readonly [string, string, number]> = [
  ["15m",   "Last 15m",  15 * 60 * 1000],
  ["1h",    "Last 1h",   60 * 60 * 1000],
  ["24h",   "Last 24h",  24 * 60 * 60 * 1000],
  ["all",   "All time",  Number.POSITIVE_INFINITY],
];

function fmtTime(iso: string): string {
  return new Date(iso).toTimeString().slice(0, 5);
}

function fmtRel(iso: string, now: number = Date.now()): string {
  const m = Math.round((now - new Date(iso).getTime()) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function entityColor(entity: string): string {
  switch (entity) {
    case "message": return V2_TOKENS.accent;
    case "session": return V2_TOKENS.accent2;
    case "agent":   return V2_TOKENS.warn;
    default:        return V2_TOKENS.textMute;
  }
}

function buildUrl(params: Record<string, string | undefined>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) u.set(k, v);
  const qs = u.toString();
  return qs ? `/activity?${qs}` : "/activity";
}

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
    const k = a.agent_name ?? "system";
    actorCounts.set(k, (actorCounts.get(k) ?? 0) + 1);
  }
  const topActors = [...actorCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const topMax = Math.max(1, ...topActors.map(([, n]) => n));

  return (
    <V2Layout title="Activity" active="LOG" userRole={userRole} csrfToken={csrfToken}>
      <div style="padding:24px 32px">
        <div style="display:flex;align-items:baseline;gap:14px;margin-bottom:4px">
          <h1 class="v2-h1">Activity</h1>
          <span style={`color:${V2_TOKENS.textMute};font-size:13px;font-family:${V2_TOKENS.text}`}>{total} events</span>
        </div>
        <p style={`color:${V2_TOKENS.textDim};margin:0 0 18px;font-size:13px`}>{new Date().toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short" })} · streaming</p>

        <div style="display:grid;grid-template-columns:1fr 270px;gap:12px">
          <V2Card title="Stream"
            right={<span style={`font-size:11px;color:${V2_TOKENS.accent2};font-family:${V2_TOKENS.text}`}>● live</span>}>
            {visible.length === 0 ? (
              <div style={`padding:40px;text-align:center;color:${V2_TOKENS.textMute};font-size:13px`}>
                No events match the current filter.
              </div>
            ) : visible.map((ev, i) => {
              const ag = ev.agent_name ? { id: agentIds[ev.agent_name] ?? ev.agent_name, role: agentRoles[ev.agent_name] ?? undefined } : null;
              return (
                <div style={`display:grid;grid-template-columns:60px 22px 88px 1fr;align-items:center;gap:14px;padding:10px 18px;font-size:13px;${i < visible.length - 1 ? `border-bottom:1px solid ${V2_TOKENS.line};` : ""}`}>
                  <span style={`color:${V2_TOKENS.textMute};font-size:12px;font-family:${V2_TOKENS.text}`}>{fmtTime(ev.created_at)}</span>
                  {ag ? <V2Avatar agentId={ag.id} role={ag.role} size={20} /> : <div />}
                  <V2Tag color={entityColor(ev.entity_type)}>{ev.entity_type}</V2Tag>
                  <span>{ev.summary ?? ev.action}</span>
                </div>
              );
            })}
          </V2Card>

          <div style="display:flex;flex-direction:column;gap:12px">
            <V2Card title="Filters">
              <div style="padding:14px">
                <div style={`font-size:10.5px;color:${V2_TOKENS.textMute};margin-bottom:6px;letter-spacing:0.08em;text-transform:uppercase`}>Entity</div>
                {(["message", "session", "agent"] as const).map((k) => {
                  const n = entityCounts.get(k) ?? 0;
                  const active = filterEntity === k;
                  const col = entityColor(k);
                  return (
                    <a href={buildUrl({ entity: active ? undefined : k, range: filterRange })}
                      style={`display:flex;align-items:center;gap:8px;padding:6px 4px;font-size:12.5px;text-decoration:none;color:inherit;border-radius:${V2_TOKENS.radius}px;${active ? `background:rgba(255,255,255,0.7);` : ""}`}>
                      <span style={`width:8px;height:8px;background:${col};display:inline-block`} />
                      <span style="flex:1">{k}</span>
                      <span style={`color:${V2_TOKENS.textMute};font-family:${V2_TOKENS.text};font-size:11.5px`}>{n}</span>
                    </a>
                  );
                })}
                <div style={`font-size:10.5px;color:${V2_TOKENS.textMute};margin:14px 0 6px;letter-spacing:0.08em;text-transform:uppercase`}>Time</div>
                {RANGE_OPTIONS.map(([key, label]) => {
                  const active = (filterRange ?? "all") === key;
                  return (
                    <a href={buildUrl({ entity: filterEntity, range: key })}
                      style={`display:block;padding:6px 10px;border-radius:${V2_TOKENS.radius}px;margin-bottom:2px;font-size:12.5px;text-decoration:none;color:${active ? V2_TOKENS.text : V2_TOKENS.textDim};${active ? "background:rgba(255,255,255,0.7);font-weight:600" : ""}`}>
                      {label}
                    </a>
                  );
                })}
              </div>
            </V2Card>

            <V2Card title="Top actors">
              <div style="padding:14px">
                {topActors.length === 0 ? (
                  <div style={`color:${V2_TOKENS.textMute};font-size:12px;text-align:center;padding:8px`}>No actors yet.</div>
                ) : topActors.map(([name, n]) => {
                  const ag = agentIds[name] ? { id: agentIds[name], role: agentRoles[name] ?? undefined } : null;
                  return (
                    <div style="margin-bottom:9px">
                      <div style="display:flex;align-items:center;gap:8px;font-size:12.5px;margin-bottom:3px">
                        {ag ? <V2Avatar agentId={ag.id} role={ag.role} size={14} /> : <div style={`width:14px;height:14px;background:${V2_TOKENS.surface3};border-radius:${V2_TOKENS.radius}px`} />}
                        <span style="flex:1">{name}</span>
                        <span style={`color:${V2_TOKENS.textMute};font-size:11px;font-family:${V2_TOKENS.text}`}>{n}</span>
                      </div>
                      <div style={`height:4px;background:linear-gradient(180deg, rgba(217,130,175,0.08), rgba(217,130,175,0.04));border-radius:999px;overflow:hidden;box-shadow:inset 0 1px 1px rgba(217,130,175,0.06)`}>
                        <div style={`width:${(n / topMax) * 100}%;height:100%;background:var(--v2-btn-primary-bg);box-shadow:inset 0 1px 0 rgba(255,255,255,0.45);border-radius:999px`} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </V2Card>
          </div>
        </div>

        {(offset > 0 || has_more) && (
          <div style={`display:flex;align-items:center;gap:14px;padding:18px 4px;font-size:12.5px;color:${V2_TOKENS.textMute}`}>
            {offset > 0
              ? <V2Btn href={buildUrl({ entity: filterEntity, range: filterRange, offset: String(Math.max(0, offset - limit)) })}>← Newer</V2Btn>
              : <span style={`color:${V2_TOKENS.line2}`}>← Newer</span>}
            <span style={`font-family:${V2_TOKENS.text}`}>{offset + 1}–{Math.min(offset + limit, total)} of {total}</span>
            {has_more
              ? <V2Btn href={buildUrl({ entity: filterEntity, range: filterRange, offset: String(offset + limit) })}>Older →</V2Btn>
              : <span style={`color:${V2_TOKENS.line2}`}>Older →</span>}
          </div>
        )}
      </div>
    </V2Layout>
  );
};
