// Response headers every route gets.
//
// `Cache-Control: no-store` is the default for anything that did not decide
// for itself: every page here is authenticated and dynamic, and the Agents
// page can carry a one-time bearer token that must not survive in a browser's
// back/forward or disk cache. Routes that serve cacheable bytes (the CLI
// binaries, the fonts) set their own header and keep it.
//
// Content-Security-Policy: scripts run only with the nonce of THIS response
// (src/views/nonce.tsx writes it into our own inline scripts), everything else
// comes from this origin, nothing may frame a page. See `buildCsp`.

import crypto from "node:crypto";
import type { MiddlewareHandler } from "hono";

export type CspMode = "enforce" | "report" | "off";

export interface SecurityHeaderOptions {
  /** `X-Mesh-Version`. */
  version: string;
  /** "report" sends the policy as Report-Only: the browser says what WOULD be
   *  blocked (POST /csp-report) and blocks nothing. */
  cspMode: CspMode;
  /** The deployment is served over TLS. Never on a plain-http host: a browser
   *  that once saw this header refuses http for a year. */
  hsts: boolean;
}

/** What an answer that is not a page may do: nothing. */
const LOCKED = "default-src 'none'; frame-ancestors 'none'";

/**
 * What a page may do, and nothing a request said is ever part of it.
 *
 * `default-src 'none'`: the app has no frame, no media, no manifest, no
 * worker, so what is not named below is refused. Styles keep 'unsafe-inline'
 * (the pages are built from style attributes) and have no 'self': there is no
 * stylesheet file. `'report-sample'` makes a report carry the first
 * characters of a blocked script, which is what tells an own script that lost
 * its nonce from what a proxy or an extension injected.
 *
 * `form-action 'self'` on EVERY page. Chrome applies it to every redirect
 * that follows a form post, so the OAuth consent form is not answered with a
 * redirect (src/oauth.ts): the client's origin would have to be written in
 * here, and a host name may contain ';'.
 */
export function buildCsp(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}' 'report-sample'`,
    "style-src 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "report-uri /csp-report",
  ].join("; ");
}

export function securityHeaders({ version, cspMode, hsts }: SecurityHeaderOptions): MiddlewareHandler {
  return async (c, next) => {
    // Before the handler: the views need it while they render.
    const nonce = crypto.randomBytes(16).toString("base64");
    c.set("cspNonce", nonce);
    await next();
    c.header("X-Mesh-Version", version);
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
    c.header("Referrer-Policy", "strict-origin-when-cross-origin");
    if (!c.res.headers.has("Cache-Control")) c.header("Cache-Control", "no-store");
    if (hsts) c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    if (cspMode !== "off") {
      const isPage = (c.res.headers.get("Content-Type") ?? "").startsWith("text/html");
      c.header(cspMode === "enforce" ? "Content-Security-Policy" : "Content-Security-Policy-Report-Only", isPage ? buildCsp(nonce) : LOCKED);
    }
  };
}
