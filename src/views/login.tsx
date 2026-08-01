import type { FC } from "hono/jsx";
import { raw } from "hono/html";
import {
  V2_TOKENS,
  V2_LOGIN_BG,
  V2_GRID_BG,
  V2_FONT_FAMILY_SANS,
  V2_FONT_FAMILY_MONO,
  greenGlow,
} from "./v2/tokens.js";

interface LoginProps {
  error?: boolean;
  csrfToken: string;
}

// Self-contained SENTINEL Dark login — "Mesh Access". Grid pattern + green
// radial glow, staggered fadeUp, charcoal card. Dark-only, matching the
// dashboard's `color-scheme: dark`.
const STYLE = `
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; }
  body {
    font-family: ${V2_FONT_FAMILY_SANS};
    color: ${V2_TOKENS.text};
    background: ${V2_LOGIN_BG};
    -webkit-font-smoothing: antialiased;
  }
  @keyframes v2-fade-up {
    0%   { opacity: 0; transform: translateY(20px); filter: blur(4px); }
    100% { opacity: 1; transform: translateY(0);    filter: blur(0); }
  }
  .fade { opacity: 0; animation: v2-fade-up 0.7s cubic-bezier(0.16,1,0.3,1) forwards; }
  @media (prefers-reduced-motion: reduce) { .fade { animation: none; opacity: 1; } }
  .grid-bg {
    position: fixed; inset: 0; pointer-events: none;
    background-image: ${V2_GRID_BG};
    background-size: 56px 56px;
  }
  .page { position: relative; min-height: 100vh; display: flex; flex-direction: column; }
  .center { position: relative; flex: 1; display: flex; align-items: center; justify-content: center; padding: 24px; }
  .col { width: 400px; max-width: 100%; }
  .brand { display: flex; align-items: center; gap: 12px; margin-bottom: 26px; animation-delay: 0.15s; }
  .mark {
    width: 38px; height: 38px; border-radius: 8px;
    background: ${V2_TOKENS.accent}; color: ${V2_TOKENS.accentInk};
    display: flex; align-items: center; justify-content: center;
    font-weight: 800; font-size: 21px;
  }
  .brand-name { font-size: 20px; font-weight: 700; letter-spacing: -0.02em; line-height: 1.1; }
  .brand-name .dot { color: ${V2_TOKENS.accent}; }
  .brand-sub { font-family: ${V2_FONT_FAMILY_MONO}; font-size: 10.5px; color: ${V2_TOKENS.textMute}; margin-top: 3px; }
  h1 {
    margin: 0 0 6px; font-size: clamp(30px, 4.5vw, 40px); font-weight: 700;
    line-height: 1.05; letter-spacing: -0.05em; text-transform: uppercase;
    animation-delay: 0.3s;
  }
  h1 .accent { color: ${V2_TOKENS.accent}; }
  .tagline {
    margin: 0 0 26px; font-weight: 300; font-size: 14px;
    color: ${V2_TOKENS.textDim}; animation-delay: 0.45s;
  }
  .card {
    background: ${V2_TOKENS.surface}; border: 1px solid ${V2_TOKENS.lineCard};
    border-radius: 8px; padding: 22px; animation-delay: 0.6s;
  }
  .label {
    font-size: 10px; letter-spacing: 0.18em; text-transform: uppercase;
    color: ${V2_TOKENS.textMute}; font-weight: 600; margin-bottom: 8px;
  }
  input[type=password] {
    width: 100%; background: ${V2_TOKENS.inset};
    border: 1px solid ${V2_TOKENS.line2}; border-radius: 4px;
    color: ${V2_TOKENS.text}; font-family: ${V2_FONT_FAMILY_MONO};
    font-size: 13px; padding: 12px 14px; outline: none;
  }
  input[type=password]:focus { border-color: ${greenGlow(0.55)}; }
  input[type=password]::placeholder { color: ${V2_TOKENS.textFaint}; }
  .error {
    margin-top: 10px; font-size: 12px; color: ${V2_TOKENS.danger};
    font-weight: 600; display: flex; align-items: center; gap: 7px;
  }
  .error .dot { width: 6px; height: 6px; border-radius: 50%; background: ${V2_TOKENS.danger}; }
  button {
    width: 100%; margin-top: 14px;
    background: ${V2_TOKENS.accent}; border: none; color: ${V2_TOKENS.accentInk};
    font-family: ${V2_FONT_FAMILY_SANS}; font-weight: 700; font-size: 12px;
    letter-spacing: 0.08em; text-transform: uppercase;
    padding: 13px 18px; border-radius: 2px; cursor: pointer;
  }
  button:hover { filter: brightness(1.12); }
  .hint {
    margin-top: 14px; font-family: ${V2_FONT_FAMILY_MONO};
    font-size: 10px; color: ${V2_TOKENS.textFaint}; line-height: 1.7;
  }
  .mcp-line {
    margin-top: 18px; font-family: ${V2_FONT_FAMILY_MONO};
    font-size: 10px; color: ${V2_TOKENS.textFaint}; letter-spacing: 0.06em;
    animation-delay: 0.75s;
  }
  .mcp-line .url { color: ${V2_TOKENS.textDim}; }
  footer {
    position: relative; display: flex; align-items: center; gap: 14px;
    padding: 12px clamp(16px, 3vw, 36px); border-top: 1px solid ${V2_TOKENS.line};
    font-family: ${V2_FONT_FAMILY_MONO}; font-size: 10.5px;
    color: ${V2_TOKENS.textMute}; flex-wrap: wrap;
  }
  .domain { display: inline-flex; align-items: center; gap: 7px; color: ${V2_TOKENS.text}; font-weight: 600; }
  .domain .dot { width: 7px; height: 7px; border-radius: 50%; background: ${V2_TOKENS.accent}; box-shadow: 0 0 8px ${greenGlow(0.6)}; }
  .sep { color: #333333; }
  .spacer { flex: 1; }
  .warn { color: ${V2_TOKENS.warn}; }
`;

