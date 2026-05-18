// V2 Agents — Soft Pastel admin screen.
// Sortable table on the left, inspect sidepanel on the right, optional
// inline new-agent form. Replaces src/views/agents.tsx.

import type { FC } from "hono/jsx";
import { raw } from "hono/html";
import type { Presence } from "../../services/presence.js";
import type { HourlyHeat } from "../../services/dashboard-stats.js";
import { V2Layout } from "./layout.js";
import { V2Card, V2Btn, V2Tag, V2Dot, V2Spark, V2Heat, V2Avatar, withAlpha } from "./components.js";
import { V2_TOKENS } from "./tokens.js";

export interface V2AgentsAgent {
  id: string;
  name: string;
  role: string | null;
  capabilities: string[];
  is_active: boolean;
  presence: Presence;
  msg24: number;
  heat: HourlyHeat;
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
  userRole?: string;
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

function fmtCreated(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" }) +
    " · " + d.toTimeString().slice(0, 5);
}

const TokenSuccessPanel: FC<{ newToken: string }> = ({ newToken }) => (
  <V2Card title="New token created" sub="Save it now — it will not be shown again."
    right={<V2Tag color={V2_TOKENS.accent2}>● fresh</V2Tag>}>
    <div style="padding:16px">
      <code style={`display:block;font-family:${V2_TOKENS.text};font-size:12px;background:${V2_TOKENS.surface2};padding:10px 12px;border-radius:${V2_TOKENS.radius}px;border:1px solid ${V2_TOKENS.line2};word-break:break-all`}>
        {newToken}
      </code>
      <details style="margin-top:12px;font-size:12.5px">
        <summary style={`cursor:pointer;color:${V2_TOKENS.textDim};font-family:${V2_TOKENS.text};letter-spacing:0.04em;text-transform:uppercase;font-size:10.5px`}>Setup snippets</summary>
        <div style="margin-top:10px">
          <div style={`font-size:11px;font-weight:600;margin-bottom:4px;color:${V2_TOKENS.textDim}`}>Claude Code / Gemini CLI</div>
          <pre style={`font-family:${V2_TOKENS.text};font-size:11px;background:${V2_TOKENS.surface2};padding:10px 12px;border-radius:${V2_TOKENS.radius}px;border:1px solid ${V2_TOKENS.line};overflow-x:auto;margin:0;white-space:pre`}>{`"mesh": {
  "type": "streamable-http",
  "url": "https://moshi.enki.run/mcp",
  "headers": { "Authorization": "Bearer ${newToken}" }
}`}</pre>
          <div style={`font-size:11px;font-weight:600;margin:10px 0 4px;color:${V2_TOKENS.textDim}`}>Claude Desktop · OAuth 2.1 + PKCE</div>
          <pre style={`font-family:${V2_TOKENS.text};font-size:11px;background:${V2_TOKENS.surface2};padding:10px 12px;border-radius:${V2_TOKENS.radius}px;border:1px solid ${V2_TOKENS.line};overflow-x:auto;margin:0;white-space:pre`}>{`"mesh": {
  "command": "npx",
  "args": ["-y", "mcp-remote", "https://moshi.enki.run/mcp"]
}
// Browser-OAuth-Flow → Bearer-Token im Browser eingeben`}</pre>
          <div style={`font-size:11px;font-weight:600;margin:10px 0 4px;color:${V2_TOKENS.textDim}`}>moshi (Go binary)</div>
          <pre style={`font-family:${V2_TOKENS.text};font-size:11px;background:${V2_TOKENS.surface2};padding:10px 12px;border-radius:${V2_TOKENS.radius}px;border:1px solid ${V2_TOKENS.line};overflow-x:auto;margin:0;white-space:pre`}>{`export MESH_TOKEN="${newToken}"
./moshi status`}</pre>
          <div style={`font-size:11px;color:${V2_TOKENS.textMute};margin-top:10px;font-family:${V2_TOKENS.text}`}>
            Bearer token shown once · stored as SHA-256 hash · `from` is set server-side.
          </div>
        </div>
      </details>
    </div>
  </V2Card>
);

// Dashboard registration only persists name + auto-token. Role,
// capabilities and TTL flow in via mesh_register from the agent itself
// — that's why those fields aren't in this form.
const NewAgentForm: FC<{ csrfToken: string }> = ({ csrfToken }) => (
  <V2Card title="Register new agent" sub="POST /agents/create · agent then calls mesh_register"
    right={<V2Btn href="/agents" kind="ghost">× cancel</V2Btn>}>
    <form method="post" action="/agents/create" style="padding:18px 22px">
      <input type="hidden" name="csrf" value={csrfToken} />
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
        <div>
          <div style={`font-size:10.5px;color:${V2_TOKENS.textMute};letter-spacing:0.1em;margin-bottom:5px`}>NAME</div>
          <input class="v2-input v2-input--mono" type="text" name="name" placeholder="e.g. dex-eu" required autofocus />
        </div>
        <div>
          <div style={`font-size:10.5px;color:${V2_TOKENS.textMute};letter-spacing:0.1em;margin-bottom:5px`}>TOKEN</div>
          <div style={`padding:8px 12px;font-size:12px;font-family:${V2_TOKENS.text};border:1px solid ${V2_TOKENS.line2};border-radius:${V2_TOKENS.radius}px;background:${V2_TOKENS.surface2};color:${V2_TOKENS.textDim};display:flex;align-items:center;gap:8px`}>
            <span style="flex:1">tok_·····_auto</span>
            <span style={`color:${V2_TOKENS.accent2};font-size:10.5px`}>● auto-generate</span>
          </div>
        </div>
      </div>
      <div style={`font-size:11.5px;color:${V2_TOKENS.textMute};margin-bottom:14px;font-family:${V2_TOKENS.text};line-height:1.6`}>
        Role · capabilities · TTL · auth come from <strong style={`color:${V2_TOKENS.text}`}>mesh_register</strong> when the
        agent first connects. Bearer-token shown once · stored as SHA-256 hash · <code>from</code> is set server-side.
      </div>
      <div style="display:flex;align-items:center;gap:10px">
        <div style="flex:1" />
        <V2Btn kind="primary" type="submit">Register agent</V2Btn>
      </div>
    </form>
  </V2Card>
);

const FilterChip: FC<{ active: boolean; href: string; children: any }> = ({ active, href, children }) => (
  <a href={href} style={`font-size:11.5px;padding:4px 11px;border-radius:999px;${active ? "background:rgba(255,255,255,0.7);" : ""}border:1px solid ${V2_TOKENS.line2};color:${active ? V2_TOKENS.text : V2_TOKENS.textDim};text-decoration:none`}>
    {children}
  </a>
);

const InspectPanel: FC<{ agent: V2AgentsAgent | null; csrfToken: string }> = ({ agent, csrfToken }) => {
  if (!agent) {
    return (
      <V2Card title="Inspect" sub="select an agent">
        <div style={`padding:32px;text-align:center;color:${V2_TOKENS.textMute};font-size:12.5px`}>
          Click any row in the agents table to inspect it.
        </div>
      </V2Card>
    );
  }
  const tokenColor = agent.is_active ? V2_TOKENS.accent2 : V2_TOKENS.textMute;
  const tokenLabel = agent.is_active ? "active" : "disabled";
  return (
    <V2Card title="Inspect" sub={agent.name} right={<V2Dot presence={agent.presence} size={8} />}>
      <div style="padding:16px">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:18px">
          <V2Avatar agentId={agent.id} role={agent.role ?? undefined} size={44} />
          <div style="flex:1">
            <div style="font-size:16px;font-weight:700;letter-spacing:-0.01em">{agent.name}</div>
            <div style={`font-size:11.5px;color:${V2_TOKENS.textDim};font-family:${V2_TOKENS.text}`}>{agent.id}</div>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:110px 1fr;row-gap:7px;font-size:12.5px;margin-bottom:16px">
          <span style={`color:${V2_TOKENS.textMute}`}>Token</span>
          <span><V2Tag color={tokenColor}>{tokenLabel}</V2Tag></span>
          <span style={`color:${V2_TOKENS.textMute}`}>Role</span>
          <span>{agent.role ?? "—"}</span>
          <span style={`color:${V2_TOKENS.textMute}`}>Consumer</span>
          <span style={`font-family:${V2_TOKENS.text};font-size:11.5px`}>mesh.agents.{agent.name.toLowerCase()}.inbox</span>
          <span style={`color:${V2_TOKENS.textMute}`}>Capabilities</span>
          <div style="display:flex;gap:4px;flex-wrap:wrap">
            {agent.capabilities.length > 0 ? agent.capabilities.map((c) => (
              <span style={`font-size:10.5px;padding:1px 7px;border-radius:999px;background:${withAlpha(V2_TOKENS.text, 0.06)};color:${V2_TOKENS.textDim};font-family:${V2_TOKENS.text}`}>{c}</span>
            )) : <span style={`color:${V2_TOKENS.textMute}`}>—</span>}
          </div>
          <span style={`color:${V2_TOKENS.textMute}`}>TTL</span>
          <span style={`font-family:${V2_TOKENS.text};font-size:12px`}>86 400 s · 24 h</span>
          <span style={`color:${V2_TOKENS.textMute}`}>Created</span>
          <span style={`font-family:${V2_TOKENS.text};font-size:12px`}>{fmtCreated(agent.created_at)}</span>
          <span style={`color:${V2_TOKENS.textMute}`}>Last seen</span>
          <span style={`font-family:${V2_TOKENS.text};font-size:12px`}>{fmtRel(agent.last_seen_at)}</span>
        </div>
        <div style="margin-bottom:16px">
          <div style={`font-size:10.5px;color:${V2_TOKENS.textMute};margin-bottom:6px;letter-spacing:0.1em;text-transform:uppercase`}>Activity · 24h</div>
          <V2Heat data={agent.heat} cell={10} gap={2} color={V2_TOKENS.accent} />
        </div>
        <div style="display:flex;flex-direction:column;gap:6px">
          <V2Btn href={`/conversations?agent=${encodeURIComponent(agent.name)}`} kind="primary">Open conversations</V2Btn>
          {agent.is_active ? (
            <>
              <form method="post" action="/agents/reset-token">
                <input type="hidden" name="csrf" value={csrfToken} />
                <input type="hidden" name="id" value={agent.id} />
                <V2Btn type="submit">↻ Reset token</V2Btn>
              </form>
              <form method="post" action="/agents/revoke">
                <input type="hidden" name="csrf" value={csrfToken} />
                <input type="hidden" name="id" value={agent.id} />
                <V2Btn type="submit" kind="danger-outline">Deactivate</V2Btn>
              </form>
            </>
          ) : (
            <form method="post" action="/agents/reactivate">
              <input type="hidden" name="csrf" value={csrfToken} />
              <input type="hidden" name="id" value={agent.id} />
              <V2Btn type="submit" kind="primary">Reactivate</V2Btn>
            </form>
          )}
          <form method="post" action="/agents/delete" onsubmit="return confirm('Delete agent? Name becomes reusable.')">
            <input type="hidden" name="csrf" value={csrfToken} />
            <input type="hidden" name="id" value={agent.id} />
            <V2Btn type="submit" kind="ghost">Delete</V2Btn>
          </form>
        </div>
      </div>
    </V2Card>
  );
};

export const V2AgentsPage: FC<V2AgentsProps> = ({
  agents, csrfToken, newToken, error, inspectId, showNewForm, userRole,
}) => {
  const inspected = agents.find((a) => a.id === inspectId)
    ?? agents.find((a) => a.presence === "live")
    ?? agents[0]
    ?? null;
  const total = agents.length;
  const live = agents.filter((a) => a.presence === "live").length;
  const stale = agents.filter((a) => a.presence === "stale").length;
  const off = total - live - stale;

  return (
    <V2Layout title="Agents" active="AGENTS" userRole={userRole} csrfToken={csrfToken}>
      <div style="padding:24px 32px">
        <div style="display:flex;align-items:baseline;gap:14px;margin-bottom:18px">
          <h1 class="v2-h1">Agents</h1>
          <span style={`color:${V2_TOKENS.textMute};font-family:${V2_TOKENS.text}`}>{total}</span>
          <div style="flex:1" />
          {showNewForm
            ? <V2Btn href="/agents" kind="ghost">× cancel</V2Btn>
            : <V2Btn href="/agents?new=1" kind="primary">+ New agent</V2Btn>}
        </div>

        {error && (
          <div style={`padding:10px 14px;background:${withAlpha(V2_TOKENS.danger, 0.08)};border:1px solid ${withAlpha(V2_TOKENS.danger, 0.30)};border-radius:${V2_TOKENS.radius}px;margin-bottom:14px;font-size:13px;color:${V2_TOKENS.danger}`}>
            {error}
          </div>
        )}

        {newToken && <div style="margin-bottom:14px"><TokenSuccessPanel newToken={newToken} /></div>}

        {showNewForm && <div style="margin-bottom:14px"><NewAgentForm csrfToken={csrfToken} /></div>}

        <div style="display:grid;grid-template-columns:1fr 320px;gap:12px">
          <V2Card title="All agents"
            sub={`${total} total`}
            right={
              <div style="display:flex;gap:4px">
                <FilterChip active={true} href="/agents">All ({total})</FilterChip>
                <FilterChip active={false} href="/agents?presence=live">Live ({live})</FilterChip>
                <FilterChip active={false} href="/agents?presence=stale">Stale ({stale})</FilterChip>
                <FilterChip active={false} href="/agents?presence=off">Off ({off})</FilterChip>
              </div>
            }>
            <div style={`display:grid;grid-template-columns:24px 1.4fr 0.8fr 1.3fr 60px 80px 80px 70px;padding:9px 14px;font-size:10.5px;color:${V2_TOKENS.textMute};letter-spacing:0.08em;text-transform:uppercase;border-bottom:1px solid ${V2_TOKENS.line};gap:12px`}>
              <span></span>
              <span>Name</span>
              <span>Role</span>
              <span>Capabilities</span>
              <span style="text-align:right">24h</span>
              <span>Activity</span>
              <span>Last seen</span>
              <span style="text-align:right">Token</span>
            </div>
            {agents.map((a, i) => {
              const selected = inspected?.id === a.id;
              return (
                <a href={`/agents?inspect=${a.id}`}
                  style={`display:grid;grid-template-columns:24px 1.4fr 0.8fr 1.3fr 60px 80px 80px 70px;padding:10px 14px;align-items:center;gap:12px;font-size:13px;${i < agents.length - 1 ? `border-bottom:1px solid ${V2_TOKENS.line};` : ""}background:${selected ? `linear-gradient(180deg, ${withAlpha(V2_TOKENS.accent, 0.10)}, ${withAlpha(V2_TOKENS.accent, 0.04)})` : "transparent"};border-left:2px solid ${selected ? V2_TOKENS.accent : "transparent"};text-decoration:none;color:inherit`}>
                  <V2Avatar agentId={a.id} role={a.role ?? undefined} size={22} />
                  <div style="display:flex;align-items:center;gap:8px">
                    <span style={`font-weight:600;color:${a.is_active ? V2_TOKENS.text : V2_TOKENS.textMute}`}>{a.name}</span>
                    <V2Dot presence={a.presence} size={6} />
                  </div>
                  <span style={`color:${V2_TOKENS.textDim};font-size:12px;font-family:${V2_TOKENS.text}`}>{a.role ?? "—"}</span>
                  <div style="display:flex;gap:4px;flex-wrap:wrap;overflow:hidden">
                    {a.capabilities.slice(0, 3).map((c) => (
                      <span style={`font-size:10px;padding:1px 6px;border-radius:999px;background:${withAlpha(V2_TOKENS.text, 0.05)};color:${V2_TOKENS.textDim};font-family:${V2_TOKENS.text}`}>{c}</span>
                    ))}
                    {a.capabilities.length > 3 && (
                      <span style={`font-size:10px;color:${V2_TOKENS.textMute};font-family:${V2_TOKENS.text}`}>+{a.capabilities.length - 3}</span>
                    )}
                    {a.capabilities.length === 0 && (
                      <span style={`font-size:11px;color:${V2_TOKENS.textMute}`}>—</span>
                    )}
                  </div>
                  <span style={`text-align:right;font-variant-numeric:tabular-nums;font-family:${V2_TOKENS.text};color:${a.msg24 > 0 ? V2_TOKENS.text : V2_TOKENS.textMute}`}>{a.msg24}</span>
                  <V2Spark data={a.heat} w={70} h={18} stroke={a.msg24 > 0 ? V2_TOKENS.accent : V2_TOKENS.textMute} />
                  <span style={`color:${V2_TOKENS.textMute};font-size:11.5px;font-family:${V2_TOKENS.text}`}>{fmtRel(a.last_seen_at)}</span>
                  <div style="text-align:right">
                    <V2Tag color={a.is_active ? V2_TOKENS.accent2 : V2_TOKENS.textMute}>
                      {a.is_active ? "active" : "disabled"}
                    </V2Tag>
                  </div>
                </a>
              );
            })}
            {agents.length === 0 && (
              <div style={`padding:40px;text-align:center;color:${V2_TOKENS.textMute};font-size:13px`}>
                まだ · noch keine Agents. Klick „+ New agent".
              </div>
            )}
          </V2Card>

          <InspectPanel agent={inspected} csrfToken={csrfToken} />
        </div>
      </div>
      {raw(`<script>
(function(){
  // Auto-dismiss the new-token panel after 60s so it can't sit on screen.
  var t = document.querySelector('[data-token-success]');
  if (t) setTimeout(function(){ t.style.opacity = '0.5'; }, 60000);
})();
</script>`)}
    </V2Layout>
  );
};
