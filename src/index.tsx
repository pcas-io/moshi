// Process bootstrap: configuration, services, the listening socket, signals.
// Everything about routes and middleware lives in src/app.tsx, which has no
// side effects and is what the tests import.

import { serve } from "@hono/node-server";
import { initDatabase } from "./services/db.js";
import { NatsService } from "./services/nats.js";
import { AgentService } from "./services/agent.js";
import { ActivityService } from "./services/activity.js";
import { RateLimiter } from "./services/ratelimit.js";
import { PresenceService } from "./services/presence.js";
import { startMaintenance } from "./services/maintenance.js";
import { cleanupExpiredOAuthTokens } from "./oauth.js";
import { RATE_LIMIT_PER_MINUTE, VERSION, MESSAGE_RETENTION_DAYS, ACTIVITY_RETENTION_DAYS } from "./types.js";
import { loadConfig, isConfigError } from "./config.js";
import { log } from "./services/logger.js";
import { createApp } from "./app.js";

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

const app = createApp({ config, db, nats, agents, activity, presence, rateLimiter });

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

const MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000;

// --- Start server + graceful shutdown ---
async function start() {
  // Retention and expired-credential cleanup: now, then hourly. It used to
  // run only here, so "30 days" really meant "until the next restart".
  const stopMaintenance = startMaintenance(
    [
      { name: "oauth_tokens", run: () => cleanupExpiredOAuthTokens(db) },
      { name: "messages", run: () => activity.rotateMessages(MESSAGE_RETENTION_DAYS) },
      { name: "activity_log", run: () => activity.rotate(ACTIVITY_RETENTION_DAYS) },
    ],
    {
      intervalMs: MAINTENANCE_INTERVAL_MS,
      onResult: (name, count) => log("info", "maintenance removed expired rows", { table: name, count }),
      onError: (name, err) => log("error", "maintenance task failed", { table: name, err: String(err) }),
    },
  );

  // Serve first. The dashboard runs on SQLite and must be reachable while
  // NATS is still coming up, or gone; MCP tools answer `nats_unavailable`
  // until the broker is there. This used to be the other way round: ten
  // connection attempts, then the process gave up after about 20 seconds.
  const server = serve({ fetch: app.fetch, port: config.port });
  log("info", "moshi listening", {
    version: VERSION,
    port: config.port,
    production: config.isProduction,
    cookie_secure: config.cookieSecure,
  });

  // C4: First connect in the background, for as long as it takes. Once
  // connected, the NatsService keeps itself alive via `reconnect: true`.
  let stopping = false;
  void (async () => {
    for (let attempt = 1; !stopping; attempt++) {
      try {
        await nats.connect();
        log("info", "nats connected", { url: config.natsUrl, attempts: attempt });
        return;
      } catch (err) {
        const waitMs = Math.min(30_000, 2000 * attempt);
        log(attempt === 1 ? "warn" : "error", "nats connect attempt failed, retrying", {
          attempt,
          retry_in_ms: waitMs,
          url: config.natsUrl,
          err: String(err),
        });
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
  })();

  const shutdown = async () => {
    log("info", "shutting down");
    stopping = true;
    stopMaintenance();
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
