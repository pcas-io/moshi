// Process bootstrap: configuration, services, the listening socket, signals.
// Everything about routes and middleware lives in src/app.tsx, which has no
// side effects and is what the tests import.

import { serve } from "@hono/node-server";
import { initDatabase } from "./services/db.js";
import { maintenanceTasks, BACKUP_TASK, EXPIRED_UNREAD_TASK } from "./services/maintenance-tasks.js";
import { createShutdown, closeHttpServer, beginDraining, HTTP_GRACE_MS, SHUTDOWN_STEP_TIMEOUTS_MS } from "./services/shutdown.js";
import { endAllStreams } from "./routes/sse.js";
import type { Server as HttpServer } from "node:http";
import { NatsService } from "./services/nats.js";
import { AgentService } from "./services/agent.js";
import { ActivityService } from "./services/activity.js";
import { RateLimiter } from "./services/ratelimit.js";
import { PresenceService } from "./services/presence.js";
import { recordDeadLetter } from "./services/dead-letter.js";
import { startMaintenance } from "./services/maintenance.js";
import { RATE_LIMIT_PER_MINUTE, VERSION } from "./types.js";
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
const db = initDatabase(config.databasePath, {
  // A copy of the database as it was, before pending migrations touch it.
  backupDir: config.backupKeep > 0 ? config.backupDir : null,
  onLog: (level, msg, extra) => log(level, msg, extra),
});
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
// A message the broker has given up on gets an audit row. Until now nobody
// was listening when the broker said so.
nats.onDeadLetter((letter, streamCreated) => recordDeadLetter(db, activity, letter, streamCreated));

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
  // Nobody restarts this process for it either: the container healthcheck
  // polls /livez, which only says that the process serves.
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
  const backupDir = config.backupKeep > 0 ? config.backupDir : null;
  // Retention and expired-credential cleanup: now, then hourly. It used to
  // run only here, so "30 days" really meant "until the next restart".
  const stopMaintenance = startMaintenance(
    maintenanceTasks({ db, activity, backupDir, backupKeep: config.backupKeep }),
    {
      intervalMs: MAINTENANCE_INTERVAL_MS,
      onResult: (name, count) => {
        if (name === BACKUP_TASK) log("info", "database backup written", { dir: backupDir, keep: config.backupKeep });
        else if (name === EXPIRED_UNREAD_TASK) log("warn", "messages expired unread", { count });
        else log("info", "maintenance removed expired rows", { table: name, count });
      },
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
    commit: config.commit,
    port: config.port,
    production: config.isProduction,
    cookie_secure: config.cookieSecure,
    // Whose address failed sign-ins are counted against. False behind a
    // proxy means one count for everybody: look here first.
    behind_proxy: config.behindProxy,
    csp: config.cspMode,
  });

  // C4: First connect in the background, for as long as it takes. Once
  // connected, the NatsService keeps itself alive via `reconnect: true`.
  let stopping = false;
  void (async () => {
    for (let attempt = 1; !stopping; attempt++) {
      try {
        await nats.connect();
        log("info", "nats connected", { url: config.natsUrl, attempts: attempt, server_version: nats.serverVersion() });
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

  // In order, each step bounded, none skipped (src/services/shutdown.ts).
  // The sum stays under the 30 s the compose file gives the container.
  const shutdown = createShutdown({
    log: (level, msg, extra) => log(level, msg, extra),
    exit: (code) => process.exit(code),
    steps: [
      { name: "maintenance", timeoutMs: SHUTDOWN_STEP_TIMEOUTS_MS.maintenance, run: () => { stopping = true; stopMaintenance(); } },
      // Open tabs first, or each of them holds the server's close() for the full grace period.
      { name: "event-streams", timeoutMs: SHUTDOWN_STEP_TIMEOUTS_MS.eventStreams, run: () => { beginDraining(); endAllStreams(); } },
      // No new requests; the ones being answered get their answer.
      { name: "http", timeoutMs: SHUTDOWN_STEP_TIMEOUTS_MS.http, run: () => closeHttpServer(server as HttpServer, HTTP_GRACE_MS) },
      { name: "nats", timeoutMs: SHUTDOWN_STEP_TIMEOUTS_MS.nats, run: () => nats.close() },
      {
        name: "database", timeoutMs: SHUTDOWN_STEP_TIMEOUTS_MS.database,
        run: () => {
          // Fold the write-ahead log into the file: what is on the volume
          // afterwards is the whole database, in one piece.
          try { db.pragma("wal_checkpoint(TRUNCATE)"); } catch { /* read-only or busy: close() still checkpoints */ }
          db.close();
        },
      },
    ],
  });

  // In the image a preload (docker/early-signals.mjs) has been listening since
  // before this file was compiled, and it is handed the real shutdown here.
  // Its listener is never removed and re-added: libuv addresses a queued
  // signal to the handle that was there when it arrived.
  const early = (globalThis as { __moshiStop?: { handle: (signal: string) => void } }).__moshiStop;
  if (early) {
    early.handle = (signal) => void shutdown(signal);
  } else {
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
    process.on("SIGINT", () => void shutdown("SIGINT"));
  }
}

start().catch((err) => {
  log("fatal", "failed to start", { err: String(err), stack: (err as Error)?.stack });
  process.exit(1);
});
