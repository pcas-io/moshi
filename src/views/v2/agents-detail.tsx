// V2 Agents — the detail aside and its delete-confirm modal.
//
// Split out of agents.tsx to keep both halves clear of the 700-line rule. It
// also holds the agent shape, the relative-time helpers and the handful of
// style atoms the table half shares, so the dependency runs one way only:
// agents.tsx -> agents-detail.tsx.

import type { FC } from "hono/jsx";
import { raw } from "hono/html";
import type { Presence } from "../../services/presence.js";
import { PRESENCE_THRESHOLDS } from "../../services/presence.js";
import type { HourlyHeat } from "../../services/dashboard-stats.js";
import { MESSAGE_RETENTION_DAYS } from "../../types.js";
import { AGENT_NAME_PATTERN, AGENT_NAME_RULE } from "../../services/agent.js";
import { V2Avatar, V2Dot } from "./components.js";
import { V2_FONT_FAMILY_MONO, V2_TOKENS } from "./tokens.js";

const T = V2_TOKENS;

export interface V2AgentsAgent {
  id: string;
  name: string;
  /** The immutable NATS address token — what the Inbox row shows. */
  inbox_key: string;
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

// ── Style atoms shared with the table half ──────────────────────

/** Text on a solid green or red fill — the same value as `card`, another job. */
export const ON_SOLID = "#ffffff";

export const CARD_PANEL =
  `background:${T.card};border:1px solid ${T.line};border-radius:${T.radiusCard}px;overflow:hidden`;

// Note on greys: `dim` clears 4.5:1 only at 13px and up, so every string below
// that size here uses `faint`, which is the darker of the two. `faint` is also
// what the spec asks for on an absent value at any size.

/**
 * The hover states from spec §8 that an inline `style` cannot carry.
 *
 * An inline declaration outranks every class rule, so `.d-ghost:hover` and
 * `.d-row:hover` are dead on arrival the moment an element states its own
 * `background`. Each class below therefore owns the resting fill *and* the
 * hover fill, and the elements that wear it leave `background` (and, for the
 * ghost, `color`) out of their inline style. The agent row needs none of
 * this: it simply stops declaring a background when it is not selected, and
 * the shared `.d-row:hover` reaches it again.
 *
 * Nothing moves on hover — no translate, no scale, no shadow growth.
 */
export const AGENTS_CSS = `
.d-pill { background: var(--card); }
.d-pill:hover { background: var(--sunk); }
.d-outline { background: var(--card); }
.d-outline:hover { background: var(--subtle); }
.d-delete { background: transparent; color: var(--dim); }
.d-delete:hover { background: var(--subtle); color: var(--ink); }
`;

// ── Time, in the words a person would say ───────────────────────

function minutesSince(iso: string | null, now: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : Math.round((now - t) / 60_000);
}

/** "just now" · "23 min ago" · "3 days ago" · "never". */
export function fmtRel(iso: string | null, now: number = Date.now()): string {
  const mins = minutesSince(iso, now);
  if (mins === null) return "never";
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

// Spelled out rather than taken from Intl: en-GB abbreviates September as
// "Sept", which breaks the uniform three-letter column, and the server's ICU
// build should not be able to change what the page says.
const MONTHS_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

/** "4 Sep, 09:12" — day and time, no year: a roster is a current thing. */
function fmtRegistered(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "unknown";
  return `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}, ${d.toTimeString().slice(0, 5)}`;
}

/** Minutes of silence after which an agent stops counting as online. */
const QUIET_AFTER_MINUTES = Math.round(PRESENCE_THRESHOLDS.liveMs / 60_000);

export function presenceSentence(agent: V2AgentsAgent, now: number = Date.now()): string {
  switch (agent.presence) {
    case "live": {
      const mins = minutesSince(agent.last_seen_at, now);
      return mins === null || mins < 1
        ? "Online — last seen just now"
        : `Online — last seen ${mins} min ago`;
    }
    case "stale":
      return `Quiet — no MCP call in the last ${QUIET_AFTER_MINUTES} minutes`;
    case "offline":
      return "Asleep — presence expired";
    case "never":
      return "Never connected — it has a token but has never called in";
  }
}

// ── Action buttons ──────────────────────────────────────────────

const ACTION_BASE =
  "font-family:inherit;font-size:14.5px;font-weight:600;" +
  `padding:11px 16px;border-radius:${T.radiusControl}px;cursor:pointer`;

const ACTION_PRIMARY =
  `${ACTION_BASE};background:${T.green};border:none;color:${ON_SOLID};` +
  "text-decoration:none;text-align:center;display:block";

// The outlined pair state no background: `.d-outline` carries both the resting
// `card` fill and the `subtle` hover fill.
const ACTION_SECONDARY =
  `${ACTION_BASE};border:1px solid ${T.lineStrong};` +
  `color:${T.ink};text-align:left;width:100%`;

const ACTION_DANGER =
  `${ACTION_BASE};border:1px solid ${T.redLine};` +
  `color:${T.red};text-align:left;width:100%`;

/**
 * The consequence line lives inside the control, not under it: that is the
 * point of the pattern — a disruptive action says what it costs where you
 * click it.
 */
const subline = (color: string): string =>
  `display:block;font-size:12.5px;font-weight:400;color:${color}`;

const ActionForm: FC<{
  action: string;
  csrfToken: string;
  agentId: string;
  children?: unknown;
}> = ({ action, csrfToken, agentId, children }) => (
  <form method="post" action={action} style="display:contents">
    <input type="hidden" name="csrf" value={csrfToken} />
    <input type="hidden" name="id" value={agentId} />
    {children}
  </form>
);

// A rename is a label change: the token, the inbox key and with it the
// unread mail stay put. The consequence line says so, because the obvious
// fear — "will it lose its messages?" — is exactly what used to happen. It
// sits inside the button like every other action here, so it is part of
// what a screen reader announces for the control.
const RENAME_INPUT =
  `width:100%;background:${T.paper};border:1px solid ${T.lineStrong};` +
  `border-radius:${T.radiusControl}px;font-family:${V2_FONT_FAMILY_MONO};font-size:14px;` +
  `padding:10px 12px;outline:none;color:${T.ink}`;

const RenameForm: FC<{ agent: V2AgentsAgent; csrfToken: string }> = ({ agent, csrfToken }) => {
  const inputId = `rename-${agent.id}`;
  return (
    <form
      method="post"
      action="/agents/rename"
      style="display:flex;flex-direction:column;gap:7px;padding-top:4px"
    >
      <input type="hidden" name="csrf" value={csrfToken} />
      <input type="hidden" name="id" value={agent.id} />
      <label for={inputId} style={`font-size:13px;color:${T.faint}`}>Name</label>
      <input
        id={inputId}
        class="d-input"
        name="name"
        value={agent.name}
        required
        maxlength={64}
        pattern={AGENT_NAME_PATTERN}
        title={AGENT_NAME_RULE}
        autocomplete="off"
        spellcheck={false}
        style={RENAME_INPUT}
      />
      <button class="d-outline" type="submit" style={ACTION_SECONDARY}>
        Rename
        <span style={subline(T.faint)}>
          Keeps its token, inbox and history. Other agents reach it under the new name from then on.
        </span>
      </button>
    </form>
  );
};

// ── Aside body pieces ───────────────────────────────────────────

const FACT_VALUE = `font-size:13.5px;color:${T.body}`;

/**
 * A flex row with a fixed-width label, not a 96px/1fr grid: the long mono
 * `Inbox` value wraps correctly in the flex form and overflows in the grid one.
 */
const Fact: FC<{ label: string; valueStyle?: string; children?: unknown }> = ({
  label, valueStyle, children,
}) => (
  <div style="display:flex;gap:12px;padding:7px 0;align-items:baseline">
    <span style={`width:96px;flex-shrink:0;font-size:13px;color:${T.dim}`}>{label}</span>
    <span style={valueStyle ?? FACT_VALUE}>{children}</span>
  </div>
);

const HISTOGRAM_HOURS = 24;
const HISTOGRAM_TRACK_PX = 38;
const HISTOGRAM_TALLEST_PX = 34;

/**
 * One bar per hour, hour 0 first. Value is carried twice — height and opacity —
 * which is what keeps a 24-bar strip readable at 330px wide. An empty hour is a
 * 3px rule, not a gap: 24 flat rules is the "nothing happened" reading, and the
 * 4px of headroom above the tallest bar is deliberate.
 */
const Histogram: FC<{ heat: HourlyHeat }> = ({ heat }) => {
  const hours = Array.from({ length: HISTOGRAM_HOURS }, (_, i) => heat[i] ?? 0);
  const max = Math.max(1, ...hours); // never 0, so no division by zero
  return (
    <div style={`display:flex;gap:3px;align-items:flex-end;height:${HISTOGRAM_TRACK_PX}px`}>
      {hours.map((v, hour) => {
        const height = v === 0 ? 3 : Math.max(4, Math.round((v / max) * HISTOGRAM_TALLEST_PX));
        return (
          <span
            key={hour}
            style={
              `flex:1;height:${height}px;border-radius:3px;` +
              `background:${v === 0 ? T.lineSoft : T.green};` +
              `opacity:${v === 0 ? 1 : (0.35 + (v / max) * 0.65).toFixed(2)}`
            }
          />
        );
      })}
    </div>
  );
};

const CapabilityPills: FC<{ capabilities: string[] }> = ({ capabilities }) => {
  // An empty wrap reads as a rendering bug; one "none yet" pill reads as an answer.
  const pills = capabilities.length > 0 ? capabilities : ["none yet"];
  return (
    <div style="display:flex;gap:6px;flex-wrap:wrap">
      {pills.map((c) => (
        <span
          key={c}
          style={
            `font-family:${V2_FONT_FAMILY_MONO};font-size:12px;padding:3px 10px;` +
            `border-radius:${T.radiusPill}px;background:${T.subtle};color:${T.body}`
          }
        >
          {c}
        </span>
      ))}
    </div>
  );
};

const ActionStack: FC<{ agent: V2AgentsAgent; csrfToken: string }> = ({ agent, csrfToken }) => (
  <div
    style={`padding:18px 22px;border-top:1px solid ${T.lineSoft};display:flex;flex-direction:column;gap:9px`}
  >
    <a
      class="d-solid"
      href={`/conversations?agent=${encodeURIComponent(agent.name)}`}
      style={ACTION_PRIMARY}
    >
      Read its conversations
    </a>
    <RenameForm agent={agent} csrfToken={csrfToken} />
    {agent.is_active ? (
      <>
        <ActionForm action="/agents/reset-token" csrfToken={csrfToken} agentId={agent.id}>
          <button class="d-outline" type="submit" style={ACTION_SECONDARY}>
            Reset token
            <span style={subline(T.faint)}>
              Issues a new bearer token. The agent goes offline until you paste the new one.
            </span>
          </button>
        </ActionForm>
        <ActionForm action="/agents/revoke" csrfToken={csrfToken} agentId={agent.id}>
          <button class="d-outline" type="submit" style={ACTION_DANGER}>
            Deactivate
            {/* `redInk` is the spec's colour here but measures 3.8:1 on white;
                `red` says the same thing at 5.4:1. */}
            <span style={subline(T.red)}>
              Stops delivery and hides it from mesh_status. Reversible, history is kept.
            </span>
          </button>
        </ActionForm>
      </>
    ) : (
      // Secondary, not primary: the green slot in a 330px column already
      // belongs to "Read its conversations", and two greens read as a choice
      // rather than a hierarchy.
      <ActionForm action="/agents/reactivate" csrfToken={csrfToken} agentId={agent.id}>
        <button class="d-outline" type="submit" style={ACTION_SECONDARY}>
          Reactivate
          <span style={subline(T.faint)}>Issues a new token and starts delivering again.</span>
        </button>
      </ActionForm>
    )}
    {/* `.d-delete` owns the transparent fill and the `dim` label so that its
        hover (subtle fill, `ink` label) is not outranked by an inline value. */}
    <button
      class="d-delete"
      data-del-open
      type="button"
      style={
        "border:none;font-family:inherit;font-size:13px;font-weight:400;" +
        `padding:8px 4px;border-radius:${T.radiusControl}px;cursor:pointer;text-align:left`
      }
    >
      Delete agent
    </button>
  </div>
);

// ── Aside ───────────────────────────────────────────────────────

export const DetailAside: FC<{ agent: V2AgentsAgent; csrfToken: string }> = ({
  agent, csrfToken,
}) => (
  <aside style={`flex:1 1 330px;max-width:420px;min-width:300px;${CARD_PANEL}`}>
    <div style={`padding:22px 22px 18px;border-bottom:1px solid ${T.lineSoft}`}>
      <div style="display:flex;gap:13px;align-items:center">
        <V2Avatar name={agent.name} role={agent.role} size={52} bordered />
        <div style="min-width:0">
          {/* The name stays `ink` even when deactivated — the first fact row
              states the token state in words. */}
          <div style="font-size:18px;font-weight:600;letter-spacing:-0.01em">{agent.name}</div>
          <div style="display:flex;align-items:center;gap:7px">
            <V2Dot presence={agent.presence} size={8} />
            <span style={`font-size:13px;color:${T.dim}`}>{presenceSentence(agent)}</span>
          </div>
        </div>
      </div>
      {/* `paper`, the page colour, sunk inside a white panel. */}
      <div
        style={
          `margin-top:14px;padding:11px 13px;background:${T.paper};border-radius:11px;` +
          `font-size:13.5px;color:${agent.working_on ? T.body : T.faint}`
        }
      >
        {agent.working_on || "Nothing announced"}
      </div>
    </div>

    <div style="padding:18px 22px">
      <Fact
        label="Token"
        valueStyle={`font-size:13.5px;font-weight:600;color:${agent.is_active ? T.greenDeep : T.dim}`}
      >
        {agent.is_active ? "Active, hashed" : "Deactivated"}
      </Fact>
      <Fact label="Role">{agent.role ?? "—"}</Fact>
      <Fact label="Last seen">{fmtRel(agent.last_seen_at)}</Fact>
      <Fact label="Registered">{fmtRegistered(agent.created_at)}</Fact>
      <Fact label="Messages">{`${agent.msg24} today`}</Fact>
      <Fact
        label="Inbox"
        valueStyle={`font-family:${V2_FONT_FAMILY_MONO};font-size:12px;color:${T.faint};word-break:break-all`}
      >
        {/* The inbox key, not the name: that is the subject the server binds,
            and it stays the same when the agent is renamed. */}
        {`mesh.agents.${agent.inbox_key}.inbox`}
      </Fact>

      <div style="margin-top:14px">
        <div style={`font-size:13px;color:${T.dim};margin-bottom:7px`}>
          Capabilities it announced
        </div>
        <CapabilityPills capabilities={agent.capabilities} />
      </div>

      <div style="margin-top:18px">
        <div style={`font-size:13px;color:${T.dim};margin-bottom:8px`}>
          Messages per hour, last 24h
        </div>
        <Histogram heat={agent.heat} />
      </div>
    </div>

    <ActionStack agent={agent} csrfToken={csrfToken} />
  </aside>
);

// ── Delete modal ────────────────────────────────────────────────

export const DeleteModal: FC<{ agent: V2AgentsAgent; csrfToken: string }> = ({
  agent, csrfToken,
}) => (
  <div
    id="v2-del-modal"
    role="dialog"
    aria-modal="true"
    aria-label={`Delete ${agent.name}`}
    style="position:fixed;inset:0;z-index:120;display:none;align-items:center;justify-content:center;padding:20px"
  >
    {/* ink at 45% — on a paper ground a heavier scrim reads as a page error. */}
    <div
      data-del-close
      style="position:absolute;inset:0;background:rgba(36,33,29,0.45);backdrop-filter:blur(3px)"
    />
    <div
      style={
        `position:relative;width:420px;max-width:100%;background:${T.card};` +
        `border:1px solid ${T.line};border-radius:${T.radiusPanel}px;padding:24px;` +
        "box-shadow:0 1px 2px rgba(36,33,29,.04),0 16px 40px -28px rgba(36,33,29,.3)"
      }
    >
      <div style="font-size:18px;font-weight:600;letter-spacing:-0.01em;margin-bottom:8px">
        {`Delete ${agent.name}?`}
      </div>
      <div style={`font-size:14px;color:${T.body};line-height:1.6;margin-bottom:20px`}>
        {"The name becomes reusable and the token stops working immediately. " +
          `Message history is kept for ${MESSAGE_RETENTION_DAYS} days. This cannot be undone.`}
      </div>
      <div style="display:flex;justify-content:flex-end;gap:10px;flex-wrap:wrap">
        <button
          class="d-outline"
          data-del-close
          type="button"
          style={`${ACTION_BASE};border:1px solid ${T.lineStrong};color:${T.ink}`}
        >
          Cancel
        </button>
        <ActionForm action="/agents/delete" csrfToken={csrfToken} agentId={agent.id}>
          <button
            class="d-solid"
            type="submit"
            style={`${ACTION_BASE};background:${T.red};border:none;color:${ON_SOLID}`}
          >
            Delete permanently
          </button>
        </ActionForm>
      </div>
    </div>
  </div>
);

// The only client state on this screen. Emitted after the modal markup so the
// lookup resolves without waiting for DOMContentLoaded.
export const AGENTS_SCRIPT = raw(`<script>
(function(){
  var modal = document.getElementById('v2-del-modal');
  if (!modal) return;
  document.addEventListener('click', function(e){
    var t = e.target;
    if (!t || !t.closest) return;
    if (t.closest('[data-del-open]')) { e.preventDefault(); modal.style.display = 'flex'; }
    else if (t.closest('[data-del-close]')) { e.preventDefault(); modal.style.display = 'none'; }
  });
  document.addEventListener('keydown', function(e){
    if (e.key === 'Escape' && modal.style.display !== 'none') { modal.style.display = 'none'; }
  });
})();
</script>`);
