// V2 Agents — SENTINEL Dark admin screen.
// Sortable table left, inspect panel right, inline new-agent form, green
// token-created panel with setup snippets, delete-confirm modal, presence
// filter chips (?presence=live|stale|off).

import type { FC } from "hono/jsx";
import { raw } from "hono/html";
import type { Presence } from "../../services/presence.js";
import type { HourlyHeat } from "../../services/dashboard-stats.js";
import { V2Layout } from "./layout.js";
import { V2Card, V2Btn, V2Avatar, V2Heat, V2Spark } from "./components.js";
import { V2_TOKENS, greenGlow } from "./tokens.js";

export interface V2AgentsAgent {
  id: string;
  name: string;
  role: string | null;
  capabilities: string[];
  is_active: boolean;
  presence: Presence;
  msg24: number;
  heat: HourlyHeat;
  working_on: string | null;
  last_seen_at: string | null;
  created_at: string;
}

export interface V2AgentsProps {
  agents: V2AgentsAgent[];
  csrfToken: string;
  newToken?: string;
  error?: string;
  inspectId?: string;
  showNewForm?: boolean;
  presenceFilter?: string;
  userRole?: string;
}

const MONO = "var(--v2-font-mono)";

function fmtRel(iso: string | null, now: number = Date.now()): string {
  if (!iso) return "—";
  const m = Math.round((now - new Date(iso).getTime()) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function fmtCreated(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" }) +
    " · " + d.toTimeString().slice(0, 5);
}

function dotColor(p: Presence): string {
  return p === "live" ? V2_TOKENS.accent : p === "stale" ? V2_TOKENS.warn : "#4a4a4a";
}

function dotShadow(p: Presence): string {
  return p === "live" ? `box-shadow:0 0 8px ${greenGlow(0.6)}` : "";
}

// Copy-to-clipboard for token + snippets. Buttons carry .v2-copy and copy
// the adjacent pre/code text; label flips to a confirmation briefly.
const COPY_SCRIPT = raw(`<script>
(function(){
  if (window.__v2copy) return; window.__v2copy = 1;
  function fallback(t, cb){
    var ta=document.createElement('textarea');
    ta.value=t; ta.style.position='fixed'; ta.style.opacity='0';
    document.body.appendChild(ta); ta.focus(); ta.select();
    try{document.execCommand('copy');}catch(_){}
    document.body.removeChild(ta); cb();
  }
  document.addEventListener('click', function(e){
    var b = e.target && e.target.closest && e.target.closest('.v2-copy');
    if(!b) return;
    var src = b.parentElement && b.parentElement.querySelector('pre, code');
    if(!src) return;
    var txt = src.innerText;
    var done = function(){
      var o=b.getAttribute('data-label')||'Copy';
      b.textContent='✓ COPIED';
      setTimeout(function(){ b.textContent=o; }, 1200);
    };
    if(navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(txt).then(done).catch(function(){fallback(txt,done);});
    } else { fallback(txt, done); }
  });
})();
</script>`);

// Delete-confirm modal + token-panel dismiss.
const AGENTS_SCRIPT = raw(`<script>
(function(){
  var modal = document.getElementById('v2-del-modal');
  document.addEventListener('click', function(e){
    var t = e.target;
    if (t && t.closest && t.closest('[data-del-open]') && modal){
      e.preventDefault(); modal.style.display = 'flex';
    }
    if (t && t.closest && t.closest('[data-del-close]') && modal){
      e.preventDefault(); modal.style.display = 'none';
    }
    var d = t && t.closest && t.closest('[data-dismiss-token]');
    if (d){
      var panel = document.getElementById('v2-token-panel');
      if (panel) panel.style.display = 'none';
    }
  });
  document.addEventListener('keydown', function(e){
    if (e.key === 'Escape' && modal && modal.style.display !== 'none'){
      modal.style.display = 'none';
    }
  });
})();
</script>`);

const CopyBtn: FC<{ label?: string }> = ({ label = "COPY" }) => (
  <button
    type="button"
    class="v2-copy"
    data-label={label}
    style={`position:absolute;top:6px;right:6px;background:${V2_TOKENS.btn3};border:none;border-radius:2px;color:${V2_TOKENS.text};font-family:var(--v2-font-sans);font-size:9px;letter-spacing:0.1em;text-transform:uppercase;cursor:pointer;padding:4px 8px`}
  >
    {label}
  </button>
);

const Snippet: FC<{ label: string; code: string }> = ({ label, code }) => (
  <div style="min-width:0">
    <div style="font-size:11px;font-weight:600;color:#bbbbbb;margin-bottom:5px">{label}</div>
    <div style="position:relative">
      <CopyBtn />
      <pre style={`font-family:${MONO};font-size:10.5px;line-height:1.7;background:${V2_TOKENS.inset};border:1px solid #2a2a2a;border-radius:4px;padding:10px 12px;margin:0;overflow-x:auto;color:#c9c9c9`}>{code}</pre>
    </div>
  </div>
);

const TokenPanel: FC<{ newToken: string }> = ({ newToken }) => (
  <div id="v2-token-panel" style={`margin-top:20px;background:linear-gradient(180deg,${greenGlow(0.06)},${greenGlow(0.02)}),${V2_TOKENS.surface};border:1px solid ${greenGlow(0.35)};border-radius:8px;overflow:hidden`}>
    <div style={`display:flex;align-items:center;gap:10px;padding:13px 18px;border-bottom:1px solid ${greenGlow(0.18)}`}>
      <div style="flex:1">
        <div style={`font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:${V2_TOKENS.accent}`}>● New Token Created</div>
        <div style={`font-family:${MONO};font-size:10px;color:#888888;margin-top:2px`}>save it now — it will not be shown again · stored as SHA-256 hash</div>
      </div>
      <button data-dismiss-token type="button" style={`background:transparent;border:1px solid ${V2_TOKENS.line2};border-radius:2px;color:${V2_TOKENS.textDim};font-family:var(--v2-font-sans);font-size:10px;letter-spacing:0.1em;text-transform:uppercase;cursor:pointer;padding:5px 10px`}>✕ Dismiss</button>
    </div>
    <div style="padding:16px 18px">
      <div style="position:relative;margin-bottom:16px">
        <CopyBtn />
        <code style={`display:block;font-family:${MONO};font-size:13px;background:${V2_TOKENS.inset};border:1px solid ${greenGlow(0.3)};border-radius:4px;padding:12px 90px 12px 14px;color:${V2_TOKENS.accent};word-break:break-all`}>
          {newToken}
        </code>
      </div>
      <div style={`font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:${V2_TOKENS.textMute};font-weight:600;margin-bottom:10px`}>Connect this agent — setup snippets</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(380px,100%),1fr));gap:12px">
        <Snippet
          label="moshi CLI — install / update (no repo needed)"
          code={`curl -fsSL https://moshi.enki.run/install.sh | sh
moshi self-update   # verify against server build`}
        />
        <Snippet
          label="Claude Code · CLI (registers the MCP server)"
          code={`claude mcp add --transport http moshi \\
  https://moshi.enki.run/mcp \\
  --header "Authorization: Bearer ${newToken}"`}
        />
        <Snippet
          label="Claude Code / Gemini CLI · mcpServers config"
          code={`"moshi": {
  "type": "streamable-http",
  "url": "https://moshi.enki.run/mcp",
  "headers": { "Authorization": "Bearer ${newToken}" }
}`}
        />
        <Snippet
          label="Claude Desktop · OAuth 2.1 + PKCE"
          code={`"moshi": {
  "command": "npx",
  "args": ["-y", "mcp-remote", "https://moshi.enki.run/mcp"]
}
// browser OAuth flow → paste bearer token`}
        />
        <Snippet
          label="moshi (Go binary) — for humans"
          code={`export MESH_TOKEN="${newToken}"
moshi status`}
        />
      </div>
    </div>
  </div>
);

