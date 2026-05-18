// V2 Overview ("Home") — Soft Pastel dashboard landing page.
// Server-rendered with the v2 primitives + the dashboard-stats / layout
// engine introduced in PR #1 and PR #2. Live-thread card hydrates via
// SSE (see /sse/threads/:correlation_id in src/index.tsx).

import type { FC } from "hono/jsx";
import { raw } from "hono/html";
import type { Activity } from "../../types.js";
import type { Presence } from "../../services/presence.js";
import type { MeshEdge, HourlyHeat } from "../../services/dashboard-stats.js";
import { V2Layout } from "./layout.js";
import { V2Card, V2Btn, V2Tag, V2Dot, V2Spark, V2Avatar, withAlpha } from "./components.js";
import { V2_TOKENS } from "./tokens.js";
import { layoutMesh, type LayoutNode, type LayoutEdge, type Point } from "./layout-engine.js";
import { renderAvatarSvgInner, renderAvatarSvg } from "./avatar.js";

export interface V2HomeAgent {
  id: string;
  name: string;
  role: string | null;
  presence: Presence;
  msg24: number;
  heat: HourlyHeat;
  working_on: string | null;
  last_seen_at: string | null;
}

export interface V2HomeThread {
  correlation_id: string;
  participants: string[]; // agent ids
  messages: Array<{
    id: string;
    from: string;
    type: string;
    payload: string;
    created_at: string;
  }>;
}

