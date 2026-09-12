// Connect step 4 — Verify: the handshake watch, the hello round trip, the
// seven tools and the six limits.
//
// Split out of connect.tsx for size. The tool list comes from
// src/mcp/catalog.ts and every limit is formatted from the constant in
// src/types.ts, so neither can drift from what the server enforces.

import type { FC } from "hono/jsx";
import { raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import { MCP_TOOL_CATALOG } from "../../mcp/catalog.js";
import {
  MAX_AGENTS,
  MAX_CONTEXT_LENGTH,
  MAX_PAYLOAD_BYTES,
  MESSAGE_RETENTION_DAYS,
  PRESENCE_TTL_SECONDS,
  RATE_LIMIT_PER_MINUTE,
} from "../../types.js";
import { connectClient, helloCommand, type ConnectClientKey } from "./connect-clients.js";
import {
  ACTION_ROW, CARD, CommandBlock, GhostLink, M, MONO, ON_GREEN, PrimaryLink,
  T, jsonForScript, stepHref,
} from "./connect-parts.js";

/** 2 048, 256 KB, 10 min … — formatted from the constants, never typed. */
function groupThousands(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

const LIMIT_ROWS: ReadonlyArray<readonly [string, string]> = [
  [`${MAX_PAYLOAD_BYTES / 1024} KB`, "largest payload per message"],
  [groupThousands(MAX_CONTEXT_LENGTH), "characters of context per message"],
  [`${RATE_LIMIT_PER_MINUTE}/min`, "messages per agent, token bucket"],
  [`${PRESENCE_TTL_SECONDS / 60} min`, "presence TTL, refreshed on every call"],
  [`${MESSAGE_RETENTION_DAYS} days`, "message history in SQLite"],
  [String(MAX_AGENTS), "agents per deployment"],
];

/** Waiting look. The poll swaps the background to amber (seen) or green
 *  (registered), paints the glyph white and drops the pulse class.
 *  `ink` on the grey fill, not white: white on presenceOffline is 1.86:1. */
const VERIFY_ICON =
  `width:44px;height:44px;border-radius:${T.radiusInner}px;flex-shrink:0;display:flex;` +
  `align-items:center;justify-content:center;font-size:18px;font-weight:600;color:${T.ink};` +
  `background:${T.presenceOffline}`;

export const StepVerify: FC<{
  agentName: string;
  origin: string;
  token: string;
  s?: string;
  client: ConnectClientKey;
}> = ({ agentName, origin, token, s, client }) => {
  const gotcha = connectClient(client, origin, token).gotcha;
  return (
    <section class="m-rise" style="max-width:860px">
      <div style={`${CARD};padding:26px`}>
        <div style="display:flex;gap:16px;align-items:flex-start;flex-wrap:wrap">
          <div id="c-verify-icon" class="m-pulse" aria-hidden="true" style={VERIFY_ICON}>···</div>
          <div style="flex:1 1 300px;min-width:0" aria-live="polite">
            <h2 id="c-verify-title" style="margin:0 0 6px;font-size:19px;font-weight:600">
              Waiting for {agentName} to say hello
            </h2>
            <p id="c-verify-body" style={`margin:0;font-size:14.5px;color:${T.body}`}>
              Start or restart your client. The moment it makes its first MCP call we'll see it
              here — usually within a few seconds.
            </p>
            {/* Rendered up front and unhidden by the poll when it gives up,
                so the client's gotcha is never assembled in JavaScript. */}
            <p id="c-verify-timeout" hidden style={`margin:8px 0 0;font-size:14.5px;color:${T.body}`}>
              Still nothing after two minutes. {gotcha}
            </p>
          </div>
        </div>

        <div
          style={`margin-top:22px;padding:18px;background:${T.paper};border:1px solid ${T.lineSoft};` +
            `border-radius:${T.radiusInner}px`}
        >
          <div style="font-size:14px;font-weight:600;margin-bottom:8px">Say hello from your side</div>
          <div style={`font-size:13.5px;color:${T.body};margin-bottom:12px`}>
            Install the moshi binary and ping the new agent — a round trip proves both directions
            work.
          </div>
          <CommandBlock code={helloCommand(origin, token, agentName)} />
        </div>

        <div style="margin-top:26px">
          <h3 style="margin:0 0 4px;font-size:16px;font-weight:600">What {agentName} can do now</h3>
          <p style={`margin:0 0 14px;font-size:14px;color:${T.dim}`}>
            Seven tools arrive with the MCP connection. Every reply also carries{" "}
            <M size={12.5}>inbox_pending</M>, so the agent only fetches when something is waiting.
          </p>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(320px,100%),1fr));gap:10px">
            {MCP_TOOL_CATALOG.map((tool) => (
              <div
                key={tool.name}
                style={`border:1px solid ${T.line};border-radius:${T.radiusCode}px;` +
                  `padding:13px 15px;background:${T.card}`}
              >
                <div
                  style={`font-family:${MONO};font-size:13px;font-weight:600;` +
                    `color:${T.greenDeep};margin-bottom:3px`}
                >{tool.name}</div>
                <div style={`font-size:13.5px;color:${T.body};margin-bottom:6px`}>{tool.desc}</div>
                <div
                  style={`font-family:${MONO};font-size:11.5px;color:${T.faint};word-break:break-word`}
                >{tool.signature}</div>
              </div>
            ))}
          </div>
        </div>

        <div style={`margin-top:26px;padding-top:20px;border-top:1px solid ${T.lineSoft}`}>
          <h3 style="margin:0 0 10px;font-size:16px;font-weight:600">
            Worth knowing before you rely on it
          </h3>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(220px,100%),1fr));gap:12px">
            {LIMIT_ROWS.map(([value, label]) => (
              <div key={label} style="display:flex;gap:9px;align-items:flex-start">
                <span
                  style={`font-family:${MONO};font-size:13px;font-weight:600;color:${T.ink};flex-shrink:0`}
                >{value}</span>
                <span style={`font-size:13.5px;color:${T.body}`}>{label}</span>
              </div>
            ))}
          </div>
        </div>

        <div style="display:flex;gap:10px;margin-top:26px;justify-content:flex-end">
          <GhostLink href={stepHref(3, s, client)}>Back</GhostLink>
          <PrimaryLink href="/agents">Done — show me the agents</PrimaryLink>
        </div>
      </div>
      {s && pollScript(s, agentName)}
    </section>
  );
};

