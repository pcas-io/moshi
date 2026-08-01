// V2 Overview ("Home") — SENTINEL Dark mission-control landing page.
// Hero with grid pattern + green glow, KPI band, dark mesh topology,
// SSE live thread, agent cards with working_on, recent activity.
// Live-thread card hydrates via SSE (see /sse/threads/:correlation_id).

import type { FC } from "hono/jsx";
import { raw } from "hono/html";
import type { Activity } from "../../types.js";
import type { Presence } from "../../services/presence.js";
import type { MeshEdge, HourlyHeat } from "../../services/dashboard-stats.js";
import { V2Layout } from "./layout.js";
import { V2Card, V2Btn, V2Avatar, V2Spark } from "./components.js";
import { V2_TOKENS, greenGlow } from "./tokens.js";
import { layoutMesh, type LayoutNode, type LayoutEdge } from "./layout-engine.js";
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

const MONO = "var(--v2-font-mono)";

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

function fmtUptime(seconds: number): string {
  if (seconds < 3600) return `${Math.max(1, Math.floor(seconds / 60))}M`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}H`;
  return `${Math.floor(seconds / 86400)}D`;
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

// ── Mesh-topology SVG (dark) ───────────────────────────────────────
const MESH_W = 680;
const MESH_H = 360;
const RECENT_MS = 2 * 60 * 60 * 1000; // 2h
const PULSE_MS = 5 * 60 * 1000;       // 5min

const MeshGraph: FC<{ agents: V2HomeAgent[]; edges: MeshEdge[] }> = ({ agents, edges }) => {
  if (agents.length === 0) {
    return (
      <div style={`width:100%;height:${MESH_H}px;display:flex;align-items:center;justify-content:center;color:${V2_TOKENS.textMute};font-family:${MONO};font-size:11px`}>
        まだ · NO AGENTS YET
      </div>
    );
  }

  const nodes: LayoutNode[] = agents.map((a) => ({ id: a.name }));
  const layoutEdges: LayoutEdge[] = edges.map((e) => ({ from: e.from, to: e.to, weight: e.count }));
  // Aggressive spread for 12+ agents on the 680x360 canvas: weak gravity
  // so nodes don't snap back to centre, strong repulsion + long edges to
  // push them apart, generous initial radius so they start near the rim.
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
    <svg viewBox={`0 0 ${MESH_W} ${MESH_H}`} style="display:block;width:100%;max-width:820px;margin:0 auto;height:auto;overflow:visible">
      {edges.map((e, i) => {
        const a = positions.get(e.from);
        const b = positions.get(e.to);
        if (!a || !b) return null;
        const recent = now - new Date(e.last).getTime() < RECENT_MS;
        const sw = (0.5 + (e.count / maxCount) * 2).toFixed(2);
        return (
          <line key={i}
            x1={a.x.toFixed(1)} y1={a.y.toFixed(1)}
            x2={b.x.toFixed(1)} y2={b.y.toFixed(1)}
            stroke={recent ? greenGlow(0.55) : "#333333"} stroke-width={sw} />
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
        const presence = presenceById.get(ag.name);
        const live = presence === "live";
        const stroke = live ? V2_TOKENS.accent : presence === "stale" ? V2_TOKENS.warn : "#333333";
        const N = 36;             // displayed avatar size in topology px-units
        const half = N / 2;
        const ringR = half + 5;   // pulse ring radius
        const inner = renderAvatarSvgInner(ag.id, ag.role ?? undefined);
        return (
          <g key={ag.id} transform={`translate(${p.x.toFixed(1)},${p.y.toFixed(1)})`}>
            {live && (
              <circle r={ringR} fill={greenGlow(0.14)}>
                <animate attributeName="r" values={`${ringR - 3};${ringR + 3};${ringR - 3}`} dur="2s" repeatCount="indefinite" />
                <animate attributeName="opacity" values="0.9;0.15;0.9" dur="2s" repeatCount="indefinite" />
              </circle>
            )}
            {/* Dark backdrop square with presence-colored stroke keeps the
                silhouette readable on the charcoal canvas. */}
            <rect x={-half - 1} y={-half - 1} width={N + 2} height={N + 2}
              rx="5" ry="5"
              fill="#1b1b1b"
              stroke={stroke}
              stroke-width={live ? "1.5" : "1"} />
            {/* Avatar embedded as nested SVG shapes, scaled from 32→N */}
            <g transform={`translate(${-half},${-half}) scale(${N / 32})`}
               shape-rendering="crispEdges">
              {raw(inner)}
            </g>
            <text y={half + 15} text-anchor="middle" font-size="11"
              style={`font-family:var(--v2-font-sans);fill:${live ? "#d9d9d9" : "#777777"};font-weight:${live ? 600 : 400}`}>
              {ag.name}
            </text>
          </g>
        );
      })}
    </svg>
  );
};

// ── KPI cell (hero band) ───────────────────────────────────────────
const KpiCell: FC<{ bar: string; value: string; label: string }> = ({ bar, value, label }) => (
  <div style={`background:${V2_TOKENS.bg};padding:18px clamp(16px,3vw,36px)`}>
    <div style="display:flex;align-items:center;gap:8px">
      <span style={`width:3px;height:26px;background:${bar}`} />
      <span style="font-size:26px;font-weight:700;letter-spacing:-0.04em">{value}</span>
    </div>
    <div style={`font-size:10px;letter-spacing:0.18em;color:${V2_TOKENS.textMute};text-transform:uppercase;margin-top:6px`}>{label}</div>
  </div>
);

// ── Thread bubble (dark oklch tint) ────────────────────────────────
const ThreadBubble: FC<{
  msg: V2HomeThread["messages"][0];
  isLeft: boolean;
  agentId: string;
  agentRole?: string;
}> = ({ msg, isLeft, agentId, agentRole }) => {
  const dir = isLeft ? "row" : "row-reverse";
  const align = isLeft ? "flex-start" : "flex-end";
  const hue = hueFor(msg.from);
  const corner = isLeft
    ? "border-bottom-left-radius:2px;"
    : "border-bottom-right-radius:2px;";
  return (
    <div data-msg-id={msg.id} style={`display:flex;gap:10px;margin-bottom:12px;align-items:flex-end;flex-direction:${dir}`}>
      <V2Avatar agentId={agentId} role={agentRole} size={20} bordered />
      <div style={`max-width:82%;display:flex;flex-direction:column;align-items:${align}`}>
        <div style={`display:flex;align-items:baseline;gap:8px;margin-bottom:3px;flex-direction:${dir}`}>
          <span style="font-size:11.5px;font-weight:600">{msg.from}</span>
          <span style={`font-family:${MONO};font-size:9.5px;color:${V2_TOKENS.textMute}`}>{fmtTime(msg.created_at)}</span>
        </div>
        <div style={`background:oklch(0.23 0.035 ${hue});border:1px solid oklch(0.34 0.06 ${hue});border-radius:8px;${corner}padding:8px 12px;font-size:12px;line-height:1.5;color:#e8e8e8;white-space:pre-wrap`}>{previewPayload(msg.payload)}</div>
      </div>
    </div>
  );
};

