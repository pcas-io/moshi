import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { setCookie, deleteCookie } from "hono/cookie";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { initDatabase } from "./services/db.js";
import { NatsService } from "./services/nats.js";
import { AgentService } from "./services/agent.js";
import { ActivityService } from "./services/activity.js";
import { RateLimiter } from "./services/ratelimit.js";
import {
  authMiddleware,
  hashToken,
  timingSafeEqual,
  generateCsrfToken,
  validateCsrfToken,
  generateSessionCookie,
  getCookieSecret,
  safeNextPath,
} from "./auth.js";
import { createMcpServer } from "./mcp/server.js";
import { createOAuthRoutes, cleanupExpiredOAuthTokens } from "./oauth.js";
import { registerCliRoutes, requestOrigin } from "./services/cli-dist.js";
import { createAgentAdminRoutes } from "./routes/agent-admin.js";
import { createAgentConnectRoutes } from "./routes/agent-connect.js";
import { RATE_LIMIT_PER_MINUTE, VERSION, LIMITS, MESSAGE_RETENTION_DAYS, ACTIVITY_RETENTION_DAYS } from "./types.js";
import type { Env, AppVariables } from "./types.js";
import { loadConfig, isConfigError } from "./config.js";
import { log } from "./services/logger.js";
import { listMessages, listConversations } from "./services/message-queries.js";
import { getFlash } from "./services/flash.js";
import { checkHealth } from "./services/health.js";
import { PresenceService } from "./services/presence.js";
import { loadV2HomeData } from "./services/v2-home-data.js";
import { loadV2AgentsData } from "./services/v2-agents-data.js";
import { subscribeMessageEvents } from "./services/message-events.js";
import { parseActivityRange, startOfDayIso } from "./services/activity.js";
import { streamSSE } from "hono/streaming";

// --- Views ---
import { LoginPage } from "./views/login.js";
import { V2HomePage } from "./views/v2/home.js";
import { V2AgentsPage } from "./views/v2/agents.js";
import {
  V2LogPage,
  messageRoutingOf,
  parseLogRouting,
  parseLogTab,
} from "./views/v2/log.js";
import { V2ConversationsPage } from "./views/v2/conversations.js";

// --- Load and validate configuration (fail-fast on missing/invalid secrets) ---
// Closes code-review findings C2 (empty MESH_ADMIN_TOKEN bypass) and C3
// (OAuth/Cookie secret fallback chain). See src/config.ts for validation rules.
const configResult = loadConfig();
if (isConfigError(configResult)) {
  log("fatal", "configuration validation failed", { errors: configResult.errors });
  console.error("\nFATAL: env validation failed:");
  for (const e of configResult.errors) {
    console.error("  - " + e);
  }
  console.error("\nSee .env.example for the required variables.");
  process.exit(1);
}
const config = configResult;

// --- Initialize services ---
const db = initDatabase(config.databasePath);
const nats = new NatsService(config.natsUrl);
const activity = new ActivityService(db);
// C8: AgentService gets a NatsCleanup handle (interface-shimmed — the
// NatsService class happens to implement deleteConsumer) so it can
// garbage-collect JetStream consumers when agents are revoked/deleted/renamed.
const agents = new AgentService(db, activity, nats);
const rateLimiter = new RateLimiter(RATE_LIMIT_PER_MINUTE);
// Presence: single write-path (touch) + single read-path (list/countByState).
// Wired into authMiddleware and every MCP tool that needs agent presence.
const presence = new PresenceService(db, nats);

// --- Hono app ---
type HonoEnv = { Bindings: Env; Variables: AppVariables };
const app = new Hono<HonoEnv>();

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
app.use("*", async (c, next) => {
  c.env = {
    NATS_URL: config.natsUrl,
    MESH_ADMIN_TOKEN: config.meshAdminToken,
    MESH_ADMIN_TOKEN_PREVIOUS: config.meshAdminTokenPrevious,
    MESH_COOKIE_SECRET: config.meshCookieSecret || undefined,
    OAUTH_SECRET: config.oauthSecret || undefined,
    DATABASE_PATH: config.databasePath,
  };
  await next();
});

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
app.use("/agents/*", smallFormLimit);
app.use(
  "/oauth/*",
  bodyLimit({
    maxSize: 16 * 1024, // 16 KB — RFC 7591 register + authorize forms
    onError: (c) => c.json({ error: "body_too_large" }, 413),
  }),
);
app.use(
  "/mcp",
  bodyLimit({
    maxSize: 512 * 1024, // 512 KB — 256 KB payload + JSON-RPC envelope + headroom
    onError: (c) =>
      c.json(
        {
          jsonrpc: "2.0",
          error: { code: -32600, message: "Request body too large (max 512 KB)" },
          id: null,
        },
        413,
      ),
  }),
);

