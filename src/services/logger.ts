// Minimal structured JSON logger.
//
// Output format: one JSON line per event, with ISO-8601 timestamp + level +
// message + arbitrary metadata. Compatible with Coolify/docker log scraping
// and any downstream JSON log pipeline (Loki, Vector, Elastic).
//
// Design constraints:
// - Stdlib only. No external deps (keeps the supply chain footprint minimal).
// - Sync. Logger calls must never throw or block the request path.
// - Error/fatal go to stderr, everything else to stdout (conventional split).
//
// Intentionally simple: no levels hierarchy filtering, no transports, no
// async flushing. If we ever need those, we migrate to pino — but for the
// current scale a 15-line logger is the right trade-off.

export type LogLevel = "debug" | "info" | "warn" | "error" | "fatal";

export function log(
  level: LogLevel,
  msg: string,
  meta?: Record<string, unknown>,
): void {
  const entry = {
    t: new Date().toISOString(),
    lvl: level,
    msg,
    ...meta,
  };
  let line: string;
  try {
    line = JSON.stringify(entry);
  } catch {
    // Fallback if meta contains a circular reference — don't let logging
    // crash the caller.
    line = JSON.stringify({ t: entry.t, lvl: level, msg, meta_error: "unserializable" });
  }
  if (level === "error" || level === "fatal") {
    console.error(line);
  } else {
    console.log(line);
  }
}
