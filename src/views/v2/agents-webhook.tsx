// The webhook section of the agent aside: how the hook is doing, and the
// admin's form to set or remove it. Agents set their own with
// mesh_webhook_set; this is the operator's way to do it for any of them.
//
// The URL is shown here (the page is admin only) and nowhere else on the
// dashboard. The secret is never shown, except once, right after moshi
// generated it.

import type { FC } from "hono/jsx";
import { MESSAGE_PRIORITIES } from "../../types.js";
import { AUTH_MODES, INTERVAL_SECONDS } from "../../services/webhooks.js";
import type { WebhookView } from "../../services/webhooks.js";
import { MAX_URL_LENGTH } from "../../services/webhook-target.js";
import { V2_FONT_FAMILY_MONO, V2_TOKENS } from "./tokens.js";
import { ACTION_SECONDARY, ACTION_DANGER, Fact, RENAME_INPUT, fmtRel, subline } from "./agents-detail.js";
import type { V2AgentsAgent } from "./agents-detail.js";

const T = V2_TOKENS;

const STATE_WORDS: Record<WebhookView["state"], string> = {
  active: "On",
  failing: "On, the last attempt failed",
  disabled: "Switched off after repeated failures",
};

const LABEL = `font-size:13px;color:${T.faint}`;
const FIELD = "display:flex;flex-direction:column;gap:5px";
const MONO_VALUE = `font-family:${V2_FONT_FAMILY_MONO};font-size:12px;color:${T.body};word-break:break-all`;

function formatInterval(seconds: number): string {
  if (seconds % 60 !== 0) return `${seconds} s`;
  const minutes = seconds / 60;
  return minutes === 1 ? "minute" : `${minutes} minutes`;
}

const Status: FC<{ hook: WebhookView }> = ({ hook }) => (
  <>
    <Fact
      label="State"
      valueStyle={`font-size:13.5px;font-weight:600;color:${hook.state === "active" ? T.greenDeep : hook.state === "failing" ? T.dim : T.red}`}
    >
      {STATE_WORDS[hook.state]}
    </Fact>
    <Fact label="URL" valueStyle={MONO_VALUE}>{hook.url}</Fact>
    <Fact label="Calls">{hook.kind === "claude_routine" ? "Claude Code routine (new session per call)" : "Webhook"}</Fact>
    <Fact label="Signed">{hook.auth_mode === "bearer" ? "Bearer key" : "Standard Webhooks"}</Fact>
    <Fact label="At most">{`once every ${formatInterval(hook.min_interval_seconds)}`}</Fact>
    <Fact label="For">
      {[
        hook.include_broadcasts ? "direct and broadcast" : "direct messages",
        hook.types ? `types ${hook.types.join(", ")}` : null,
        hook.min_priority !== "low" ? `${hook.min_priority} priority and up` : null,
      ].filter(Boolean).join("; ")}
    </Fact>
    <Fact label="Last call">{hook.last_success_at ? `succeeded ${fmtRel(hook.last_success_at)}` : "none succeeded yet"}</Fact>
    {hook.last_failure_at && (
      <Fact label="Last failure">{`${fmtRel(hook.last_failure_at)}: ${hook.last_error ?? "unknown"}`}</Fact>
    )}
    {hook.pending && (
      <Fact label="Waiting">
        {`${hook.pending.messages} message${hook.pending.messages === 1 ? "" : "s"}` +
          (hook.pending.attempts > 0 ? `, attempt ${hook.pending.attempts} failed, next try soon` : ", call within 30 s")}
      </Fact>
    )}
  </>
);

const NewSecret: FC<{ secret: string }> = ({ secret }) => (
  <div style={`margin:6px 0 10px;padding:11px 13px;background:${T.paper};border-radius:11px`}>
    <div style={`font-size:13px;color:${T.dim};margin-bottom:6px`}>
      Signing secret, shown this once. Give it to the receiver now.
    </div>
    <code style={MONO_VALUE}>{secret}</code>
  </div>
);