// --- Security headers ---
app.use("*", async (c, next) => {
  await next();
  c.header("X-Mesh-Version", VERSION);
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
});

// --- Health endpoint (no auth) ---
// CLI distribution: /install.sh, /install.ps1, /cli/version, /cli/:file
registerCliRoutes(app);

app.get("/health", async (c) => {
  const h = await checkHealth(db, nats);
  return c.json(
    { status: h.status, nats: h.nats, db: h.db },
    h.httpStatus,
  );
});

// --- Login page (no auth) ---
app.get("/login", async (c) => {
  const cookieSecret = getCookieSecret(c.env as unknown as Record<string, string | undefined>);
  const csrfToken = generateCsrfToken(cookieSecret);
  const error = c.req.query("error") === "1";
  const next = safeNextPath(c.req.query("next"));
  // The footer states what is actually up. Best-effort: a health check that
  // throws must not keep an operator off the sign-in page.
  let health = null;
  try {
    health = await checkHealth(db, nats);
  } catch {
    health = null;
  }
  return c.html(
    <LoginPage
      error={error}
      csrfToken={csrfToken}
      next={next === "/" ? undefined : next}
      health={health}
      host={new URL(requestOrigin(c)).host}
    />,
  );
});

app.post("/login", async (c) => {
  const cookieSecret = getCookieSecret(c.env as unknown as Record<string, string | undefined>);
  const body = await c.req.parseBody();
  const token = body["token"] as string;
  const csrf = body["csrf"] as string;
  const next = safeNextPath(typeof body["next"] === "string" ? body["next"] : undefined);
  const loginError = `/login?error=1${next !== "/" ? `&next=${encodeURIComponent(next)}` : ""}`;

  if (!validateCsrfToken(csrf, cookieSecret)) {
    return c.redirect(loginError);
  }

  const adminToken = c.env.MESH_ADMIN_TOKEN;
  const adminTokenPrev = c.env.MESH_ADMIN_TOKEN_PREVIOUS;
  const hash = hashToken(token);

  let resolvedName: string | null = null;

  if (timingSafeEqual(hash, hashToken(adminToken))) {
    resolvedName = "admin";
  } else if (adminTokenPrev && timingSafeEqual(hash, hashToken(adminTokenPrev))) {
    resolvedName = "admin";
  } else {
    const foundAgent = agents.getByTokenHash(hash);
    if (foundAgent && foundAgent.is_active) {
      resolvedName = foundAgent.name;
    }
  }

  if (!resolvedName) {
    return c.redirect(loginError);
  }

  const sessionValue = generateSessionCookie(resolvedName, cookieSecret);
  setCookie(c, "mesh_session", sessionValue, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    maxAge: 30 * 24 * 60 * 60, // 30 days
  });

  return c.redirect(next);
});

// --- Auth middleware on all other routes ---
app.use("*", authMiddleware(agents, presence, activity));

// --- Logout ---
app.post("/logout", (c) => {
  deleteCookie(c, "mesh_session", { path: "/" });
  return c.redirect("/login");
});

app.get("/logout", (c) => {
  deleteCookie(c, "mesh_session", { path: "/" });
  return c.redirect("/login");
});

// --- MCP endpoint ---
app.all("/mcp", async (c) => {
  if (
    c.req.method !== "POST" &&
    c.req.method !== "GET" &&
    c.req.method !== "DELETE"
  ) {
    return c.json(
      {
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed." },
        id: null,
      },
      405,
    );
  }

  const agent = c.get("agent");
  const agentName = agent?.name ?? "anonymous";
  const isAdmin = agent?.role === "admin";

  // Ensure NATS consumers exist for this agent. The admin identity has no
  // inbox by design (see ADMIN_NOT_AGENT_HINT), so no consumers for it.
  if (!isAdmin) {
    try {
      await nats.ensureConsumer(agentName);
    } catch {
      // Non-fatal — consumer creation may fail on first request, retry on next
    }
  }

  const server = createMcpServer({
    nats,
    agents,
    activity,
    rateLimiter,
    presence,
    db,
    agentName,
    isAdmin,
  });

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless — new transport per request
    enableJsonResponse: true,
  });

  await server.connect(transport);

  try {
    const response = await transport.handleRequest(c.req.raw);
    return response;
  } catch (err) {
    log("error", "mcp request failed", {
      agent: agentName,
      err: String(err),
      stack: (err as Error)?.stack,
    });
    return c.json(
      {
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      },
      500,
    );
  } finally {
    await transport.close();
    await server.close();
  }
});

// --- Helper: cookie secret ---
function cookieSecretFor(env: Env): string {
  return getCookieSecret(env as unknown as Record<string, string | undefined>);
}

