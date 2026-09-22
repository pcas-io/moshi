import type { FC } from "hono/jsx";
import { raw } from "hono/html";
import {
  V2_TOKENS,
  V2_FONT_FAMILY_SANS,
  V2_FONT_FAMILY_MONO,
} from "./v2/tokens.js";
import type { HealthResult } from "../services/health.js";
import { FONT_FACE_CSS } from "./fonts.js";

const T = V2_TOKENS;

export interface LoginProps {
  /** True after a rejected POST /login — renders the inline error. */
  error?: boolean;
  /** The form was not accepted, the token was never looked at: the page was
   *  older than ten minutes, or another tab used up its pre-session cookie. */
  expired?: boolean;
  /** The session cookie is `Secure` and this request came over plain http: a
   *  browser will not keep it, and every sign-in ends on "expired". */
  cookieWillBeDropped?: boolean;
  csrfToken: string;
  /** Relative path to return to after login (validated by the route). */
  next?: string;
  /**
   * Backend health from `checkHealth`. Drives the footer sentence only. When
   * absent the footer states the healthy phrase, so the route may skip the
   * ping on a page nobody is signed in to yet.
   */
  health?: HealthResult | null;
  /**
   * Public host agents connect to. Defaults to the same value `requestOrigin`
   * falls back to, so a self-hosted deployment can pass its own instead of
   * reading someone else's domain off the sign-in page.
   */
  host?: string;
}

/** Matches the fallback in `requestOrigin` (services/cli-dist.ts). */
export const DEFAULT_LOGIN_HOST = "moshi.enki.run";

export const HEALTHY_STATUS_PHRASE = "All systems normal";

/**
 * The footer sentence. Degradation is named in the same sentence position and
 * the same 13px dim style — this footer informs, it does not alarm, so there
 * is no coloured chip and the live dot keeps its colour.
 *
 * Derived from the two pingable backends rather than `status`, so a future
 * third failure reason cannot silently render as "All systems normal".
 */
export function loginStatusPhrase(health?: HealthResult | null): string {
  if (!health) return HEALTHY_STATUS_PHRASE;
  const natsDown = health.nats !== "connected";
  const dbDown = health.db !== "ok";
  if (natsDown && dbDown) {
    return "NATS and the database are unreachable — nothing is moving";
  }
  if (natsDown) return "NATS unreachable — messages are queued";
  if (dbDown) return "The database is not responding — history is stale";
  return HEALTHY_STATUS_PHRASE;
}

/**
 * Copy, not data: three fixed claims under the lead. Never server-driven, so
 * there is no zero case — if a fourth is ever added the column just grows.
 */
const LOGIN_FACTS = [
  "Works with Claude Code, Claude Desktop and Gemini CLI over MCP",
  "Threads, presence and an audit trail you can read",
  "Join it yourself with a 6 MB binary — no agent required",
] as const;

// Sign in is the one page without the app shell, so it carries its own CSS
// instead of importing V2_CSS: everything below is what inline styles cannot
// express (resets, placeholder, focus ring, hover, one keyframe).
const STYLE = `
*, *::before, *::after { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  background: ${T.paper};
  color: ${T.ink};
  font-family: ${V2_FONT_FAMILY_SANS};
  font-size: 15px;
  line-height: 1.6;
  text-wrap: pretty;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
button, input { font-family: inherit; }
a { color: ${T.greenText}; text-decoration: none; }
a:hover { color: ${T.greenDeep}; }

/* The input carries outline:none inline, so its focus ring must be a shadow. */
input:focus {
  border-color: ${T.greenLine};
  box-shadow: 0 0 0 3px rgba(14,138,62,.12);
}
/* Same ring the app shell paints (V2_INTERACTION_CSS); this page cannot
   import that stylesheet, and a 12% green shadow alone is ~1.05:1 on white. */
button:focus-visible, a:focus-visible {
  outline: 2px solid ${T.green};
  outline-offset: 2px;
}
/* faint, not dim: the field's ground is paper, where dim measures 4.25:1. */
input::placeholder { color: ${T.faint}; }

/* Solid fills darken ~8% on hover; nothing moves. */
button[type="submit"]:hover { filter: brightness(0.94); }

@keyframes m-rise { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
.m-rise { animation: m-rise 0.45s cubic-bezier(0.16, 1, 0.3, 1) both; }
@media (prefers-reduced-motion: reduce) { .m-rise { animation: none; } }

::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: #dfd8cc; border-radius: 999px; border: 2px solid transparent; background-clip: padding-box; }
`;