export const WebhookPanel: FC<{ agent: V2AgentsAgent; csrfToken: string; newSecret?: string }> = ({
  agent, csrfToken, newSecret,
}) => {
  const hook = agent.webhook ?? null;
  const id = (name: string) => `webhook-${name}-${agent.id}`;
  return (
    <div style={`padding:18px 22px;border-top:1px solid ${T.lineSoft}`}>
      <div style={`font-size:13px;color:${T.dim};margin-bottom:6px`}>Webhook</div>
      {newSecret && <NewSecret secret={newSecret} />}
      {hook ? (
        <Status hook={hook} />
      ) : (
        <div style={`font-size:13.5px;color:${T.faint};padding:4px 0 8px`}>
          None. It learns about mail by calling mesh_receive.
        </div>
      )}

      <form method="post" action="/agents/webhook" style="display:flex;flex-direction:column;gap:10px;padding-top:10px">
        <input type="hidden" name="csrf" value={csrfToken} />
        <input type="hidden" name="id" value={agent.id} />
        <div style={FIELD}>
          <label for={id("url")} style={LABEL}>URL (https, port 443)</label>
          <input
            id={id("url")} class="d-input" name="url" type="url" required maxlength={MAX_URL_LENGTH}
            value={hook?.url ?? ""} placeholder="https://…" autocomplete="off" spellcheck={false} style={RENAME_INPUT}
          />
        </div>
        <div style={FIELD}>
          <label for={id("secret")} style={LABEL}>Key from the receiver, as shown (empty: moshi makes one)</label>
          <input id={id("secret")} class="d-input" name="secret" type="password" maxlength={600} autocomplete="off" style={RENAME_INPUT} />
        </div>
        <div style={FIELD}>
          <label for={id("auth")} style={LABEL}>Kind of key</label>
          <select id={id("auth")} name="auth_mode" style={RENAME_INPUT}>
            {/* Automatic is right for every receiver that shows one key: a whsec_ secret signs, anything else is a bearer key. */}
            <option value="" selected>Automatic, by the key</option>
            {AUTH_MODES.map((m) => (
              <option value={m}>{m === "bearer" ? "Bearer key" : "Signing secret (whsec_)"}</option>
            ))}
          </select>
        </div>
        <div style={FIELD}>
          <label for={id("types")} style={LABEL}>Only these types (comma separated, empty: all)</label>
          <input
            id={id("types")} class="d-input" name="types" value={hook?.types?.join(", ") ?? ""}
            autocomplete="off" spellcheck={false} style={RENAME_INPUT}
          />
        </div>
        <div style={FIELD}>
          <label for={id("priority")} style={LABEL}>From priority</label>
          <select id={id("priority")} name="min_priority" style={RENAME_INPUT}>
            {MESSAGE_PRIORITIES.map((p) => (
              <option value={p} selected={(hook?.min_priority ?? "low") === p}>{p}</option>
            ))}
          </select>
        </div>
        <div style={FIELD}>
          <label for={id("interval")} style={LABEL}>
            {`At most every … seconds (empty: ${INTERVAL_SECONDS.webhook.default} for a webhook, ${INTERVAL_SECONDS.claude_routine.default} for a Claude Code routine)`}
          </label>
          <input
            id={id("interval")} class="d-input" name="min_interval_seconds" type="number" inputmode="numeric"
            min={INTERVAL_SECONDS.webhook.min} max={INTERVAL_SECONDS.max} step={1}
            value={hook && hook.min_interval_seconds !== INTERVAL_SECONDS[hook.kind].default ? String(hook.min_interval_seconds) : ""}
            style={RENAME_INPUT}
          />
        </div>
        <label style={`font-size:13.5px;color:${T.body};display:flex;gap:8px;align-items:center`}>
          <input type="checkbox" name="include_broadcasts" value="1" checked={hook?.include_broadcasts ?? false} />
          Also for broadcasts
        </label>
        <button class="d-outline" type="submit" style={ACTION_SECONDARY}>
          {hook ? "Replace webhook" : "Set webhook"}
          <span style={subline(T.faint)}>
            At most one call per 30 s, ids and senders only. Switches a hook that was off back on.
          </span>
        </button>
      </form>

      {hook && (
        <form method="post" action="/agents/webhook/delete" style="display:flex;padding-top:9px">
          <input type="hidden" name="csrf" value={csrfToken} />
          <input type="hidden" name="id" value={agent.id} />
          <button class="d-outline" type="submit" style={ACTION_DANGER}>
            Remove webhook
            <span style={subline(T.red)}>No more calls. Its mail stays in its inbox.</span>
          </button>
        </form>
      )}
    </div>
  );
};