// --- Dashboard: Home (v2) ---
app.get("/", async (c) => {
  const agent = c.get("agent");
  const csrfToken = generateCsrfToken(cookieSecretFor(c.env));
  const data = await loadV2HomeData({ db, presence, nats });
  return c.html(
    <V2HomePage
      {...data}
      userRole={agent?.role ?? undefined}
      userName={agent?.name ?? undefined}
      csrfToken={csrfToken}
    />,
  );
});

// --- SSE: live thread updates ---
// Subscribes to in-process message events and forwards messages with the
// matching correlation_id to the connected dashboard. EventSource auto-
// reconnects on network drops; auth piggy-backs on the session cookie.
app.get("/sse/threads/:correlation_id", (c) => {
  const correlationId = c.req.param("correlation_id");
  return streamSSE(c, async (stream) => {
    const unsubscribe = subscribeMessageEvents((msg) => {
      const tid = msg.correlation_id ?? msg.id;
      if (tid !== correlationId) return;
      stream.writeSSE({
        data: JSON.stringify({
          id: msg.id, from: msg.from, payload: msg.payload, created_at: msg.created_at,
        }),
      }).catch(() => { /* connection closed */ });
    });
    stream.onAbort(() => unsubscribe());
    // Heartbeat every 25s keeps proxies from killing idle SSE connections.
    while (!stream.aborted) {
      await stream.sleep(25_000);
      await stream.writeSSE({ event: "ping", data: "" }).catch(() => {});
    }
    unsubscribe();
  });
});

// --- Dashboard: Agents (admin only) ---
app.get("/agents", async (c) => {
  const agent = c.get("agent");
  if (agent?.role !== "admin") return c.redirect("/");

  // Creating an agent is the connect flow's job now. The old deep link
  // still works so bookmarks and the palette entry land somewhere useful.
  if (c.req.query("new") === "1") return c.redirect("/agents/connect");

  const csrfToken = generateCsrfToken(cookieSecretFor(c.env));
  const flash = getFlash(c.req.query("flash"));
  const agentsData = await loadV2AgentsData(db, presence);

  return c.html(
    <V2AgentsPage
      agents={agentsData}
      csrfToken={csrfToken}
      newToken={flash?.newToken}
      error={flash?.error}
      inspectId={c.req.query("inspect")}
      presenceFilter={c.req.query("presence")}
      userRole={agent.role}
      userName={agent.name}
    />,
  );
});

// --- The guided connect flow (/agents/connect, admin only) ---
// Mounted before the admin actions so its own POST target is unambiguous.
app.route("/agents", createAgentConnectRoutes({ agents, presence, cookieSecretFor }));

// --- Agent admin actions (create/revoke/reactivate/rename/reset-token/delete) ---
app.route("/agents", createAgentAdminRoutes({ agents, cookieSecretFor }));

// --- Dashboard: Log (Messages + Audit trail) ---
// One route, two tabs. Both tabs filter in SQL, so the counts on screen and
// the `total` behind the pager describe the same set.
app.get("/log", (c) => {
  const agent = c.get("agent");
  const offsetParam = parseInt(c.req.query("offset") ?? "0", 10);
  const offset = isNaN(offsetParam) || offsetParam < 0 ? 0 : offsetParam;
  const query = c.req.query("q")?.trim() || undefined;
  const filterAgent = c.req.query("agent")?.trim() || undefined;
  const tab = parseLogTab(c.req.query("tab"));
  const routing = parseLogRouting(c.req.query("routing"));
  const filterEntity = c.req.query("entity")?.trim() || undefined;
  const range = parseActivityRange(c.req.query("range"));

  const allAgents = agents.list();
  const shared = {
    tab,
    query,
    routing,
    filterAgent,
    filterEntity,
    filterRange: range,
    agentRoles: Object.fromEntries(allAgents.map((a) => [a.name, a.role])),
    userRole: agent?.role ?? undefined,
    userName: agent?.name ?? undefined,
    csrfToken: generateCsrfToken(cookieSecretFor(c.env)),
  };

  if (tab === "audit") {
    const filter = { agent_name: filterAgent, entity_type: filterEntity, q: query, range };
    return c.html(
      <V2LogPage
        {...shared}
        events={activity.list({ ...filter, limit: LIMITS.PAGINATION_DEFAULT, offset })}
        // "Busiest today" means today, not "the 50 rows we happened to fetch".
        topActors={activity.topActors({ ...filter, since: startOfDayIso(), limit: 5 })}
      />,
    );
  }

  return c.html(
    <V2LogPage
      {...shared}
      messages={listMessages(db, {
        limit: LIMITS.PAGINATION_DEFAULT,
        offset,
        agent: filterAgent,
        q: query,
        routing: messageRoutingOf(routing),
      })}
    />,
  );
});

