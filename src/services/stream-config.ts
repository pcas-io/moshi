// The stream's configuration is code, and the broker is brought in line with
// it at every connect.
//
// It used to be create-only: `streams.info`, and on ANY error `streams.add`.
// A stream made by an older version kept its limits for ever, and a timeout
// was answered with a create.

export interface WantedStream {
  name: string;
  subjects: string[];
  retention: string;
  storage: string;
  max_age: number;
  max_bytes: number;
  duplicate_window: number;
  num_replicas: number;
}

export interface StreamAdmin {
  /** Rejects with "stream not found" (10059) when there is none. */
  info(name: string): Promise<{ config: Record<string, unknown>; state?: { messages?: number; bytes?: number; first_ts?: string } }>;
  add(config: WantedStream): Promise<unknown>;
  update(name: string, config: Record<string, unknown>): Promise<unknown>;
}

type Log = (level: "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>) => void;

/** What a broker lets nobody change on an existing stream. Retention is NOT
 *  in here: interest to limits is done in place (checked on 2.14), only
 *  to/from workqueue is refused, and that comes back as a refusal below. The
 *  first version advised recreating the stream by hand for it, which would
 *  have cost the mail in it. */
const IMMUTABLE: (keyof WantedStream)[] = ["storage"];
const MUTABLE: (keyof WantedStream)[] = ["subjects", "retention", "max_age", "max_bytes", "duplicate_window", "num_replicas"];
/** Fields where a smaller value makes the broker delete stored messages at once. */
const LIMITS: (keyof WantedStream)[] = ["max_age", "max_bytes"];

/** By the broker's code when it sent one, by its text only when it did not. */
export function isStreamNotFound(err: unknown): boolean {
  const e = err as { api_error?: { err_code?: number }; message?: string } | null;
  const code = e?.api_error?.err_code;
  if (typeof code === "number") return code === 10059;
  return /^stream not found$/i.test((e?.message ?? "").trim());
}

/** The broker answered, and the answer is no. Not an outage: those have no api_error. */
const isRefusal = (err: unknown): boolean => typeof (err as { api_error?: { err_code?: number } } | null)?.api_error?.err_code === "number";

const unlimited = (v: unknown): boolean => v === 0 || v === -1 || v === undefined || v === null;
const shrinks = (from: unknown, to: unknown): boolean =>
  typeof to === "number" && !unlimited(to) && (unlimited(from) || (typeof from === "number" && to < from));

const same = (a: unknown, b: unknown): boolean =>
  Array.isArray(a) && Array.isArray(b)
    ? a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n")
    : a === b;

/**
 * Creates the stream, or updates the fields this file manages when they
 * differ. Everything else the broker reports about the stream stays as it is.
 * Only "not found" leads to a create; any other failure is the caller's
 * (connect() fails and is tried again).
 */
export async function reconcileStream(
  admin: StreamAdmin,
  wanted: WantedStream,
  log: Log,
): Promise<"created" | "unchanged" | "updated" | "drift"> {
  let current: Record<string, unknown>;
  let state: { messages?: number; bytes?: number; first_ts?: string } | undefined;
  try {
    const info = await admin.info(wanted.name);
    current = info.config;
    state = info.state;
  } catch (err) {
    if (!isStreamNotFound(err)) throw err;
    await admin.add(wanted);
    log("info", "stream created", { stream: wanted.name });
    return "created";
  }

  const stuck = IMMUTABLE.filter((field) => !same(current[field], wanted[field]));
  for (const field of stuck) {
    log("error", "stream differs in a field no broker changes on an existing stream", {
      stream: wanted.name, field, is: current[field], should_be: wanted[field],
    });
  }

  const changed = MUTABLE.filter((field) => !same(current[field], wanted[field]));
  if (changed.length > 0) {
    for (const field of changed) {
      log("warn", "stream configuration differs, updating", { stream: wanted.name, field, from: current[field], to: wanted[field] });
    }
    // A smaller limit is not like the other changes: the broker removes what
    // no longer fits the moment it accepts the update. Said first, and loudly.
    const smaller = changed.filter((field) => LIMITS.includes(field) && shrinks(current[field], wanted[field]));
    if (smaller.length > 0) {
      log("error", "a smaller stream limit removes stored messages at once: everything older or beyond it is gone after this update", {
        stream: wanted.name, fields: smaller, messages: state?.messages, bytes: state?.bytes, oldest: state?.first_ts,
      });
    }
    try {
      await admin.update(wanted.name, { ...current, ...Object.fromEntries(changed.map((field) => [field, wanted[field]])) });
    } catch (err) {
      if (!isRefusal(err)) throw err;
      log("error", "the broker refused the stream update; the stream stays as it is", { stream: wanted.name, fields: changed, err: String((err as Error).message) });
      return "drift";
    }
  }
  return stuck.length > 0 ? "drift" : changed.length > 0 ? "updated" : "unchanged";
}