export interface V2HomeProps {
  stats: {
    agentsTotal: number;
    agentsLive: number;
    agentsStale: number;
    agentsActive: number;
    msg24h: number;
    threads: number;
    incidents24h: number;
    stream: { bytes: number; messages: number; maxAgeSeconds: number; maxBytes: number } | null;
  };
  agents: V2HomeAgent[];
  edges: MeshEdge[];
  liveThread: V2HomeThread | null;
  activities: Activity[];
  userRole?: string;
  csrfToken?: string;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(0)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function fmtSeconds(s: number): string {
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

// ── Helpers ────────────────────────────────────────────────────────
function fmtDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short", year: "numeric" }).toUpperCase();
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return d.toTimeString().slice(0, 5);
}

function fmtRel(iso: string | null, now: number = Date.now()): string {
  if (!iso) return "—";
  const m = Math.round((now - new Date(iso).getTime()) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// Stable hue per agent name for thread-bubble tinting.
function hueFor(name: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h % 360;
}

// ── Mesh-topology SVG ──────────────────────────────────────────────
const MESH_W = 680;
const MESH_H = 360;
const RECENT_MS = 2 * 60 * 60 * 1000; // 2h
const PULSE_MS = 5 * 60 * 1000;       // 5min

const MeshGraph: FC<{ agents: V2HomeAgent[]; edges: MeshEdge[] }> = ({ agents, edges }) => {
  if (agents.length === 0) {
    return (
      <div style={`width:${MESH_W}px;height:${MESH_H}px;display:flex;align-items:center;justify-content:center;color:${V2_TOKENS.textMute};font-family:${V2_TOKENS.text}`}>
        No agents yet.
      </div>
    );
  }

  const nodes: LayoutNode[] = agents.map((a) => ({ id: a.name }));
  const layoutEdges: LayoutEdge[] = edges.map((e) => ({ from: e.from, to: e.to, weight: e.count }));
  // Aggressive spread for 12+ agents on the 680x360 canvas: weak gravity
  // so nodes don't snap back to centre, strong repulsion + long edges to
  // push them apart, generous initial radius so they start near the rim
  // instead of converging from a small inner ring.
  const positions = layoutMesh(nodes, layoutEdges, {
    width: MESH_W,
    height: MESH_H,
    linkDistance: 150,
    charge: 3500,
    gravity: 0.012,
    padding: 36,
    initialRadiusFactor: 0.45,
    iterations: 320,
  });
  const now = Date.now();
  const maxCount = Math.max(1, ...edges.map((e) => e.count));
  const presenceById = new Map(agents.map((a) => [a.name, a.presence]));

  return (
    <svg width={MESH_W} height={MESH_H} style="display:block;overflow:visible">
      {edges.map((e, i) => {
        const a = positions.get(e.from);
        const b = positions.get(e.to);
        if (!a || !b) return null;
        const recent = now - new Date(e.last).getTime() < RECENT_MS;
        const sw = (0.5 + (e.count / maxCount) * 2).toFixed(2);
        const stroke = recent ? V2_TOKENS.accent : V2_TOKENS.line2;
        const opacity = recent ? "0.65" : "0.35";
        return (
          <line key={i}
            x1={a.x.toFixed(1)} y1={a.y.toFixed(1)}
            x2={b.x.toFixed(1)} y2={b.y.toFixed(1)}
            stroke={stroke} stroke-width={sw} stroke-opacity={opacity} />
        );
      })}
      {edges.filter((e) => now - new Date(e.last).getTime() < PULSE_MS).map((e, i) => {
        const a = positions.get(e.from);
        const b = positions.get(e.to);
        if (!a || !b) return null;
        return (
          <circle key={`p${i}`} r="2.5" fill={V2_TOKENS.accent}>
            <animateMotion dur="2.2s" repeatCount="indefinite"
              path={`M${a.x.toFixed(1)},${a.y.toFixed(1)} L${b.x.toFixed(1)},${b.y.toFixed(1)}`} />
          </circle>
        );
      })}
      {agents.map((ag) => {
        const p = positions.get(ag.name)!;
        const live = presenceById.get(ag.name) === "live";
        const N = 36;             // displayed avatar size in topology px-units
        const half = N / 2;
        const ringR = half + 4;   // pulse ring radius
        const inner = renderAvatarSvgInner(ag.id, ag.role ?? undefined);
        return (
          <g key={ag.id} transform={`translate(${p.x.toFixed(1)},${p.y.toFixed(1)})`}>
            {live && (
              <circle r={ringR} fill={V2_TOKENS.accent} opacity="0.18">
                <animate attributeName="r" values={`${ringR - 3};${ringR + 4};${ringR - 3}`} dur="2s" repeatCount="indefinite" />
                <animate attributeName="opacity" values="0.32;0.06;0.32" dur="2s" repeatCount="indefinite" />
              </circle>
            )}
            {/* Hue-tinted backdrop square to keep the silhouette readable
                even when many tiny avatars sit close together. */}
            <rect x={-half - 1} y={-half - 1} width={N + 2} height={N + 2}
              rx="4" ry="4"
              fill={`oklch(0.92 0.06 ${hueFor(ag.name)})`}
              stroke={live ? V2_TOKENS.accent : V2_TOKENS.line2}
              stroke-width={live ? "1.5" : "1"} />
            {/* Avatar pixel-art embedded as nested rects, scaled from 32→N */}
            <g transform={`translate(${-half},${-half}) scale(${N / 32})`}
               shape-rendering="crispEdges">
              {raw(inner)}
            </g>
            <text y={half + 14} text-anchor="middle" font-size="11"
              style={`font-family:${V2_TOKENS.text};fill:${V2_TOKENS.textDim};font-weight:${live ? 600 : 500}`}>
              {ag.name}
            </text>
          </g>
        );
      })}
    </svg>
  );
};

// ── KPI card ───────────────────────────────────────────────────────
// Mesh-native KPI card with glossy fill + optional accent stripe at top.
const KpiCard: FC<{
  label: string;
  value: number | string;
  sub: string;
  accent?: string;
  spark?: number[];
}> = ({ label, value, sub, accent, spark }) => {
  const stripeStyle = accent
    ? `position:absolute;top:0;left:14px;right:14px;height:2px;background:linear-gradient(90deg, ${withAlpha(accent, 0)}, ${accent} 40%, ${accent} 60%, ${withAlpha(accent, 0)});border-radius:2px;`
    : "display:none";
  return (
    <div class="v2-card" style={`padding:14px 16px;border-radius:${V2_TOKENS.radiusXL}px;overflow:hidden`}>
      <span style={stripeStyle} />
      <div style={`position:relative;font-size:10.5px;color:${V2_TOKENS.textMute};letter-spacing:0.1em;font-weight:600`}>{label}</div>
      <div style="position:relative;display:flex;align-items:flex-end;justify-content:space-between;margin-top:6px">
        <div>
          <div style="font-size:28px;font-weight:700;letter-spacing:-0.03em;line-height:1">{value}</div>
          <div style={`font-size:11.5px;color:${V2_TOKENS.textDim};margin-top:4px`}>{sub}</div>
        </div>
        {spark && <V2Spark data={spark} w={70} h={26} stroke={V2_TOKENS.accent} fillAlpha={0.15} />}
      </div>
    </div>
  );
};

// ── Thread bubble ──────────────────────────────────────────────────
function bubbleColor(from: string): string {
  return `oklch(0.94 0.06 ${hueFor(from)})`;
}

const ThreadBubble: FC<{
  msg: V2HomeThread["messages"][0];
  isLeft: boolean;
  agentRole?: string | null;
}> = ({ msg, isLeft, agentRole }) => {
  const flexDir = isLeft ? "row" : "row-reverse";
  const align = isLeft ? "flex-start" : "flex-end";
  const headDir = isLeft ? "row" : "row-reverse";
  const corner = isLeft
    ? "border-bottom-left-radius:3px;"
    : "border-bottom-right-radius:3px;";
  const bg = bubbleColor(msg.from);
  return (
    <div style={`display:flex;flex-direction:${flexDir};gap:9px;margin-bottom:10px;align-items:flex-end`}>
      <V2Avatar agentId={msg.from} role={agentRole ?? undefined} size={20} />
      <div style={`max-width:78%;display:flex;flex-direction:column;align-items:${align}`}>
        <div style={`display:flex;align-items:baseline;gap:6px;margin-bottom:3px;flex-direction:${headDir}`}>
          <span style="font-weight:600;font-size:12px">{msg.from}</span>
          <span style={`color:${V2_TOKENS.textMute};font-size:10.5px;font-family:${V2_TOKENS.text}`}>{fmtTime(msg.created_at)}</span>
        </div>
        <div
          data-msg-id={msg.id}
          style={`background:${bg};border:1px solid ${V2_TOKENS.line};border-radius:12px;${corner}padding:7px 11px;font-size:12.5px;line-height:1.5;white-space:pre-wrap`}
        >{previewPayload(msg.payload)}</div>
      </div>
    </div>
  );
};

function previewPayload(raw: string, max: number = 240): string {
  // Try JSON first — show .text or first stringy field. Fall back to raw.
  try {
    const obj = JSON.parse(raw);
    if (typeof obj === "string") return obj.slice(0, max);
    if (obj && typeof obj === "object") {
      for (const key of ["text", "message", "summary", "payload"]) {
        const v = (obj as Record<string, unknown>)[key];
        if (typeof v === "string") return v.slice(0, max);
      }
    }
  } catch { /* fall through */ }
  return raw.slice(0, max);
}

// ── SSE hydration script ───────────────────────────────────────────
// Subscribes to /sse/threads/:id and appends a bubble matching the
// server-rendered ThreadBubble exactly: avatar (cloned from a hidden
// pool), name + timestamp header, hue-tinted bubble with corner cut on
// the sender side. Sender vs. receiver decided by participants[0] which
// is embedded as `data-thread-a` on the SSE container.
const SSE_SCRIPT = (correlationId: string) => raw(`<script>
(function(){
  if (typeof EventSource === 'undefined') return;
  var box  = document.querySelector('[data-sse-thread="' + ${JSON.stringify(correlationId)} + '"]');
  if (!box) return;
  var pool = document.getElementById('v2-avatar-pool');
  var threadA = (box.dataset.threadA || '').toLowerCase();

  function getAvatar(name) {
    if (!pool) return null;
    var el = pool.querySelector('[data-name="' + CSS.escape(name.toLowerCase()) + '"]');
    return el ? el.firstElementChild : null;
  }
  function fmtTime(iso) {
    var d = new Date(iso);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }
  function hueFor(name) {
    var h = 2166136261;
    for (var i = 0; i < name.length; i++) {
      h ^= name.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return ((h >>> 0) % 360);
  }
  function previewPayload(s) {
    if (!s) return '';
    try {
      var o = JSON.parse(s);
      if (typeof o === 'string') return o;
      if (o && typeof o === 'object') {
        var ks = ['text', 'message', 'summary', 'payload'];
        for (var i = 0; i < ks.length; i++) if (typeof o[ks[i]] === 'string') return o[ks[i]];
      }
    } catch (e) { /* fall through */ }
    return s;
  }

  function buildBubble(msg) {
    var isLeft = !threadA || msg.from.toLowerCase() === threadA;
    var hue = hueFor(msg.from);
    var tint = 'oklch(0.94 0.06 ' + hue + ')';
    var corner = isLeft ? 'border-bottom-left-radius:3px' : 'border-bottom-right-radius:3px';

    var wrapper = document.createElement('div');
    wrapper.setAttribute('data-msg-id', msg.id);
    wrapper.style.cssText = 'display:flex;flex-direction:' + (isLeft ? 'row' : 'row-reverse') + ';gap:9px;margin-bottom:10px;align-items:flex-end;animation:v2-bubble-in 0.25s ease-out';

    var avBox = document.createElement('span');
    avBox.style.cssText = 'display:inline-flex;width:20px;height:20px;flex-shrink:0;align-items:center;justify-content:center';
    var av = getAvatar(msg.from);
    if (av) avBox.appendChild(av.cloneNode(true));

    var col = document.createElement('div');
    col.style.cssText = 'max-width:78%;display:flex;flex-direction:column;align-items:' + (isLeft ? 'flex-start' : 'flex-end');

    var head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:baseline;gap:6px;margin-bottom:3px;flex-direction:' + (isLeft ? 'row' : 'row-reverse');
    var name = document.createElement('span');
    name.style.cssText = 'font-weight:600;font-size:12px';
    name.textContent = msg.from;
    var time = document.createElement('span');
    time.style.cssText = 'color:rgba(74,59,77,0.42);font-size:10.5px;font-family:"JetBrains Mono",monospace';
    time.textContent = fmtTime(msg.created_at);
    head.appendChild(name); head.appendChild(time);

    var bub = document.createElement('div');
    bub.style.cssText = 'background:' + tint + ';border:1px solid rgba(217,130,175,0.10);border-radius:12px;' + corner + ';padding:7px 11px;font-size:12.5px;line-height:1.5;white-space:pre-wrap;box-shadow:0 1px 0 rgba(255,255,255,0.85) inset, 0 6px 16px rgba(217,130,175,0.07), 0 1px 0 rgba(217,130,175,0.12)';
    bub.textContent = previewPayload(msg.payload);

    col.appendChild(head); col.appendChild(bub);
    wrapper.appendChild(avBox); wrapper.appendChild(col);
    return wrapper;
  }

  var es = new EventSource('/sse/threads/' + ${JSON.stringify(correlationId)});
  es.addEventListener('message', function(ev) {
    try {
      var msg = JSON.parse(ev.data);
      if (box.querySelector('[data-msg-id="' + msg.id + '"]')) return;
      box.appendChild(buildBubble(msg));
      box.scrollTop = box.scrollHeight;
    } catch (e) { /* ignore malformed events */ }
  });
  window.addEventListener('beforeunload', function(){ es.close(); });
})();
</script>
<style>
@keyframes v2-bubble-in {
  from { opacity: 0; transform: translateY(6px); }
  to   { opacity: 1; transform: translateY(0); }
}
</style>`);

// ── Page ───────────────────────────────────────────────────────────
export const V2HomePage: FC<V2HomeProps> = ({
  stats, agents, edges, liveThread, activities, userRole, csrfToken,
}) => {
  const dateLine = `${fmtDate(new Date().toISOString())} · ${stats.agentsLive}/${stats.agentsTotal} agents · ${stats.msg24h} msg/24h`;

  return (
    <V2Layout title="Overview" active="HOME" userRole={userRole} csrfToken={csrfToken}>
      <div style="padding:24px 32px">
        {/* Page head */}
        <div class="v2-page-head">
          <div>
            <h1 class="v2-h1">Overview</h1>
            <div class="v2-page-sub">{dateLine}</div>
          </div>
          <div style="display:flex;gap:8px">
            <V2Btn href="/messages">Messages</V2Btn>
            {userRole === "admin" && <V2Btn href="/agents" kind="primary">+ New agent</V2Btn>}
          </div>
        </div>

        {/* KPI strip — mesh-native: agent presence, message rate, thread
            grouping rule, NATS stream usage. */}
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:18px">
          <KpiCard
            label="AGENTS · LIVE"
            value={`${stats.agentsLive}/${stats.agentsTotal}`}
            sub={`${stats.agentsStale} stale · ${stats.agentsActive} active token`}
            accent={V2_TOKENS.accent2}
          />
          <KpiCard
            label="MSG · 24H"
            value={stats.msg24h}
            sub={`${(stats.msg24h / 60 / 24).toFixed(1)}/min avg · 60 msg/min cap`}
            accent={V2_TOKENS.accent}
            spark={agents.find((a) => a.heat.some((v) => v > 0))?.heat}
          />
          <KpiCard
            label="THREADS"
            value={stats.threads}
            sub="correlation_id-grouped"
          />
          <KpiCard
            label="NATS · STREAM"
            value={stats.stream ? fmtBytes(stats.stream.bytes) : "—"}
            sub={
              stats.stream
                ? `MESH_MESSAGES · ${fmtSeconds(stats.stream.maxAgeSeconds)} · ${fmtBytes(stats.stream.maxBytes)}`
                : "NATS unreachable"
            }
            accent={V2_TOKENS.info}
          />
        </div>

        {/* Mesh + Live thread row */}
        <div style="display:grid;grid-template-columns:1.2fr 1fr;gap:12px;margin-bottom:18px">
          <V2Card title="Mesh topology" sub="last 7 days"
            right={<span style={`font-size:11px;color:${V2_TOKENS.accent2};font-family:${V2_TOKENS.text}`}>● live</span>}>
            <div style="padding:16px;display:flex;justify-content:center">
              <MeshGraph agents={agents} edges={edges} />
            </div>
          </V2Card>

          <V2Card title="Live thread"
            sub={liveThread ? liveThread.correlation_id : "no active thread"}
            right={<V2Tag color={V2_TOKENS.accent2}>SSE</V2Tag>}>
            <div
              data-sse-thread={liveThread?.correlation_id ?? ""}
              data-thread-a={liveThread?.participants[0] ?? ""}
              style="padding:14px 16px;max-height:340px;overflow-y:auto">
              {liveThread && liveThread.messages.length > 0 ? (
                liveThread.messages.map((m) => {
                  const fromAgent = agents.find((a) => a.name.toLowerCase() === m.from.toLowerCase());
                  const isLeft = liveThread.participants[0]?.toLowerCase() === m.from.toLowerCase();
                  return <ThreadBubble msg={m} isLeft={isLeft} agentRole={fromAgent?.role} />;
                })
              ) : (
                <div style={`padding:24px;text-align:center;color:${V2_TOKENS.textMute};font-size:12.5px`}>
                  No conversations yet.
                </div>
              )}
            </div>
          </V2Card>
        </div>

        {/* Agents grid */}
        <V2Card title="Agents" sub={`${stats.agentsTotal} total`}
          right={
            <div style="display:flex;gap:4px">
              {["All", "Live", "Stale", "Off"].map((f, i) => (
                <span style={`font-size:11.5px;padding:4px 11px;border-radius:999px;${i === 0 ? "background:rgba(255,255,255,0.7);" : ""}border:1px solid ${V2_TOKENS.line};color:${i === 0 ? V2_TOKENS.text : V2_TOKENS.textDim}`}>
                  {f}
                </span>
              ))}
            </div>
          }>
          <div style="padding:12px;display:grid;grid-template-columns:repeat(5,1fr);gap:8px">
            {agents.map((a) => {
              const live = a.presence === "live";
              const border = live
                ? `border:1px solid ${withAlpha(V2_TOKENS.accent, 0.5)}`
                : `border:${V2_TOKENS.line2}`;
              const shadow = live
                ? `box-shadow: 0 4px 14px ${withAlpha(V2_TOKENS.accent, 0.18)}, inset 0 1px 0 rgba(255,255,255,0.7);`
                : "";
              return (
                <div style={`background:${V2_TOKENS.surface};${border};border-radius:${V2_TOKENS.radius + 2}px;padding:11px 13px;${shadow}`}>
                  <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
                    <V2Avatar agentId={a.id} role={a.role ?? undefined} size={22} />
                    <div style="flex:1;overflow:hidden">
                      <div style="font-size:12.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{a.name}</div>
                      <div style={`font-size:10.5px;color:${V2_TOKENS.textMute};font-family:${V2_TOKENS.text}`}>{a.role ?? "—"}</div>
                    </div>
                    <V2Dot presence={a.presence} size={6} />
                  </div>
                  <div style="display:flex;align-items:flex-end;justify-content:space-between">
                    <div>
                      <div style={`font-size:16px;font-weight:700;letter-spacing:-0.02em;color:${a.msg24 > 0 ? V2_TOKENS.text : V2_TOKENS.textMute}`}>{a.msg24}</div>
                      <div style={`font-size:10px;color:${V2_TOKENS.textMute};letter-spacing:0.06em`}>24H</div>
                    </div>
                    <V2Spark data={a.heat} w={70} h={20}
                      stroke={a.msg24 > 0 ? V2_TOKENS.accent : V2_TOKENS.textMute} />
                  </div>
                </div>
              );
            })}
          </div>
        </V2Card>

        {/* Recent activity */}
        <div style="margin-top:18px">
          <V2Card title="Recent activity" sub="last 6 events"
            right={<V2Btn href="/activity" kind="ghost">view all →</V2Btn>}>
            {activities.length === 0 ? (
              <div style={`padding:24px;text-align:center;color:${V2_TOKENS.textMute};font-size:12.5px`}>
                No activity yet.
              </div>
            ) : (
              activities.slice(0, 6).map((ev, i) => {
                const ag = agents.find((a) => a.name === ev.agent_name);
                return (
                  <div style={`display:grid;grid-template-columns:80px 24px 1fr 100px;align-items:center;gap:12px;padding:9px 16px;${i < Math.min(6, activities.length) - 1 ? `border-bottom:1px solid ${V2_TOKENS.line}` : ""}`}>
                    <span style={`color:${V2_TOKENS.textMute};font-size:11.5px;font-family:${V2_TOKENS.text}`}>{fmtRel(ev.created_at)}</span>
                    {ag ? <V2Avatar agentId={ag.id} role={ag.role ?? undefined} size={18} /> : <div />}
                    <span style="font-size:13px">{ev.summary ?? ev.action}</span>
                    <span style={`font-size:10.5px;color:${V2_TOKENS.textMute};text-align:right;font-family:${V2_TOKENS.text};letter-spacing:0.04em`}>{ev.action}</span>
                  </div>
                );
              })
            )}
          </V2Card>
        </div>
      </div>

      {/* Hidden avatar pool — SSE script clones from here to avoid
          re-running the avatar generator client-side. One entry per agent
          known at page render. Unknown senders fall back to no avatar. */}
      {liveThread && (
        <div id="v2-avatar-pool" hidden>
          {agents.map((a) => (
            <div data-name={a.name.toLowerCase()}>
              {raw(renderAvatarSvg(a.id, a.role ?? undefined, { size: 20 }))}
            </div>
          ))}
        </div>
      )}
      {liveThread && SSE_SCRIPT(liveThread.correlation_id)}
    </V2Layout>
  );
};
