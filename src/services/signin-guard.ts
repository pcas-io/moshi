// What happens when a presented credential is wrong: a line in the log, a
// count against the client, and from the eleventh failure on a 429.
//
// One guard for the three places a token is presented: the sign-in form, the
// OAuth consent form, and the Bearer header. A request that presents nothing
// (an expired tab, a rejected form) never gets here.

import type { Context } from "hono";
import { clientIp, clientKey, shortIp } from "./client-ip.js";
import { SignInThrottle, FAILURE_LIMIT } from "./signin-throttle.js";
import { log } from "./logger.js";

export type SignInFailure = "wrong_token" | "wrong_bearer" | "admin_token_refused";

/** A path is the sender's text. This much of it goes into a log line. */
const MAX_LOGGED_PATH = 200;
/** "sign-in failed" lines a minute, from all clients together. The count per
 *  client bounds one address; this bounds a flood of them. It is the first
 *  line in this app that an anonymous request can write at will. */
export const MAX_FAILURE_LINES_PER_MINUTE = 300;

export interface SignInGuard {
  /**
   * Call when a credential turned out wrong. Returns 0 when the caller should
   * answer as usual (401, back to the form), or the seconds to put into
   * `Retry-After`: with a 429 for a form, with the usual 401 for a Bearer.
   *
   * Nothing of the credential goes in here, so nothing of it can come out in
   * a log line.
   */
  failure(c: Context, reason: SignInFailure): number;
}

export interface SignInGuardOptions {
  now?: () => number;
  /** See `clientIp`: without a proxy in front only the socket is believed. */
  behindProxy?: boolean;
}

export function createSignInGuard(
  throttle: SignInThrottle = new SignInThrottle(),
  { now = Date.now, behindProxy = true }: SignInGuardOptions = {},
): SignInGuard {
  const minute = { start: Number.NEGATIVE_INFINITY, lines: 0, leftOut: 0 };

  /** One "sign-in failed" line, unless this minute has had its share. */
  function logFailure(fields: Record<string, unknown>): void {
    const at = now();
    if (at - minute.start >= 60_000 || at < minute.start) {
      if (minute.leftOut > 0) log("warn", "sign-in failures not logged", { count: minute.leftOut, limit_per_minute: MAX_FAILURE_LINES_PER_MINUTE });
      minute.start = at;
      minute.lines = 0;
      minute.leftOut = 0;
    }
    if (minute.lines >= MAX_FAILURE_LINES_PER_MINUTE) {
      minute.leftOut++;
      return;
    }
    minute.lines++;
    log("warn", "sign-in failed", fields);
  }

  return {
    failure(c, reason) {
      const ip = clientIp(c.req, (c.get("peerAddress" as never) as string | undefined) ?? undefined, { behindProxy });
      const client = clientKey(ip);
      const wait = throttle.retryAfter(client);
      // Throttled already: no count, no line. A client that hammers on must
      // be able to neither extend its own block for ever nor fill the log.
      if (wait > 0) return wait;
      const { justThrottled } = throttle.fail(client);
      logFailure({ path: c.req.path.slice(0, MAX_LOGGED_PATH), reason, ip: shortIp(ip) });
      if (justThrottled) {
        // Once each time the count fills up. A client that keeps retrying
        // fills it again as its old failures age out.
        log("warn", "sign-in throttled", { ip: shortIp(ip), failures: FAILURE_LIMIT, retry_after_s: throttle.retryAfter(client) });
      }
      return 0;
    },
  };
}