// Dashboard registration only persists name + auto-token. Role,
// capabilities and TTL flow in via mesh_register from the agent itself.
const NewAgentForm: FC<{ csrfToken: string }> = ({ csrfToken }) => (
  <div style="margin-top:20px">
    <V2Card title="Register New Agent" sub="POST /agents/create · agent then calls mesh_register">
      <form method="post" action="/agents/create" style="padding:18px 22px">
        <input type="hidden" name="csrf" value={csrfToken} />
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px;margin-bottom:12px">
          <div>
            <div style={`font-size:10px;letter-spacing:0.18em;color:${V2_TOKENS.textMute};text-transform:uppercase;font-weight:600;margin-bottom:6px`}>Name</div>
            <input class="v2-input" type="text" name="name" placeholder="e.g. dex-eu" required autofocus
              pattern="[A-Za-z0-9][A-Za-z0-9_-]{0,63}"
              title="1–64 Zeichen: Buchstaben, Ziffern, - oder _ · Start alphanumerisch · keine Leerzeichen/Punkte" />
          </div>
          <div>
            <div style={`font-size:10px;letter-spacing:0.18em;color:${V2_TOKENS.textMute};text-transform:uppercase;font-weight:600;margin-bottom:6px`}>Token</div>
            <div style={`display:flex;align-items:center;gap:8px;background:${V2_TOKENS.inset};border:1px solid #2a2a2a;border-radius:4px;padding:10px 13px;font-family:${MONO};font-size:12px;color:#777777`}>
              <span style="flex:1">bt_·····_auto</span>
              <span style={`color:${V2_TOKENS.accent};font-size:10px`}>● AUTO-GENERATE</span>
            </div>
          </div>
        </div>
        <div style={`font-family:${MONO};font-size:10.5px;color:#777777;line-height:1.7;margin-bottom:14px`}>
          Role · capabilities · TTL come from <span style={`color:${V2_TOKENS.text}`}>mesh_register</span> when the
          agent first connects. 1–64 chars: alphanumeric start, - or _ · bearer token shown once · <span style={`color:${V2_TOKENS.text}`}>from</span> is set server-side.
        </div>
        <div style="display:flex;justify-content:flex-end;gap:10px">
          <V2Btn href="/agents" kind="ghost">Cancel</V2Btn>
          <V2Btn kind="primary" type="submit">Register Agent</V2Btn>
        </div>
      </form>
    </V2Card>
  </div>
);

