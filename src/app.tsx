// The Hono app, without side effects: no config loading, no process exit,
// no listening socket. src/index.tsx builds the services and calls this;
// tests/app/ builds it over in-memory SQLite and a fake NATS.
//
// THE ORDER BELOW IS BEHAVIOUR. In particular for /mcp:
//   405 guard  →  auth  →  body limit  →  handler
// The guard sits in front of auth so a GET costs no presence write; the body
// limit sits behind auth because hono's bodyLimit drains a body of unknown
// length before it calls next(). tests/app/wiring.test.ts pins both.

import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type Database from "better-sqlite3";
import type { Env, AppVariables } from "./types.js";
import { VERSION, versionLabel } from "./version.js";
import type { Config } from "./config.js";
import type { AgentService } from "./services/agent.js";
import type { ActivityService } from "./services/activity.js";
import type { RateLimiter } from "./services/ratelimit.js";
import type { PresenceService } from "./services/presence.js";
import type { NatsPingable } from "./services/health.js";
import { checkHealth } from "./services/health.js";
import { log } from "./services/logger.js";
import { authMiddleware, safeNextPath } from "./auth.js";
import { closeConnectionsWhileDraining } from "./services/shutdown.js";
import { mcpPostOnly } from "./mcp/http-guard.js";
import { securityHeaders } from "./middleware/security-headers.js";
import { createSessionRoutes, issueLoginCsrf } from "./routes/session.js";
import { createSignInGuard } from "./services/signin-guard.js";
import { SignInThrottle } from "./services/signin-throttle.js";
import { createMcpRoute } from "./routes/mcp.js";
import type { McpRouteNats } from "./routes/mcp.js";
import { createDashboardRoutes } from "./routes/dashboard.js";
import { createFragmentRoutes } from "./routes/fragments.js";
import { createSseRoutes } from "./routes/sse.js";
import { listenerCount } from "./services/message-events.js";
import { createOAuthRoutes } from "./oauth.js";
import { registerCliRoutes, requestOrigin } from "./services/cli-dist.js";
import { registerFontRoutes } from "./routes/fonts.js";
import { createCspReportRoute } from "./routes/csp-report.js";
import { page } from "./views/nonce.js";
import { LoginPage } from "./views/login.js";

type HonoEnv = { Bindings: Env; Variables: AppVariables };

/** Everything the app asks of NATS. NatsService satisfies it; so does a fake. */
export type AppNats = McpRouteNats & NatsPingable;

export interface AppDeps {
  config: Config;
  db: Database.Database;
  nats: AppNats;
  agents: AgentService;
  activity: ActivityService;
  presence: PresenceService;
  rateLimiter: RateLimiter;
  /** Render clock for pages and fragments. Tests pin it. */
  now?: () => number;
}

type NodeBindings = { incoming?: { socket?: { remoteAddress?: string } } };