function previewPayload(rawStr: string, max: number = 240): string {
  // Try JSON first — show .text or first stringy field. Fall back to raw.
  try {
    const obj = JSON.parse(rawStr);
    if (typeof obj === "string") return obj.slice(0, max);
    if (obj && typeof obj === "object") {
      for (const key of ["text", "message", "summary", "payload"]) {
        const v = (obj as Record<string, unknown>)[key];
        if (typeof v === "string") return v.slice(0, max);
      }
    }
  } catch { /* fall through */ }
  return rawStr.slice(0, max);
}

// ── SSE hydration script ───────────────────────────────────────────
// Subscribes to /sse/threads/:id and appends a bubble matching the
// server-rendered ThreadBubble: avatar cloned from the hidden pool,
// name + timestamp header, dark hue-tinted bubble with corner cut on
// the sender side. Sender vs. receiver decided via `data-thread-a`.
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
    var corner = isLeft ? 'border-bottom-left-radius:2px' : 'border-bottom-right-radius:2px';

    var wrapper = document.createElement('div');
    wrapper.setAttribute('data-msg-id', msg.id);
    wrapper.style.cssText = 'display:flex;flex-direction:' + (isLeft ? 'row' : 'row-reverse') + ';gap:10px;margin-bottom:12px;align-items:flex-end;animation:v2-bubble-in 0.25s ease-out';

    var avBox = document.createElement('span');
    avBox.style.cssText = 'display:inline-flex;width:20px;height:20px;flex-shrink:0;border-radius:4px;overflow:hidden;border:1px solid #333333';
    var av = getAvatar(msg.from);
    if (av) avBox.appendChild(av.cloneNode(true));

    var col = document.createElement('div');
    col.style.cssText = 'max-width:82%;display:flex;flex-direction:column;align-items:' + (isLeft ? 'flex-start' : 'flex-end');

    var head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:baseline;gap:8px;margin-bottom:3px;flex-direction:' + (isLeft ? 'row' : 'row-reverse');
    var name = document.createElement('span');
    name.style.cssText = 'font-size:11.5px;font-weight:600';
    name.textContent = msg.from;
    var time = document.createElement('span');
    time.style.cssText = 'color:#666666;font-size:9.5px;font-family:"JetBrains Mono",monospace';
    time.textContent = fmtTime(msg.created_at);
    head.appendChild(name); head.appendChild(time);

    var bub = document.createElement('div');
    bub.style.cssText = 'background:oklch(0.23 0.035 ' + hue + ');border:1px solid oklch(0.34 0.06 ' + hue + ');border-radius:8px;' + corner + ';padding:8px 12px;font-size:12px;line-height:1.5;color:#e8e8e8;white-space:pre-wrap';
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
  const off = stats.agentsTotal - stats.agentsLive - stats.agentsStale;
  const uptime = fmtUptime(process.uptime());
  const perMin = (stats.msg24h / 60 / 24).toFixed(1);

  const hero = (
    <div class="v2-wrap v2-pad" style="position:relative;flex:1;display:flex;flex-direction:column;justify-content:flex-end;padding-top:26px;padding-bottom:26px;z-index:2;min-height:280px">
      <div class="v2-eyebrow v2-fade" style="letter-spacing:0.22em;animation-delay:0.2s">
        MESH STATUS — {fmtDate(new Date().toISOString())}
      </div>
      <h1 class="v2-fade" style="margin:8px 0 10px;font-size:clamp(34px,4.6vw,62px);font-weight:700;line-height:1.02;letter-spacing:-0.05em;text-transform:uppercase;animation-delay:0.35s">
        {stats.agentsLive}/{stats.agentsTotal} Agents <span style={`color:${V2_TOKENS.accent}`}>Online</span>
      </h1>
      <p class="v2-fade" style="margin:0 0 6px;font-weight:300;font-size:clamp(15px,1.6vw,19px);color:rgba(245,245,245,0.8);animation-delay:0.5s">
        Async agent-to-agent messaging, done right.
      </p>
      <p class="v2-fade" style={`margin:0;font-weight:300;font-size:13px;color:${V2_TOKENS.textDim};animation-delay:0.6s`}>
        {stats.msg24h} messages routed in the last 24 hours · {stats.threads} threads · {stats.incidents24h} incident{stats.incidents24h === 1 ? "" : "s"}/24h.
      </p>
      <div class="v2-fade" style="display:flex;flex-wrap:wrap;gap:10px;margin-top:18px;animation-delay:0.7s">
        {userRole === "admin" && (
          <V2Btn href="/agents?new=1" kind="primary">+ Register Agent</V2Btn>
        )}
        <V2Btn href="/conversations" kind="secondary">Open Conversations</V2Btn>
      </div>
      <div class="v2-fade" style={`font-family:${MONO};font-size:10.5px;color:${V2_TOKENS.textMute};margin-top:16px;letter-spacing:0.06em;animation-delay:0.85s`}>
        moshi.enki.run · NATS JETSTREAM · SINGLE-NODE · UPTIME {uptime}
      </div>
    </div>
  );

  return (
    <V2Layout title="Overview" active="HOME" userRole={userRole} csrfToken={csrfToken} hero={hero}>
      {/* KPI band */}
      <div style={`margin:0 calc(-1 * clamp(16px,3vw,36px));border-top:1px solid ${V2_TOKENS.line};border-bottom:1px solid ${V2_TOKENS.line}`}>
        <div style={`background:${V2_TOKENS.line};display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:1px`}>
          <KpiCell bar={V2_TOKENS.accent} value={`${stats.agentsLive}/${stats.agentsTotal}`} label={`Agents Live · ${stats.agentsStale} stale`} />
          <KpiCell bar={V2_TOKENS.accent} value={String(stats.msg24h)} label={`MSG / 24h · ${perMin}/min · cap 60/min`} />
          <KpiCell bar="#3a3a3a" value={String(stats.threads)} label="Threads · correlation_id" />
          <KpiCell
            bar={V2_TOKENS.info}
            value={stats.stream ? fmtBytes(stats.stream.bytes) : "—"}
            label={stats.stream
              ? `NATS Stream · ${fmtSeconds(stats.stream.maxAgeSeconds)} · ${fmtBytes(stats.stream.maxBytes)}`
              : "NATS Stream · unreachable"}
          />
        </div>
      </div>

      <div class="v2-pad">
        {/* Mesh + Live thread row */}
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(440px,100%),1fr));gap:14px;padding-top:24px">
          <V2Card title="Mesh Topology" sub="last 7 days"
            right={<span style={`font-family:${MONO};font-size:10px;color:${V2_TOKENS.accent};letter-spacing:0.1em`}>● LIVE</span>}>
            <div style="padding:10px;background-image:radial-gradient(circle,#1f1f1f 1px,transparent 1px);background-size:22px 22px">
              <MeshGraph agents={agents} edges={edges} />
            </div>
          </V2Card>

          <V2Card title="Live Thread"
            sub={liveThread ? liveThread.correlation_id : "no active thread"}
            right={<span style={`font-family:${MONO};font-size:10px;color:${V2_TOKENS.accent};border:1px solid ${greenGlow(0.4)};padding:2px 8px;border-radius:2px;letter-spacing:0.1em`}>SSE</span>}>
            <div
              data-sse-thread={liveThread?.correlation_id ?? ""}
              data-thread-a={liveThread?.participants[0] ?? ""}
              style="padding:16px 18px;max-height:360px;overflow-y:auto">
              {liveThread && liveThread.messages.length > 0 ? (
                liveThread.messages.map((m) => {
                  const isLeft = liveThread.participants[0]?.toLowerCase() === m.from.toLowerCase();
                  const fromAgent = agents.find((a) => a.name.toLowerCase() === m.from.toLowerCase());
                  return (
                    <ThreadBubble
                      msg={m}
                      isLeft={isLeft}
                      agentId={fromAgent?.id ?? m.from}
                      agentRole={fromAgent?.role ?? undefined}
                    />
                  );
                })
              ) : (
                <div style={`padding:24px;text-align:center;color:${V2_TOKENS.textMute};font-family:${MONO};font-size:11px`}>
                  しずか · ALL QUIET
                </div>
              )}
              {liveThread && (
                <a href={`/conversations?id=${encodeURIComponent(liveThread.correlation_id)}`}
                  style={`font-family:${MONO};font-size:10.5px;color:${V2_TOKENS.accent};letter-spacing:0.08em`}>
                  OPEN THREAD →
                </a>
              )}
            </div>
          </V2Card>
        </div>

        {/* Agents section */}
        <div style="padding-top:24px">
          <div style="display:flex;align-items:baseline;gap:14px;margin-bottom:12px;flex-wrap:wrap">
            <div style="font-size:11px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase">
              Agents <span style={`color:${V2_TOKENS.textMute};font-weight:400`}>— {stats.agentsTotal} registered</span>
            </div>
            <div style={`flex:1;height:1px;background:${V2_TOKENS.line};min-width:40px`} />
            <span style={`font-family:${MONO};font-size:10px;color:${V2_TOKENS.accent}`}>● {stats.agentsLive} LIVE</span>
            <span style={`font-family:${MONO};font-size:10px;color:${V2_TOKENS.warn}`}>● {stats.agentsStale} STALE</span>
            <span style={`font-family:${MONO};font-size:10px;color:${V2_TOKENS.textFaint}`}>● {off} OFF</span>
          </div>
          <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:10px">
            {agents.map((a) => {
              const live = a.presence === "live";
              const cardBd = live ? greenGlow(0.35) : "#2a2a2a";
              const nameColor = a.presence === "offline" || a.presence === "never" ? "#8a8a8a" : V2_TOKENS.text;
              const dotColor = live ? V2_TOKENS.accent : a.presence === "stale" ? V2_TOKENS.warn : "#4a4a4a";
              const dotShadow = live ? `box-shadow:0 0 8px ${greenGlow(0.6)}` : "";
              return (
                <div style={`background:${V2_TOKENS.surface};border:1px solid ${cardBd};border-radius:6px;padding:13px 14px`}>
                  <div style="display:flex;align-items:center;gap:9px;margin-bottom:10px">
                    <V2Avatar agentId={a.id} role={a.role ?? undefined} size={26} />
                    <div style="flex:1;overflow:hidden">
                      <div style={`font-size:12.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:${nameColor}`}>{a.name}</div>
                      <div style={`font-family:${MONO};font-size:9.5px;color:${V2_TOKENS.textMute};white-space:nowrap;overflow:hidden;text-overflow:ellipsis`}>{a.role ?? "—"}</div>
                    </div>
                    <span style={`width:6px;height:6px;border-radius:50%;flex-shrink:0;background:${dotColor};${dotShadow}`} />
                  </div>
                  <div style={`font-size:11px;color:${a.working_on ? V2_TOKENS.textDim : "#4a4a4a"};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:10px`}>
                    <span style={`color:${V2_TOKENS.accent}`}>▸</span> {a.working_on ?? "—"}
                  </div>
                  <div style="display:flex;align-items:flex-end;justify-content:space-between">
                    <div>
                      <div style={`font-size:15px;font-weight:700;letter-spacing:-0.02em;color:${a.msg24 > 0 ? V2_TOKENS.text : V2_TOKENS.textFaint}`}>{a.msg24}</div>
                      <div style={`font-size:8.5px;color:${V2_TOKENS.textMute};letter-spacing:0.15em`}>24H</div>
                    </div>
                    <V2Spark data={a.heat} w={64} h={18}
                      stroke={a.msg24 > 0 ? V2_TOKENS.accent : "#3a3a3a"} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Recent activity */}
        <div style="padding-top:24px;padding-bottom:26px">
          <V2Card title="Recent Activity" sub="last 6 events"
            right={<a href="/activity" style={`font-family:${MONO};font-size:10.5px;color:${V2_TOKENS.accent};letter-spacing:0.08em`}>VIEW ALL →</a>}>
            {activities.length === 0 ? (
              <div style={`padding:24px;text-align:center;color:${V2_TOKENS.textMute};font-family:${MONO};font-size:11px`}>
                まだ · NOTHING YET
              </div>
            ) : (
              activities.slice(0, 6).map((ev) => {
                const ag = agents.find((a) => a.name === ev.agent_name);
                return (
                  <div style={`display:grid;grid-template-columns:56px 24px minmax(160px,1fr) minmax(110px,150px);align-items:center;gap:14px;padding:9px 18px;border-top:1px solid ${V2_TOKENS.lineRow}`}>
                    <span style={`font-family:${MONO};font-size:10.5px;color:${V2_TOKENS.textMute}`}>{fmtRel(ev.created_at)}</span>
                    {ag ? <V2Avatar agentId={ag.id} role={ag.role ?? undefined} size={18} /> : <div />}
                    <span style={`font-size:12.5px;color:${V2_TOKENS.textBody};overflow:hidden;text-overflow:ellipsis;white-space:nowrap`}>{ev.summary ?? ev.action}</span>
                    <span style={`font-family:${MONO};font-size:10px;color:${V2_TOKENS.textMute};text-align:right;letter-spacing:0.06em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap`}>{ev.action}</span>
                  </div>
                );
              })
            )}
          </V2Card>
        </div>
      </div>

      {/* Hidden avatar pool — the SSE script clones from here to avoid
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
