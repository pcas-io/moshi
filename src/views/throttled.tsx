// What a browser gets after too many failed sign-ins from its network.

import type { FC } from "hono/jsx";
import type { Context } from "hono";
import { raw } from "hono/html";
import { V2_TOKENS, V2_FONT_FAMILY_SANS } from "./v2/tokens.js";

const T = V2_TOKENS;

export const ThrottledPage: FC<{ waitSeconds: number }> = ({ waitSeconds }) => {
  const minutes = Math.max(1, Math.ceil(waitSeconds / 60));
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="light" />
        <meta name="robots" content="noindex" />
        <title>Too many attempts — moshi.moshi</title>
        {raw(`<style>*{box-sizing:border-box}body{margin:0;font-family:${V2_FONT_FAMILY_SANS};color:${T.ink};background:${T.paper}}a{color:${T.greenDeep}}a:focus-visible{outline:2px solid ${T.greenDeep};outline-offset:2px}</style>`)}
      </head>
      <body>
        <main style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:28px">
          <div style={`width:100%;max-width:440px;background:${T.card};border:1px solid ${T.line};border-radius:${T.radiusPanel}px;padding:28px`}>
            <h1 style="margin:0 0 10px;font-size:22px;font-weight:600;letter-spacing:-0.01em">Too many failed sign-ins</h1>
            <p style={`margin:0 0 16px;font-size:15px;line-height:1.5;color:${T.body}`}>
              Ten wrong tokens came from your network within a quarter of an hour. A correct token still works. Wrong
              ones are turned away for about {minutes} {minutes === 1 ? "minute" : "minutes"}.
            </p>
            <a href="/login" style="font-size:14px">Back to the sign-in page</a>
          </div>
        </main>
      </body>
    </html>
  );
};

/** The answer of a FORM to a throttled client. A wrong Bearer keeps its 401
 *  (src/auth.ts): that is the answer clients act on. */
export function throttledResponse(c: Context, waitSeconds: number): Response | Promise<Response> {
  c.header("Retry-After", String(waitSeconds));
  return c.html(<ThrottledPage waitSeconds={waitSeconds} />, 429);
}