// --- Permanent redirects for the two routes Log replaced ---
// The query string has to survive: ?agent= ?q= ?routing= ?offset= ?entity=
// ?range= are all in use, and /conversations and the palette link to them.
function logRedirect(c: { req: { url: string } }, extra?: Record<string, string>): string {
  const incoming = new URL(c.req.url).searchParams;
  const params = new URLSearchParams(extra);
  for (const [key, value] of incoming) params.set(key, value);
  const qs = params.toString();
  return qs ? `/log?${qs}` : "/log";
}

app.get("/messages", (c) => c.redirect(logRedirect(c), 301));
app.get("/activity", (c) => c.redirect(logRedirect(c, { tab: "audit" }), 301));

// --- Dashboard: Conversations ---
app.get("/conversations", (c) => {
  const agent = c.get("agent");
  const csrfToken = generateCsrfToken(cookieSecretFor(c.env));

  const offsetParam = parseInt(c.req.query("offset") ?? "0", 10);
  const offset = isNaN(offsetParam) || offsetParam < 0 ? 0 : offsetParam;
  const query = c.req.query("q")?.trim() || undefined;
  const filterAgent = c.req.query("agent")?.trim() || undefined;
  const result = listConversations(db, {
    limit: LIMITS.PAGINATION_DEFAULT,
    offset,
    q: query,
    agent: filterAgent,
  });
  const allAgents = agents.list();
  return c.html(
    <V2ConversationsPage
      result={result}
      selectedId={c.req.query("id")}
      query={query}
      filterAgent={filterAgent}
      agentRoles={Object.fromEntries(allAgents.map((a) => [a.name, a.role]))}
      userRole={agent?.role ?? undefined}
      userName={agent?.name ?? undefined}
      csrfToken={csrfToken}
    />,
  );
});

// --- OAuth routes ---
app.route("/", createOAuthRoutes(agents, db));

// --- Process-level error handlers (C5) ---
// Prevent a single unhandled async rejection from crashing the process.
// Structured log entries make post-incident debugging in Coolify possible.
process.on("unhandledRejection", (reason) => {
  log("error", "unhandled rejection", {
    reason: String(reason),
    stack: (reason as Error)?.stack,
  });
  // Don't exit — a stray rejection shouldn't take down the whole server.
  // Coolify will restart us if /health starts failing.
});

process.on("uncaughtException", (err) => {
  log("fatal", "uncaught exception", {
    err: err.message,
    stack: err.stack,
  });
  // An uncaught exception means the process is in an unknown state.
  // Exit and let Coolify restart — safer than continuing.
  process.exit(1);
});

// --- Start server + graceful shutdown ---
async function start() {
  // Rotate old data on startup
  const oauthCleaned = cleanupExpiredOAuthTokens(db);
  if (oauthCleaned > 0) {
    log("info", "cleaned up expired oauth tokens", { count: oauthCleaned });
  }
  const msgRotated = activity.rotateMessages(MESSAGE_RETENTION_DAYS);
  const actRotated = activity.rotate(ACTIVITY_RETENTION_DAYS);
  if (msgRotated > 0 || actRotated > 0) {
    log("info", "rotated retention tables", {
      messages: msgRotated,
      activity_entries: actRotated,
    });
  }

  // C4: Bounded retry loop for initial NATS connection. Once connected,
  // the NatsService keeps itself alive via `reconnect: true`. This loop
  // only matters for the first attempt — if NATS is still booting
  // (compose startup race), we wait up to ~20s.
  const MAX_CONNECT_ATTEMPTS = 10;
  for (let attempt = 1; attempt <= MAX_CONNECT_ATTEMPTS; attempt++) {
    try {
      await nats.connect();
      break;
    } catch (err) {
      if (attempt === MAX_CONNECT_ATTEMPTS) {
        log("fatal", "nats connect failed after max attempts", {
          attempts: attempt,
          url: config.natsUrl,
          err: String(err),
        });
        throw err;
      }
      log("warn", "nats connect attempt failed, retrying", {
        attempt,
        max: MAX_CONNECT_ATTEMPTS,
        err: String(err),
      });
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  log("info", "nats connected", { url: config.natsUrl });

  const server = serve({ fetch: app.fetch, port: config.port });
  log("info", "moshi listening", {
    version: VERSION,
    port: config.port,
    production: config.isProduction,
  });

  const shutdown = async () => {
    log("info", "shutting down");
    server.close();
    await nats.close();
    db.close();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

start().catch((err) => {
  log("fatal", "failed to start", { err: String(err), stack: (err as Error)?.stack });
  process.exit(1);
});
