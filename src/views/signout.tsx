// "Sign out?" — what POST /logout answers when the form token that came with
// it is missing, stale or not this session's. The request may have been a
// page that sat open overnight, or another site posting on the operator's
// behalf. Either way nothing happens until the button on THIS page is
// pressed, and this page carries a token that works.

import type { FC } from "hono/jsx";
import { raw } from "hono/html";
import { V2_TOKENS, V2_FONT_FAMILY_SANS } from "./v2/tokens.js";
import { FONT_FACE_CSS } from "./fonts.js";

const T = V2_TOKENS;

const STYLE = `
  *{box-sizing:border-box}
  body{margin:0;font-family:${V2_FONT_FAMILY_SANS};color:${T.ink};background:${T.paper}}
  a{color:${T.greenDeep}}
  button{font-family:inherit}
  button:focus-visible,a:focus-visible{outline:2px solid ${T.greenDeep};outline-offset:2px}
`;

export const SignOutPage: FC<{ csrfToken: string }> = ({ csrfToken }) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <meta name="color-scheme" content="light" />
      <meta name="robots" content="noindex" />
      <title>Sign out — moshi.moshi</title>
      {raw(`<style>${FONT_FACE_CSS}${STYLE}</style>`)}
    </head>
    <body>
      <main style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:28px">
        <div
          style={`width:100%;max-width:420px;background:${T.card};border:1px solid ${T.line};border-radius:${T.radiusPanel}px;padding:28px`}
        >
          <h1 style="margin:0 0 10px;font-size:22px;font-weight:600;letter-spacing:-0.01em">Sign out?</h1>
          <p style={`margin:0 0 20px;font-size:15px;line-height:1.5;color:${T.body}`}>
            This page had been open for a while, or the request did not come from the dashboard. Nothing has
            happened yet.
          </p>
          <form method="post" action="/logout" style="display:flex;gap:12px;align-items:center;margin:0">
            <input type="hidden" name="csrf" value={csrfToken} />
            <button
              type="submit"
              style={`background:${T.ink};color:${T.card};border:0;border-radius:9px;padding:10px 16px;font-size:14px;font-weight:600;cursor:pointer`}
            >
              Sign out
            </button>
            <a href="/" style="font-size:14px">
              Stay signed in
            </a>
          </form>
        </div>
      </main>
    </body>
  </html>
);