const InspectPanel: FC<{ agent: V2AgentsAgent | null; csrfToken: string }> = ({ agent, csrfToken }) => {
  if (!agent) {
    return (
      <div style={`flex:1 1 300px;max-width:400px;min-width:280px`}>
        <V2Card title="Inspect" sub="select an agent">
          <div style={`padding:32px;text-align:center;color:${V2_TOKENS.textMute};font-family:${MONO};font-size:11px`}>
            Click any row in the agents table to inspect it.
          </div>
        </V2Card>
      </div>
    );
  }
  const tokenColor = agent.is_active ? V2_TOKENS.accent : V2_TOKENS.textMute;
  const tokenLabel = agent.is_active ? "active" : "disabled";
  return (
    <div class="v2-card" style="flex:1 1 300px;max-width:400px;min-width:280px">
      <div class="v2-card-head">
        <div style="flex:1">
          <div class="v2-card-title">Inspect</div>
          <div class="v2-card-sub">{agent.name}</div>
        </div>
        <span style={`width:8px;height:8px;border-radius:50%;background:${dotColor(agent.presence)};${dotShadow(agent.presence)}`} />
      </div>
      <div style="padding:16px 18px">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">
          <V2Avatar agentId={agent.id} role={agent.role ?? undefined} size={44} bordered />
          <div style="flex:1;overflow:hidden">
            <div style="font-size:16px;font-weight:700;letter-spacing:-0.01em">{agent.name}</div>
            <div style={`font-family:${MONO};font-size:10.5px;color:${V2_TOKENS.textMute}`}>{agent.id}</div>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:96px 1fr;row-gap:8px;font-size:12px;margin-bottom:16px;align-items:baseline">
          <span style={`color:${V2_TOKENS.textMute}`}>Token</span>
          <span style={`font-family:${MONO};font-size:10px;letter-spacing:0.06em;text-transform:uppercase;color:${tokenColor}`}>● {tokenLabel}</span>
          <span style={`color:${V2_TOKENS.textMute}`}>Role</span>
          <span style={`font-family:${MONO};font-size:11px;color:${V2_TOKENS.textBody}`}>{agent.role ?? "—"}</span>
          <span style={`color:${V2_TOKENS.textMute}`}>Consumer</span>
          <span style={`font-family:${MONO};font-size:10.5px;color:${V2_TOKENS.textBody};word-break:break-all`}>mesh.agents.{agent.name.toLowerCase()}.inbox</span>
          <span style={`color:${V2_TOKENS.textMute}`}>TTL</span>
          <span style={`font-family:${MONO};font-size:11px;color:${V2_TOKENS.textBody}`}>86 400 s · 24 h</span>
          <span style={`color:${V2_TOKENS.textMute}`}>Created</span>
          <span style={`font-family:${MONO};font-size:11px;color:${V2_TOKENS.textBody}`}>{fmtCreated(agent.created_at)}</span>
          <span style={`color:${V2_TOKENS.textMute}`}>Last seen</span>
          <span style={`font-family:${MONO};font-size:11px;color:${V2_TOKENS.textBody}`}>{fmtRel(agent.last_seen_at)}</span>
          <span style={`color:${V2_TOKENS.textMute}`}>Working on</span>
          <span style={`font-size:11.5px;color:${V2_TOKENS.textBody}`}>{agent.working_on ?? "—"}</span>
        </div>
        <div style="margin-bottom:14px">
          <div style={`font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:${V2_TOKENS.textMute};font-weight:600;margin-bottom:6px`}>Capabilities</div>
          <div style="display:flex;gap:5px;flex-wrap:wrap">
            {agent.capabilities.length > 0 ? agent.capabilities.map((c) => (
              <span style={`font-family:${MONO};font-size:10px;padding:2px 9px;border-radius:2px;background:${V2_TOKENS.chip};color:#bbbbbb`}>{c}</span>
            )) : <span style={`color:${V2_TOKENS.textMute};font-size:11px`}>—</span>}
          </div>
        </div>
        <div style="margin-bottom:18px">
          <div style={`font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:${V2_TOKENS.textMute};font-weight:600;margin-bottom:6px`}>Activity · 24h</div>
          <V2Heat data={agent.heat} cell={10} gap={2} />
        </div>
        <div style="display:flex;flex-direction:column;gap:7px">
          <V2Btn href={`/conversations?agent=${encodeURIComponent(agent.name)}`} kind="primary">Open Conversations</V2Btn>
          {agent.is_active ? (
            <>
              <form method="post" action="/agents/reset-token" style="display:contents">
                <input type="hidden" name="csrf" value={csrfToken} />
                <input type="hidden" name="id" value={agent.id} />
                <V2Btn type="submit">↻ Reset Token</V2Btn>
              </form>
              <form method="post" action="/agents/revoke" style="display:contents">
                <input type="hidden" name="csrf" value={csrfToken} />
                <input type="hidden" name="id" value={agent.id} />
                <V2Btn type="submit" kind="danger-outline">Deactivate</V2Btn>
              </form>
            </>
          ) : (
            <form method="post" action="/agents/reactivate" style="display:contents">
              <input type="hidden" name="csrf" value={csrfToken} />
              <input type="hidden" name="id" value={agent.id} />
              <V2Btn type="submit" kind="primary">Reactivate</V2Btn>
            </form>
          )}
          <button data-del-open type="button" style={`background:transparent;border:none;color:#777777;font-family:var(--v2-font-sans);font-size:10.5px;letter-spacing:0.1em;text-transform:uppercase;cursor:pointer;padding:8px`}>Delete Agent</button>
        </div>
      </div>
    </div>
  );
};