export const LoginPage: FC<LoginProps> = ({ error, csrfToken }) => {
  return (
    <html lang="de">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="dark" />
        <title>もしもし — moshi.moshi</title>
        {raw(
          '<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,' +
          '%3Csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 32 32\'%3E' +
          '%3Crect width=\'32\' height=\'32\' rx=\'7\' fill=\'%2305e901\'/%3E' +
          '%3Ctext x=\'16\' y=\'23\' text-anchor=\'middle\' fill=\'%230a0a0a\' ' +
          "font-family='sans-serif' font-size='19' font-weight='800'%3Em%3C/text%3E" +
          "%3C/svg%3E\">"
        )}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Sora:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
        {raw(`<style>${STYLE}</style>`)}
      </head>
      <body>
        <div class="page">
          <div class="grid-bg" />
          <div class="center">
            <div class="col">
              <div class="brand fade">
                <div class="mark">m</div>
                <div>
                  <div class="brand-name">moshi<span class="dot">.</span>moshi</div>
                  <div class="brand-sub">もしもし — who's there?</div>
                </div>
              </div>
              <h1 class="fade">Mesh <span class="accent">Access</span></h1>
              <p class="tagline fade">
                Async agent-to-agent messaging, done right. Sign in with your admin token.
              </p>
              <div class="card fade">
                <form method="post" action="/login">
                  <input type="hidden" name="csrf" value={csrfToken} />
                  <div class="label">Admin Token</div>
                  <input
                    name="token"
                    type="password"
                    placeholder="bt_••••••••••••••••"
                    autofocus
                    autocomplete="current-password"
                  />
                  {error && (
                    <div class="error"><span class="dot" />Invalid token — check MESH_ADMIN_TOKEN.</div>
                  )}
                  <button type="submit">Sign In</button>
                </form>
                <div class="hint">
                  Bearer token · stored as SHA-256 hash · sessions signed with MESH_COOKIE_SECRET
                </div>
              </div>
              <div class="mcp-line fade">
                AGENTS CONNECT VIA MCP — <span class="url">https://moshi.enki.run/mcp</span>
              </div>
            </div>
          </div>
          <footer>
            <span class="domain"><span class="dot" />moshi.enki.run</span>
            <span class="sep">·</span><span>NATS JetStream</span>
            <span class="sep">·</span><span>Apache 2.0</span>
            <span class="spacer" />
            <span class="warn">NATS · SINGLE-NODE</span>
          </footer>
        </div>
      </body>
    </html>
  );
};
