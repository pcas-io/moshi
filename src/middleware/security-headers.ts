// Response headers every route gets.
//
// `Cache-Control: no-store` is the default for anything that did not decide
// for itself: every page here is authenticated and dynamic, and the Agents
// page can carry a one-time bearer token that must not survive in a browser's
// back/forward or disk cache. Routes that serve cacheable bytes (the CLI
// binaries) set their own header and keep it.

import type { MiddlewareHandler } from "hono";

export function securityHeaders(version: string): MiddlewareHandler {
  return async (c, next) => {
    await next();
    c.header("X-Mesh-Version", version);
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
    c.header("Referrer-Policy", "strict-origin-when-cross-origin");
    if (!c.res.headers.has("Cache-Control")) c.header("Cache-Control", "no-store");
  };
}