const DeleteModal: FC<{ agent: V2AgentsAgent; csrfToken: string }> = ({ agent, csrfToken }) => (
  <div id="v2-del-modal" style="position:fixed;inset:0;z-index:120;display:none;align-items:center;justify-content:center;padding:20px">
    <div data-del-close style="position:absolute;inset:0;background:rgba(0,0,0,0.7);backdrop-filter:blur(3px)" />
    <div style={`position:relative;width:420px;max-width:100%;background:${V2_TOKENS.modal};border:1px solid rgba(239,68,68,0.4);border-radius:8px;padding:22px;box-shadow:0 30px 80px rgba(0,0,0,0.7)`}>
      <div style={`font-size:10px;letter-spacing:0.2em;text-transform:uppercase;color:${V2_TOKENS.danger};font-weight:700;margin-bottom:8px`}>Destructive Action</div>
      <div style="font-size:17px;font-weight:700;letter-spacing:-0.02em;margin-bottom:8px">Delete agent "{agent.name}"?</div>
      <div style={`font-size:12.5px;color:${V2_TOKENS.textDim};line-height:1.65;margin-bottom:18px`}>
        The name becomes reusable and the token is invalidated immediately.
        Message history is kept for 30 days. This cannot be undone.
      </div>
      <div style="display:flex;justify-content:flex-end;gap:10px">
        <button data-del-close type="button" class="v2-btn">Cancel</button>
        <form method="post" action="/agents/delete" style="display:contents">
          <input type="hidden" name="csrf" value={csrfToken} />
          <input type="hidden" name="id" value={agent.id} />
          <V2Btn type="submit" kind="danger">Delete Forever</V2Btn>
        </form>
      </div>
    </div>
  </div>
);

