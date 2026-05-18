import type Database from "better-sqlite3";

/**
 * Backend pingability check used by the `/health` endpoint. Accepts a
 * minimal NATS surface (just `ping()`) so tests can supply a plain object
 * without spinning up a real NATS connection.
 *
 * Extracted from `src/index.tsx` as part of the C1 pragmatic split.
 */

export interface NatsPingable {
  ping(): Promise<boolean>;
}

export interface HealthResult {
  status: "ok" | "degraded";
  nats: "connected" | "disconnected";
  db: "ok" | "error";
  /** HTTP status to return on the response (200 when ok, 503 when degraded). */
  httpStatus: 200 | 503;
}

export async function checkHealth(
  db: Database.Database,
  nats: NatsPingable,
): Promise<HealthResult> {
  const natsOk = await nats.ping();
  let dbOk = false;
  try {
    db.prepare("SELECT 1").get();
    dbOk = true;
  } catch {
    // DB not accessible
  }
  const ok = natsOk && dbOk;
  return {
    status: ok ? "ok" : "degraded",
    nats: natsOk ? "connected" : "disconnected",
    db: dbOk ? "ok" : "error",
    httpStatus: ok ? 200 : 503,
  };
}