// Poll, don't stream: one handshake per connect run does not justify an
// SSE connection, and a dropped poll costs two seconds.
function pollScript(sessionKey: string, agentName: string): HtmlEscapedString {
  const cfg = {
    url: `/agents/connect/handshake?s=${encodeURIComponent(sessionKey)}`,
    everyMs: 2000,
    giveUpMs: 120_000,
    seenTitle: `${agentName} is in the mesh`,
    registeredBody:
      "It called mesh_register {N} seconds ago and announced its role. " +
      "It shows up in mesh_status for every other agent now.",
    unregisteredBody:
      `${agentName} authenticated, but hasn't called mesh_register yet — so nobody knows what ` +
      "it does. It'll announce its role on its next call.",
    green: T.green,
    amber: T.amber,
    onGreen: ON_GREEN,
  };
  return raw(`<script>
(function(){
  var cfg = ${jsonForScript(cfg)};
  var icon = document.getElementById('c-verify-icon');
  var title = document.getElementById('c-verify-title');
  var body = document.getElementById('c-verify-body');
  var timeout = document.getElementById('c-verify-timeout');
  if (!icon || !title || !body) return;
  var started = Date.now();
  var timer = null;

  function stop(){ if (timer) { clearInterval(timer); timer = null; } }

  function arrived(data){
    stop();
    icon.classList.remove('m-pulse');
    icon.textContent = data.registered ? '✓' : '···';
    icon.style.background = data.registered ? cfg.green : cfg.amber;
    icon.style.color = cfg.onGreen;
    title.textContent = cfg.seenTitle;
    if (data.registered) {
      var ms = data.last_seen_at ? (Date.now() - Date.parse(data.last_seen_at)) : 0;
      body.textContent = cfg.registeredBody.replace('{N}', String(Math.max(1, Math.round(ms / 1000))));
    } else {
      body.textContent = cfg.unregisteredBody;
    }
    if (timeout) timeout.hidden = true;
  }

  function tick(){
    if (Date.now() - started > cfg.giveUpMs) {
      stop();
      if (timeout) timeout.hidden = false;   // the waiting state stays put
      return;
    }
    fetch(cfg.url, { headers: { 'Accept': 'application/json' } })
      .then(function(r){
        if (r.status === 410 || r.status === 404) { stop(); return null; }
        return r.ok ? r.json() : null;
      })
      .then(function(data){ if (data && data.seen) arrived(data); })
      .catch(function(){ /* transient — the next tick tries again */ });
  }

  tick();
  timer = setInterval(tick, cfg.everyMs);
})();
</script>`);
}