export const V2AgentsPage: FC<V2AgentsProps> = ({
  agents, csrfToken, newToken, error, inspectId, showNewForm, presenceFilter, userRole,
}) => {
  const total = agents.length;
  const live = agents.filter((a) => a.presence === "live").length;
  const stale = agents.filter((a) => a.presence === "stale").length;
  const off = total - live - stale;

  const filter = presenceFilter === "live" || presenceFilter === "stale" || presenceFilter === "off"
    ? presenceFilter
    : undefined;
  const visible = filter
    ? agents.filter((a) =>
        filter === "off"
          ? a.presence === "offline" || a.presence === "never"
          : a.presence === filter)
    : agents;

  const inspected = agents.find((a) => a.id === inspectId)
    ?? visible.find((a) => a.presence === "live")
    ?? visible[0]
    ?? null;

  const chip = (label: string, value: string | undefined, count: number) => {
    const active = filter === value || (!filter && value === undefined);
    const href = value ? `/agents?presence=${value}` : "/agents";
    return <a class={`v2-chip${active ? " active" : ""}`} href={href}>{label} {count}</a>;
  };

  return (
    <V2Layout title="Agents" active="AGENTS" userRole={userRole} csrfToken={csrfToken}>
      <div class="v2-pad" style="padding-top:26px;padding-bottom:26px">
        <div style="display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap">
          <div>
            <div class="v2-eyebrow" style="margin-bottom:6px">ADMIN — TOKEN AUTH · SHA-256</div>
            <h1 class="v2-h1">Agents <span style={`color:${V2_TOKENS.textFaint};font-weight:400`}>· {total}</span></h1>
          </div>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            {chip("All", undefined, total)}
            {chip("Live", "live", live)}
            {chip("Stale", "stale", stale)}
            {chip("Off", "off", off)}
            <span style="margin-left:8px">
              {showNewForm
                ? <V2Btn href="/agents" kind="ghost">× Cancel</V2Btn>
                : <V2Btn href="/agents?new=1" kind="primary">+ New Agent</V2Btn>}
            </span>
          </div>
        </div>

        {error && (
          <div style={`margin-top:20px;display:flex;align-items:center;gap:8px;padding:10px 14px;background:rgba(239,68,68,0.06);border:1px solid rgba(239,68,68,0.4);border-radius:4px;font-family:${MONO};font-size:11.5px;color:${V2_TOKENS.danger}`}>
            <span style={`width:6px;height:6px;border-radius:50%;background:${V2_TOKENS.danger}`} />
            {error}
          </div>
        )}

        {newToken && <TokenPanel newToken={newToken} />}
        {showNewForm && <NewAgentForm csrfToken={csrfToken} />}

        <div style="display:flex;flex-wrap:wrap;gap:12px;padding-top:20px;align-items:flex-start">
          <div class="v2-card" style="flex:1 1 620px;min-width:0">
            <div style="overflow-x:auto">
              <div style="min-width:860px">
                <div style={`display:grid;grid-template-columns:24px 0.9fr 0.8fr 1.2fr 44px 78px 74px 70px;gap:10px;padding:10px 16px;font-size:9.5px;letter-spacing:0.14em;text-transform:uppercase;color:${V2_TOKENS.textFaint};font-weight:600;border-bottom:1px solid ${V2_TOKENS.line}`}>
                  <span></span><span>Name</span><span>Role</span><span>Capabilities</span>
                  <span style="text-align:right">24h</span><span style="text-align:right">Trend</span>
                  <span>Last seen</span><span style="text-align:right">Token</span>
                </div>
                {visible.map((a) => {
                  const selected = inspected?.id === a.id;
                  const inspectHref = `/agents?inspect=${a.id}${filter ? `&presence=${filter}` : ""}`;
                  return (
                    <a href={inspectHref}
                      style={`display:grid;grid-template-columns:24px 0.9fr 0.8fr 1.2fr 44px 78px 74px 70px;gap:10px;padding:9px 16px;align-items:center;border-top:1px solid ${V2_TOKENS.lineRow};cursor:pointer;background:${selected ? `linear-gradient(90deg,${greenGlow(0.07)},transparent)` : "transparent"};border-left:2px solid ${selected ? V2_TOKENS.accent : "transparent"};text-decoration:none;color:inherit`}>
                      <V2Avatar agentId={a.id} role={a.role ?? undefined} size={20} />
                      <div style="display:flex;align-items:center;gap:7px;overflow:hidden">
                        <span style={`font-size:12.5px;font-weight:600;color:${a.is_active ? V2_TOKENS.text : "#8a8a8a"};white-space:nowrap;overflow:hidden;text-overflow:ellipsis`}>{a.name}</span>
                        <span style={`width:6px;height:6px;border-radius:50%;flex-shrink:0;background:${dotColor(a.presence)};${dotShadow(a.presence)}`} />
                      </div>
                      <span style={`font-family:${MONO};font-size:10.5px;color:#888888;white-space:nowrap;overflow:hidden;text-overflow:ellipsis`}>{a.role ?? "—"}</span>
                      <div style="display:flex;gap:4px;overflow:hidden;align-items:center">
                        {a.capabilities.slice(0, 3).map((c) => (
                          <span style={`font-family:${MONO};font-size:9.5px;padding:1px 7px;border-radius:2px;background:${V2_TOKENS.chip};color:${V2_TOKENS.textDim};white-space:nowrap`}>{c}</span>
                        ))}
                        {a.capabilities.length > 3 && (
                          <span style={`font-family:${MONO};font-size:9.5px;color:${V2_TOKENS.textMute}`}>+{a.capabilities.length - 3}</span>
                        )}
                        {a.capabilities.length === 0 && (
                          <span style={`font-size:11px;color:${V2_TOKENS.textMute}`}>—</span>
                        )}
                      </div>
                      <span style={`font-family:${MONO};font-size:11.5px;text-align:right;color:${a.msg24 > 0 ? V2_TOKENS.text : V2_TOKENS.textFaint}`}>{a.msg24}</span>
                      <V2Spark data={a.heat} w={70} h={18} stroke={a.msg24 > 0 ? V2_TOKENS.accent : "#3a3a3a"} />
                      <span style={`font-family:${MONO};font-size:10px;color:${V2_TOKENS.textMute};white-space:nowrap`}>{fmtRel(a.last_seen_at)}</span>
                      <span style={`font-family:${MONO};font-size:9.5px;text-align:right;color:${a.is_active ? V2_TOKENS.accent : V2_TOKENS.textMute};letter-spacing:0.06em;text-transform:uppercase`}>{a.is_active ? "active" : "disabled"}</span>
                    </a>
                  );
                })}
                {visible.length === 0 && (
                  <div style={`padding:40px;text-align:center;color:${V2_TOKENS.textMute};font-family:${MONO};font-size:11px`}>
                    まだ · NO AGENTS — hit "+ New Agent".
                  </div>
                )}
              </div>
            </div>
          </div>

          <InspectPanel agent={inspected} csrfToken={csrfToken} />
        </div>
      </div>
      {inspected && <DeleteModal agent={inspected} csrfToken={csrfToken} />}
      {COPY_SCRIPT}
      {AGENTS_SCRIPT}
    </V2Layout>
  );
};