export function createApp({ config, db, nats, agents, activity, presence, rateLimiter, now }: AppDeps): Hono<HonoEnv> {
  const app = new Hono<HonoEnv>();

  // From SIGTERM on, every answer ends its connection (src/services/shutdown.ts).
  app.use("*", closeConnectionsWhileDraining());

  // --- Global error handler (C5) ---
  // Catches any uncaught error in a route handler, logs it as structured
  // JSON, and returns a generic 500 so we never leak stack traces to clients.
  app.onError((err, c) => {
    log("error", "hono request error", {
      path: c.req.path,
      method: c.req.method,
      err: err.message,
      stack: err.stack,
    });
    return c.json({ error: "internal server error" }, 500);
  });

  // --- Inject env bindings from validated config ---
  // The Env interface is kept for compatibility with existing middleware,
  // but values come from the validated config, not raw process.env.
  // One count of failed sign-ins for the form, the consent screen and the
  // Bearer header, on the same clock as everything else.
  const guard = createSignInGuard(new SignInThrottle(now ?? Date.now), { now, behindProxy: config.behindProxy });

  app.use("*", async (c, next) => {
    // Kept before c.env is replaced: without a proxy in front, this is who called.
    c.set("peerAddress", (c.env as unknown as NodeBindings | undefined)?.incoming?.socket?.remoteAddress);
    c.env = {
      NATS_URL: config.natsUrl,
      MESH_ADMIN_TOKEN: config.meshAdminToken,
      MESH_ADMIN_TOKEN_PREVIOUS: config.meshAdminTokenPrevious,
      MESH_COOKIE_SECRET: config.meshCookieSecret || undefined,
      OAUTH_SECRET: config.oauthSecret || undefined,
      DATABASE_PATH: config.databasePath,
      MESH_PUBLIC_URL: config.publicUrl || undefined,
    };
    await next();
  });

  // --- Security headers (incl. no-store for everything dynamic) ---
  // In front of the body limits: a limit answers without calling on, and its
  // 413 went out without HSTS, a policy or nosniff. This reads no body: it
  // makes the nonce before the handler and sets the headers after it.
  app.use("*", securityHeaders({
    version: versionLabel(config.commit),
    cspMode: config.cspMode,
    // Served over TLS: production with a Secure cookie. MESH_COOKIE_SECURE=0
    // is how a plain-http host says what it is, and HSTS there would lock its
    // users out for a year the day it met https.
    hsts: config.isProduction && config.cookieSecure,
  }));

  // --- Body-size limits (C6) ---
  // Cap request body sizes by route-group to prevent OOM DoS. Numbers
  // chosen just above the legitimate max for each path. Anything larger
  // returns a 413 before the handler even parses the body.
  const smallFormLimit = bodyLimit({
    maxSize: 4 * 1024, // 4 KB — login/agent CRUD forms
    onError: (c) => c.json({ error: "body_too_large" }, 413),
  });
  app.use("/login", smallFormLimit);
  app.use("/logout", smallFormLimit);
  app.use(
    "/oauth/*",
    bodyLimit({
      maxSize: 16 * 1024, // 16 KB — RFC 7591 register + authorize forms
      onError: (c) => c.json({ error: "body_too_large" }, 413),
    }),
  );
  // /mcp gets its limit on the route itself (src/routes/mcp.ts), behind the
  // 405 guard and behind auth — see the note at the top of this file.

  // --- /mcp is POST-only ---
  // In front of the auth middleware on purpose: a GET must not even cost a
  // presence write. See src/mcp/http-guard.ts for the reconnect loop it ends.
  app.use("/mcp", mcpPostOnly);

  // --- Health endpoint (no auth) ---
  // CLI distribution: /install.sh, /install.ps1, /cli/version, /cli/:file
  registerCliRoutes(app);
  registerFontRoutes(app);
  app.route("/", createCspReportRoute(now));

  // Liveness: the process is up and serving. Asks neither NATS nor SQLite.
  // This is what the container healthcheck polls. /health below is
  // readiness: it reports the broker, and a broker outage must not take the
  // dashboard (which runs on SQLite) off the proxy along with it.
  app.get("/livez", (c) => c.json({ status: "alive" }));

  app.get("/health", async (c) => {
    const h = await checkHealth(db, nats);
    return c.json(
      // sse_connections: open dashboard streams, of SSE_MAX_CONNECTIONS.
      // version + commit: what is deployed, readable from outside. Compare
      // them with git, never trust them alone (scripts/verify-deploy.mjs).
      { status: h.status, version: VERSION, commit: config.commit, nats: h.nats, db: h.db, sse_connections: listenerCount() },
      h.httpStatus,
    );
  });

  // --- Login page (no auth) ---
  app.get("/login", async (c) => {
    // Bound to a cookie this response sets: see issueLoginCsrf.
    const csrfToken = issueLoginCsrf(c, config.cookieSecure);
    const error = c.req.query("error") === "1";
    const expired = c.req.query("error") === "expired";
    // A Secure cookie over plain http is dropped by the browser: the sign-in
    // can then never succeed, and the page should say why.
    const proto = c.req.header("x-forwarded-proto") ?? new URL(c.req.url).protocol.replace(":", "");
    const cookieWillBeDropped = expired && config.cookieSecure && proto !== "https";
    const next = safeNextPath(c.req.query("next"));
    // The footer states what is actually up. Best-effort: a health check that
    // throws must not keep an operator off the sign-in page.
    let health = null;
    try {
      health = await checkHealth(db, nats);
    } catch {
      health = null;
    }
    return page(c,
      <LoginPage
        error={error}
        expired={expired}
        cookieWillBeDropped={cookieWillBeDropped}
        csrfToken={csrfToken}
        next={next === "/" ? undefined : next}
        health={health}
        host={new URL(requestOrigin(c)).host}
      />,
    );
  });

  // --- Sign-in / sign-out (no auth; see src/routes/session.ts) ---
  app.route("/", createSessionRoutes({ agents, secureCookie: config.cookieSecure, guard }));

  // --- Auth middleware on all other routes ---
  app.use("*", authMiddleware(agents, presence, activity, { secureCookie: config.cookieSecure, guard }));

  // Limits for authenticated routes come after auth, for the same reason as
  // on /mcp: bodyLimit drains a body of unknown length before it passes on,
  // and nobody anonymous should get to park a connection on an admin action.
  // /login and /oauth/* are public and read their body, so theirs stay up top.
  app.use("/agents/*", smallFormLimit);

  // --- MCP endpoint ---
  app.route("/", createMcpRoute({ nats, agents, activity, rateLimiter, presence, db }));

  // --- Dashboard pages, the connect flow and the agent admin actions ---
  app.route("/", createDashboardRoutes({ db, nats, agents, activity, presence, now }));

  // --- The live sections' fragments (behind auth, like the pages) ---
  app.route("/", createFragmentRoutes({ db, agents, presence, now }));

  // The signal that makes those refreshes immediate: GET /sse/messages.
  app.route("/", createSseRoutes());

  // --- OAuth routes ---
  app.route("/", createOAuthRoutes(agents, db, guard));

  return app;
}
