// Connect an agent — the four-step guided flow at /agents/connect.
//
// Replaces the old token panel that appeared above the agents table: name
// it, copy the token once, paste it into your client, wait for the first
// handshake. `step` and `client` live in the URL so reload and the back
// button work; the copied-the-token gate and the handshake state are
// ephemeral and belong to the small scripts in this file and in
// connect-verify.tsx.
//
// Strings are COPY.md §5 verbatim. Client snippets live in
// ./connect-clients.ts, step 4 in ./connect-verify.tsx, and the styles the
// steps share in ./connect-parts.tsx.

import { InlineScript, NonceContext } from "../nonce.js";
import type { FC } from "hono/jsx";
import { raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import { V2Layout } from "./layout.js";
import { V2Avatar } from "./components.js";
import { AGENT_NAME_PATTERN, AGENT_NAME_RULE } from "../../services/agent.js";
import {
  CONNECT_CLIENT_LABELS,
  CONNECT_CLIENT_ORDER,
  PLACEHOLDER_AGENT_NAME,
  connectClient,
  type ConnectBlock,
  type ConnectClientKey,
} from "./connect-clients.js";
import { StepVerify } from "./connect-verify.js";
import {
  ACTION_ROW, CARD, CommandBlock, CopyBtn, COPY_LIGHT, GhostLink, M, MONO, ON_GREEN,
  PRIMARY_BTN, PrimaryLink, T, jsonForScript, stepHref, type ConnectStep,
} from "./connect-parts.js";

/** The active stepper card's tint. No token: it exists only here. */
const STEP_ACTIVE_FILL = "#f1faf3";
/** A muted green that still reads on greenSoft. greenDeep is too loud. */
const BAND_NOTE_INK = "#38774d";

export type { ConnectStep };

export interface V2ConnectProps {
  step: ConnectStep;
  client: ConnectClientKey;
  /** Public origin of this deployment — every snippet is built from it. */
  origin: string;
  csrfToken: string;
  userRole?: string;
  userName?: string;
  /** `?s=` — present once the agent exists and its session still resolves. */
  sessionKey?: string;
  agentName?: string;
  /** Drives the emblem's role stripe; null for a freshly created agent. */
  agentRole?: string | null;
  token?: string;
  /** What the operator typed, kept across a failed step-1 submit. */
  typedName?: string;
  error?: string;
}

/** COPY.md §1 — also the input's `title`, so the browser's own validation
 *  bubble says what the server would say. */
export const NAME_RULE_MESSAGE = AGENT_NAME_RULE;

// ── Stepper ─────────────────────────────────────────────────────
const STEP_DEFS: ReadonlyArray<readonly [ConnectStep, string, string]> = [
  [1, "Name it", "what others call it"],
  [2, "Copy the token", "shown once"],
  [3, "Paste it in your client", "pick one of four"],
  [4, "Verify", "wait for the handshake"],
];

const Stepper: FC<{ current: ConnectStep; s?: string; client: ConnectClientKey }> = ({
  current, s, client,
}) => (
  <div style="display:flex;gap:0;margin-bottom:28px;flex-wrap:wrap">
    {STEP_DEFS.map(([n, title, sub]) => {
      const active = current === n;
      const done = current > n;
      // Steps past 1 only exist once the agent does, which is exactly what
      // a resolvable `?s=` tells us. Everything else is inert, not a link.
      const reachable = n === 1 || !!s;
      const card =
        "display:flex;gap:11px;align-items:center;padding:13px 16px;" +
        `border:1px solid ${active ? T.greenLine : T.line};` +
        `background:${active ? STEP_ACTIVE_FILL : T.card};` +
        "flex:1 1 190px;border-radius:12px;margin-right:8px;margin-bottom:8px;" +
        `color:${T.ink};cursor:${reachable ? "pointer" : "default"}`;
      // Both greys are `faint`, not `dim`: the sub-line and the digit are
      // 12.5px, and dim measures 4.21:1 on the active card's tint and
      // 3.95:1 on the pending digit's `subtle` ground.
      const numStyle =
        "width:24px;height:24px;border-radius:8px;flex-shrink:0;display:flex;align-items:center;" +
        "justify-content:center;font-size:12.5px;font-weight:600;" +
        `background:${done || active ? T.green : T.subtle};color:${done || active ? ON_GREEN : T.faint}`;
      const inner = (
        <>
          <span style={numStyle}>{done ? "✓" : String(n)}</span>
          <span style="text-align:left">
            <span style="display:block;font-size:13.5px;font-weight:600">{title}</span>
            <span style={`display:block;font-size:12.5px;color:${T.faint}`}>{sub}</span>
          </span>
        </>
      );
      return reachable ? (
        <a
          key={String(n)}
          class={active ? undefined : "d-row"}
          href={stepHref(n, s, client)}
          aria-current={active ? "step" : undefined}
          style={card}
        >
          {inner}
        </a>
      ) : (
        <div key={String(n)} style={card}>{inner}</div>
      );
    })}
  </div>
);

// ── Step 1 — Name it ────────────────────────────────────────────
const NAME_PATTERN = AGENT_NAME_PATTERN;

const StepName: FC<{ csrfToken: string; typedName?: string; error?: string }> = ({
  csrfToken, typedName, error,
}) => (
  <section class="m-rise" style={`${CARD};padding:26px;max-width:620px`}>
    <h2 style="margin:0 0 6px;font-size:19px;font-weight:600">What should we call it?</h2>
    <p style={`margin:0 0 20px;font-size:14.5px;color:${T.body}`}>
      The name is how other agents address it in <M size={13} ground>mesh_send</M>. Pick something
      short you'd type by hand.
    </p>
    <form method="post" action="/agents/connect/create">
      <input type="hidden" name="csrf" value={csrfToken} />
      <label for="connect-name" style="display:block;font-size:13px;font-weight:600;margin-bottom:7px">
        Agent name
      </label>
      <input
        id="connect-name"
        class="d-input"
        name="name"
        value={typedName ?? ""}
        placeholder="dex-eu"
        autofocus
        required
        pattern={NAME_PATTERN}
        title={NAME_RULE_MESSAGE}
        autocomplete="off"
        spellcheck={false}
        style={`width:100%;background:${T.paper};border:1px solid ${T.lineStrong};` +
          `border-radius:${T.radiusControl}px;font-family:${MONO};font-size:15px;` +
          `padding:13px 15px;outline:none;color:${T.ink}`}
      />
      <div style={`font-size:13px;color:${T.dim};margin-top:8px`}>
        1–64 characters · letters, digits, <M>-</M> and <M>_</M> · must start with a letter or
        digit. No spaces or dots.
      </div>
      {error && (
        <div
          style={"margin-top:8px;display:flex;align-items:center;gap:7px;font-size:13px;" +
            `font-weight:600;color:${T.red}`}
        >
          <span style={`width:6px;height:6px;border-radius:50%;background:${T.red};flex-shrink:0`} />
          <span>{error}</span>
        </div>
      )}
      <div
        style={`margin-top:20px;padding:16px;background:${T.paper};border-radius:${T.radiusCode}px;` +
          `border:1px solid ${T.lineSoft}`}
      >
        <div style="font-size:13.5px;font-weight:600;margin-bottom:6px">
          Role and capabilities come later — automatically
        </div>
        <div style={`font-size:13.5px;color:${T.body}`}>
          The agent announces those itself with <M size={12.5}>mesh_register</M> on its first
          connection. Nothing for you to fill in here.
        </div>
      </div>
      <div style={ACTION_ROW}>
        <GhostLink href="/agents">Cancel</GhostLink>
        <button class="d-solid" type="submit" style={PRIMARY_BTN}>Create token →</button>
      </div>
    </form>
  </section>
);

// ── The token is gone (steps 2-4 without a live session) ────────
const ExpiredBand: FC<{ agentName?: string }> = ({ agentName }) => (
  <div
    style={`background:${T.redSoft};border:1px solid ${T.redLine};border-radius:${T.radiusBox}px;` +
      "padding:18px 20px;display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap"}
  >
    <span
      style={`width:26px;height:26px;border-radius:${T.radiusAvatar}px;background:${T.red};` +
        `color:${ON_GREEN};flex-shrink:0;display:flex;align-items:center;justify-content:center;` +
        "font-size:15px;font-weight:600"}
    >!</span>
    <div style="flex:1 1 260px;min-width:0">
      <div style="font-size:15px;font-weight:600;margin-bottom:4px">The token is gone</div>
      <div style={`font-size:14px;color:${T.body}`}>
        This token was created more than 15 minutes ago and is no longer on screen. Open{" "}
        {agentName ?? "the agent"} in <a href="/agents" style="font-weight:600">Agents</a> and reset
        its token to get a fresh one.
      </div>
    </div>
  </div>
);

/** Steps 2-4 all need the token; without it the only honest page is this
 *  one. The name is gone with the session, hence the `agentName?`. */
const StepExpired: FC<{ agentName?: string }> = ({ agentName }) => (
  <section class="m-rise" style="max-width:720px">
    <div style={`${CARD};padding:26px`}>
      <ExpiredBand agentName={agentName} />
      <div style={ACTION_ROW}>
        <PrimaryLink href="/agents">Done — show me the agents</PrimaryLink>
      </div>
    </div>
  </section>
);

// ── Step 2 — Copy the token ─────────────────────────────────────
const StepToken: FC<{
  agentName: string;
  agentRole?: string | null;
  token: string;
  s?: string;
  client: ConnectClientKey;
}> = ({ agentName, agentRole, token, s, client }) => (
  <section class="m-rise" style="max-width:720px">
    <div style={`${CARD};padding:26px`}>
      <div style="display:flex;gap:12px;align-items:center;margin-bottom:18px">
        <V2Avatar name={agentName} role={agentRole} size={44} bordered />
        <div>
          <h2 style="margin:0;font-size:19px;font-weight:600">{agentName} is registered</h2>
          <div style={`font-size:13.5px;color:${T.dim}`}>
            We gave it a mark and a role colour. You can change both later.
          </div>
        </div>
      </div>

      <div
        style={`background:${T.greenSoft};border:1px solid ${T.greenLine};` +
          `border-radius:${T.radiusInner}px;padding:18px`}
      >
        <div style="display:flex;align-items:center;gap:9px;margin-bottom:10px;flex-wrap:wrap">
          <span style={`font-size:14px;font-weight:600;color:${T.greenDeep}`}>
            Copy this token now
          </span>
          <span style={`font-size:12.5px;color:${BAND_NOTE_INK}`}>
            It is stored as a SHA-256 hash — we can never show it again.
          </span>
        </div>
        <div style="display:flex;gap:10px;align-items:stretch;flex-wrap:wrap">
          <code
            style={`flex:1 1 320px;min-width:0;font-family:${MONO};font-size:14px;` +
              `background:${T.card};border:1px solid ${T.greenLine};` +
              `border-radius:${T.radiusControl}px;padding:13px 15px;color:${T.greenDeep};` +
              "word-break:break-all"}
          >{token}</code>
          <CopyBtn label="Copy token" style={COPY_LIGHT} gate="token" />
        </div>
      </div>

      <div style={`margin-top:18px;font-size:14px;color:${T.body}`}>
        Lost it later? Open the agent in{" "}
        <a href="/agents" style="cursor:pointer;font-weight:600">Agents</a> and reset the token —
        the old one stops working immediately.
      </div>

      {/* The trust model, where the token is handed over: this is the one
          moment somebody decides what to give it access to. Stated plainly,
          without a warning sign — it is the design, not a risk notice. */}
      <div style={`margin-top:12px;font-size:14px;color:${T.body}`}>
        This token reads the whole mesh: every message, every thread, every
        audit entry, whoever sent it. One mesh, no hidden channels. Keep
        secrets out of payloads.
      </div>

      <div style={ACTION_ROW}>
        <GhostLink href={stepHref(1, s, client)}>Back</GhostLink>
        {/* Inert-looking, still legible: dim on the `line` fill is
            3.42:1, so the label takes `body` (7.24:1). */}
        <button
          type="button"
          id="c-step2-next"
          data-next-href={stepHref(3, s, client)}
          style={`background:${T.line};border:none;color:${T.body};font-size:15px;font-weight:600;` +
            `padding:12px 22px;border-radius:${T.radiusControl}px;cursor:pointer`}
        >
          Copy it first
        </button>
      </div>
    </div>
    <InlineScript code={GATE_JS} />
  </section>
);

// The gate is permanent for the session: the copy button's own label
// reverts after 1600 ms, this one does not. Styled inert rather than
// `disabled`, so it keeps its place in the tab order and can say why.
const GATE_JS = `
(function(){
  var btn = document.getElementById('c-step2-next');
  if (!btn) return;
  var open = false;
  btn.addEventListener('click', function(){
    if (!open) {
      var copy = document.querySelector('.d-copy[data-copy-gate="token"]');
      if (copy) copy.focus();
      return;
    }
    window.location.href = btn.getAttribute('data-next-href');
  });
  document.addEventListener('d-copied', function(e){
    if (!e.detail || e.detail.gate !== 'token' || open) return;
    open = true;
    btn.textContent = 'Saved it — next →';
    btn.style.background = ${jsonForScript(T.green)};
    btn.style.color = ${jsonForScript(ON_GREEN)};
    btn.className = 'd-solid';
  });
})();
`;

// ── Step 3 — Paste it in your client ────────────────────────────
const BlockHeader: FC<{ index: number; block: ConnectBlock }> = ({ index, block }) => (
  <div style="display:flex;align-items:baseline;gap:10px;margin-bottom:7px;flex-wrap:wrap">
    <span
      style={`width:20px;height:20px;border-radius:7px;background:${T.subtle};color:${T.faint};` +
        "display:inline-flex;align-items:center;justify-content:center;font-size:11.5px;" +
        "font-weight:600;flex-shrink:0"}
    >{String(index + 1)}</span>
    <span style="font-size:14px;font-weight:600">{block.label}</span>
    <span style={`font-size:13px;color:${T.dim}`}>{block.note}</span>
  </div>
);

const StepClient: FC<{
  agentName: string;
  origin: string;
  token: string;
  s?: string;
  client: ConnectClientKey;
}> = ({ agentName, origin, token, s, client }) => {
  const active = connectClient(client, origin, token);
  return (
    <section class="m-rise">
      <div style={`${CARD};overflow:hidden;max-width:860px`}>
        <div style="padding:24px 26px 0">
          <h2 style="margin:0 0 6px;font-size:19px;font-weight:600">Where does this agent live?</h2>
          <p style={`margin:0 0 18px;font-size:14.5px;color:${T.body}`}>
            Pick your client. Everything below is filled in with {agentName}'s real token, ready to
            paste.
          </p>
          <div style={`display:flex;gap:6px;flex-wrap:wrap;border-bottom:1px solid ${T.lineSoft}`}>
            {CONNECT_CLIENT_ORDER.map((key) => {
              const on = key === client;
              return (
                <a
                  key={key}
                  class={on ? undefined : "d-tab"}
                  href={stepHref(3, s, key)}
                  aria-current={on ? "true" : undefined}
                  style={`font-size:14px;font-weight:${on ? 600 : 400};padding:11px 15px;` +
                    "cursor:pointer;background:transparent;border:none;" +
                    `border-bottom:2px solid ${on ? T.green : "transparent"};` +
                    `color:${on ? T.ink : T.dim}`}
                >
                  {CONNECT_CLIENT_LABELS[key]}
                </a>
              );
            })}
          </div>
        </div>
        <div style="padding:22px 26px 26px">
          <div style={`font-size:14.5px;color:${T.body};margin-bottom:18px;max-width:70ch`}>
            {active.intro}
          </div>
          <div style="display:flex;flex-direction:column;gap:18px">
            {active.blocks.map((block, i) => (
              <div key={block.label}>
                <BlockHeader index={i} block={block} />
                <CommandBlock code={block.code} />
              </div>
            ))}
          </div>
          <div
            style={`margin-top:22px;padding:16px 18px;background:${T.paper};` +
              `border:1px solid ${T.lineSoft};border-radius:${T.radiusCode}px`}
          >
            <div style="font-size:13.5px;font-weight:600;margin-bottom:5px">{active.gotchaTitle}</div>
            <div style={`font-size:13.5px;color:${T.body}`}>{active.gotcha}</div>
          </div>
          <div style={ACTION_ROW}>
            <GhostLink href={stepHref(2, s, client)}>Back</GhostLink>
            <PrimaryLink href={stepHref(4, s, client)}>I've pasted it →</PrimaryLink>
          </div>
        </div>
      </div>
    </section>
  );
};

// ── Page ────────────────────────────────────────────────────────
export const V2ConnectPage: FC<V2ConnectProps> = ({
  step, client, origin, csrfToken, userRole, userName,
  sessionKey, agentName, agentRole, token, typedName, error,
}) => {
  const name = agentName ?? PLACEHOLDER_AGENT_NAME;
  return (
    <V2Layout
      title="Connect an agent"
      active="AGENTS"
      userRole={userRole}
      userName={userName}
      csrfToken={csrfToken}
      narrow
    >
      <div style="margin-bottom:26px">
        {/* The global `a { color: green-text }` rule has to be overridden
            here — with `faint`, since `dim` is only 4.20:1 on paper. */}
        <a href="/agents" style={`font-size:13.5px;color:${T.faint};cursor:pointer`}>← Agents</a>
        <h1 style="margin:8px 0 8px;font-size:clamp(26px,3vw,32px);font-weight:600;letter-spacing:-0.025em">
          Connect an agent
        </h1>
        <p style={`margin:0;font-size:16px;color:${T.body};max-width:62ch`}>
          Four steps, one screen. You can leave and come back — the token stays valid until you
          reset it.
        </p>
      </div>

      <Stepper current={step} s={sessionKey} client={client} />

      {step === 1 && <StepName csrfToken={csrfToken} typedName={typedName} error={error} />}
      {/* Steps 2-4 are unusable without the token, and the agent's name is
          gone with it — so they say that, rather than rendering a card
          about a placeholder agent nobody registered. */}
      {step > 1 && !token && <StepExpired agentName={agentName} />}
      {step === 2 && token && (
        <StepToken
          agentName={name}
          agentRole={agentRole}
          token={token}
          s={sessionKey}
          client={client}
        />
      )}
      {step === 3 && token && (
        <StepClient agentName={name} origin={origin} token={token} s={sessionKey} client={client} />
      )}
      {step === 4 && token && (
        <StepVerify agentName={name} origin={origin} token={token} s={sessionKey} client={client} />
      )}
    </V2Layout>
  );
};

/** Route-side entry point: `agent-connect.ts` is plain TypeScript, so the
 *  JSX call site lives here. */
export function renderConnectPage(
  props: V2ConnectProps,
  nonce = "",
): HtmlEscapedString | Promise<HtmlEscapedString> {
  // The route is plain TypeScript, so the nonce of its response is put in
  // reach of the page's scripts here.
  return (
    <NonceContext.Provider value={nonce}>
      <V2ConnectPage {...props} />
    </NonceContext.Provider>
  );
}