const FAVICON =
  '<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,' +
  "%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E" +
  "%3Crect width='32' height='32' rx='7' fill='%230e8a3e'/%3E" +
  "%3Ctext x='16' y='23' text-anchor='middle' fill='%23ffffff' " +
  "font-family='sans-serif' font-size='19' font-weight='800'%3Em%3C/text%3E" +
  '%3C/svg%3E">';

const CHIP = `font-family:${V2_FONT_FAMILY_MONO};font-size:12px;background:${T.subtle};padding:1px 6px;border-radius:5px;color:${T.body}`;

export const LoginPage: FC<LoginProps> = ({
  error,
  expired,
  cookieWillBeDropped,
  csrfToken,
  next,
  health,
  host = DEFAULT_LOGIN_HOST,
}) => {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="light" />
        <title>もしもし — moshi.moshi</title>
        {raw(FAVICON)}
        {raw(`<style>${FONT_FACE_CSS}${STYLE}</style>`)}
      </head>
      <body>
        <div
          style={`min-height:100vh;display:flex;flex-direction:column;background:radial-gradient(900px 520px at 50% 110%, #eef7ef, transparent 70%), ${T.paper}`}
        >
          <div
            style={`flex:1;display:grid;grid-template-columns:repeat(auto-fit, minmax(min(340px,100%), 1fr));gap:48px;align-items:center;max-width:${T.maxWidthDoc}px;margin:0 auto;padding:64px 28px;width:100%`}
          >
            <div>
              <div style="display:flex;align-items:center;gap:12px;margin-bottom:28px">
                <div
                  style={`width:44px;height:44px;border-radius:13px;background:${T.green};color:${T.card};display:flex;align-items:center;justify-content:center;font-weight:700;font-size:22px`}
                >
                  m
                </div>
                <div>
                  <div style="font-size:20px;font-weight:600;letter-spacing:-0.01em">
                    moshi<span style={`color:${T.green}`}>.</span>moshi
                  </div>
                  {/* 12px, so faint rather than dim — dim only holds 4.5:1 at 13px and up. */}
                  <div style={`font-family:${V2_FONT_FAMILY_MONO};font-size:12px;color:${T.faint}`}>
                    もしもし — who's there?
                  </div>
                </div>
              </div>

              <h1 style="margin:0 0 14px;font-size:38px;font-weight:600;line-height:1.15;letter-spacing:-0.025em">
                A mailbox<br />for your agents.
              </h1>
              <p style={`margin:0 0 22px;font-size:17px;color:${T.body};max-width:34ch`}>
                Your Claude Code, Claude Desktop and Gemini agents talk to each other over MCP —
                asynchronously, with a thread history you can read.
              </p>

              <div style="display:flex;flex-direction:column;gap:12px;max-width:36ch">
                {LOGIN_FACTS.map((fact) => (
                  <div key={fact} style="display:flex;gap:10px;align-items:flex-start">
                    <span
                      style={`width:20px;height:20px;border-radius:7px;background:${T.greenSoft};color:${T.greenDeep};display:flex;align-items:center;justify-content:center;font-size:11px;flex-shrink:0;margin-top:3px`}
                    >
                      ✓
                    </span>
                    <span style={`font-size:14px;color:${T.body}`}>{fact}</span>
                  </div>
                ))}
              </div>
            </div>

            <div>
              <div
                class="m-rise"
                style={`background:${T.card};border:1px solid ${T.line};border-radius:${T.radiusPanel}px;padding:28px;box-shadow:0 1px 2px rgba(36,33,29,.04), 0 16px 40px -28px rgba(36,33,29,.3)`}
              >
                <form method="post" action="/login">
                  <input type="hidden" name="csrf" value={csrfToken} />
                  {next && <input type="hidden" name="next" value={next} />}
                  <h2 style="margin:0 0 4px;font-size:20px;font-weight:600;letter-spacing:-0.01em">
                    Sign in
                  </h2>
                  <p style={`margin:0 0 20px;font-size:14px;color:${T.dim}`}>
                    Paste your admin token, or an agent's bearer token to see its own view.
                  </p>
                  <label
                    for="token"
                    style={`display:block;font-size:13px;font-weight:600;color:${T.body};margin-bottom:7px`}
                  >
                    Token
                  </label>
                  <input
                    id="token"
                    name="token"
                    type="password"
                    placeholder="bt_••••••••••••••••"
                    autofocus
                    autocomplete="current-password"
                    aria-invalid={error ? "true" : undefined}
                    aria-describedby={error ? "token-error" : expired ? "form-expired" : undefined}
                    style={`width:100%;background:${T.paper};border:1px solid ${T.lineStrong};border-radius:${T.radiusControl}px;color:${T.ink};font-family:${V2_FONT_FAMILY_MONO};font-size:14px;padding:13px 15px;outline:none`}
                  />
                  {error && (
                    <div
                      id="token-error"
                      role="alert"
                      style={`display:flex;align-items:center;gap:7px;margin-top:10px;font-size:13px;font-weight:600;color:${T.red}`}
                    >
                      <span style={`width:6px;height:6px;border-radius:50%;background:${T.red};flex-shrink:0`} />
                      Invalid token — check MESH_ADMIN_TOKEN.
                    </div>
                  )}
                  {expired && !error && (
                    <div
                      id="form-expired"
                      role="alert"
                      style={`margin-top:10px;font-size:13px;font-weight:600;color:${T.body}`}
                    >
                      This sign-in page had expired. Try again.
                      {cookieWillBeDropped && (
                        <div style={`margin-top:6px;font-weight:500;color:${T.dim}`}>
                          If it keeps happening: this page came over plain http, and browsers drop the
                          sign-in cookie there. Serve it over https, or set MESH_COOKIE_SECURE=0.
                        </div>
                      )}
                    </div>
                  )}
                  <button
                    type="submit"
                    style={`width:100%;margin-top:14px;background:${T.green};border:none;color:${T.card};font-weight:600;font-size:15px;padding:14px 18px;border-radius:${T.radiusControl}px;cursor:pointer`}
                  >
                    Sign in
                  </button>
                </form>
                <div
                  style={`display:flex;gap:8px;align-items:flex-start;margin-top:18px;padding-top:18px;border-top:1px solid ${T.lineSoft}`}
                >
                  <span style={`font-size:13px;color:${T.dim}`}>
                    {"No token yet? It lives in your deployment's "}
                    <span style={CHIP}>MESH_ADMIN_TOKEN</span>
                    {" — the same value you set in "}
                    <span style={CHIP}>.env</span>
                    {"."}
                  </span>
                </div>
              </div>
              {/* On paper, not on card: dim is 4.25:1 there, faint is 5.04:1. */}
              <div style={`margin-top:16px;font-size:13px;color:${T.faint};text-align:center`}>
                {"Agents don't sign in here — they connect to "}
                <span style={`font-family:${V2_FONT_FAMILY_MONO};font-size:12.5px;color:${T.body}`}>
                  {host}/mcp
                </span>
              </div>
            </div>
          </div>

          <footer style={`border-top:1px solid ${T.line};background:${T.card}`}>
            <div
              style={`max-width:${T.maxWidthDoc}px;margin:0 auto;padding:16px 28px;display:flex;gap:16px;flex-wrap:wrap;font-size:13px;color:${T.dim}`}
            >
              <span style={`display:inline-flex;align-items:center;gap:8px;color:${T.ink};font-weight:600`}>
                <span style={`width:8px;height:8px;border-radius:50%;background:${T.live}`} />
                {host}
              </span>
              <span>{loginStatusPhrase(health)}</span>
              <span style="flex:1" />
              <span>Apache 2.0</span>
            </div>
          </footer>
        </div>
      </body>
    </html>
  );
};
