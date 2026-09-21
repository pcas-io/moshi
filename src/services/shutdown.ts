// Shutting down in order.
//
// A deploy sends SIGTERM. What should happen: no new requests, the ones being
// answered get their answer, the broker connection is drained, the database
// is closed, the process exits. Every step is bounded, a failing step never
// keeps the ones after it from running, and a second signal changes nothing.

import type { Server } from "node:http";
import type { MiddlewareHandler } from "hono";

/** How long requests in flight get to finish once SIGTERM has arrived. */
export const HTTP_GRACE_MS = 10_000;

/** What each step of the shutdown may take at most. The compose file's
 *  `stop_grace_period` has to be longer than the sum, and
 *  tests/deploy-files.test.ts holds the two together. */
export const SHUTDOWN_STEP_TIMEOUTS_MS = {
  maintenance: 1_000,
  eventStreams: 1_000,
  http: HTTP_GRACE_MS + 1_000,
  nats: 8_000,
  database: 5_000,
} as const;
export const SHUTDOWN_BUDGET_MS = Object.values(SHUTDOWN_STEP_TIMEOUTS_MS).reduce((sum, ms) => sum + ms, 0);

// --- Draining ---
// From SIGTERM on, every answer says `Connection: close`. Without it a
// kept-alive client (the proxy in front is one) goes on sending NEW requests
// down its open connection for the whole grace period, and the last one is
// cut in the middle. The flag is read when the RESPONSE goes out, so the
// request that was in flight when the signal came is covered too.
let draining = false;
export const beginDraining = (): void => { draining = true; };
export const isDraining = (): boolean => draining;
export const _resetDrainingForTest = (): void => { draining = false; };

export function closeConnectionsWhileDraining(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    if (draining) c.header("Connection", "close");
  };
}

export interface ShutdownStep {
  name: string;
  run: () => void | Promise<void>;
  /** After this the step is given up on and the next one runs. */
  timeoutMs: number;
}

export interface ShutdownOptions {
  steps: ShutdownStep[];
  log: (level: "info" | "error", msg: string, extra?: Record<string, unknown>) => void;
  exit: (code: number) => void;
}

export function createShutdown({ steps, log, exit }: ShutdownOptions): (signal?: string) => Promise<void> {
  let running: Promise<void> | null = null;
  // The logger must never be the reason the process stays up.
  const say: ShutdownOptions["log"] = (level, msg, extra) => {
    try { log(level, msg, extra); } catch { /* stdout is gone */ }
  };

  const runAll = async (signal?: string): Promise<void> => {
    say("info", "shutting down", { signal });
    for (const step of steps) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.resolve().then(step.run),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`timed out after ${step.timeoutMs} ms`)), step.timeoutMs);
          }),
        ]);
      } catch (err) {
        say("error", "shutdown step failed", { step: step.name, err: String(err) });
      } finally {
        clearTimeout(timer);
      }
    }
    say("info", "shutdown complete");
    exit(0);
  };

  return (signal) => (running ??= runAll(signal));
}

/**
 * Stops accepting connections and resolves when the requests in flight have
 * been answered, or after `graceMs`, whichever comes first. What is still
 * open then is cut.
 */
export function closeHttpServer(server: Server, graceMs: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve();
    };
    const deadline = setTimeout(() => {
      server.closeAllConnections();
      finish();
    }, graceMs);
    deadline.unref?.();
    beginDraining();
    server.close(finish);
    // Keep-alive sockets with no request on them would hold close() open. Now,
    // and again while waiting: a connection that falls idle AFTER close() is
    // not closed by Node until its keep-alive timeout, about five seconds.
    server.closeIdleConnections();
    const sweep = setInterval(() => server.closeIdleConnections(), 250);
    sweep.unref?.();
    server.once("close", () => clearInterval(sweep));
  });
}
