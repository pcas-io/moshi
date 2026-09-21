// GET /sse/messages: the "ask now" signal for the live sections.
//
// An open dashboard tab refreshes its sections from /fragments/* on a timer
// (src/views/v2/live-refresh.ts). This stream makes that immediate: one event
// per persisted message, and the tab asks for its fragments right away.
//
// Contract, pinned by tests/app/sse.test.ts:
// - An event is `{ id, thread_id, created_at }`. No sender, no recipient, no
//   payload, no context. What a tab may show is decided where it is rendered;
//   this stream only says when to ask. It also keeps the stream cheap: a
//   256 KB payload is not copied to every open tab.
// - A comment line goes out at once, and one every 25 s. The first makes a
//   buffering proxy release the response headers, so EventSource reports
//   "open". The others keep idle connections from being cut.
// - `Cache-Control: no-store` and `X-Accel-Buffering: no`.
// - At most SSE_MAX_CONNECTIONS at a time. Beyond that 503: EventSource does
//   not retry a non-200 by itself, and the tab stays on its timer.
// - GET only. hono runs a GET handler for HEAD and then throws the body away
//   without cancelling it: the subscription below would stay for ever, take
//   one of the places and queue every future event. 50 x `curl -I` switched
//   the feature off for everybody until the next restart.
// - No connection lives for ever. A reader that does not read is ended once
//   SSE_MAX_QUEUED events wait for it, every connection after
//   SSE_MAX_LIFETIME_MS. EventSource reconnects by itself, and the script
//   asks for everything when a stream opens, so nothing is missed. That also
//   bounds how long a session that was signed out or revoked keeps reading
//   ids: the session is only checked when the stream is opened.
// - Mounted behind auth. EventSource sends `Accept: text/event-stream`, so a
//   missing session is a plain 401 and not a redirect to the login page.

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { Env, AppVariables } from "../types.js";
import { listenerCount, subscribeMessageEvents } from "../services/message-events.js";

type HonoEnv = { Bindings: Env; Variables: AppVariables };

/** A soft limit: every open tab holds one connection for as long as it is
 *  visible. The number is reported by /health as `sse_connections`. */
export const SSE_MAX_CONNECTIONS = 50;
/** Under Cloudflare's 100 s idle timeout, with room for a lost ping. */
export const SSE_HEARTBEAT_MS = 25_000;
/** Events that may wait for a reader before the connection is ended. Each
 *  costs about 1.5 KB of heap for as long as it waits. */
export const SSE_MAX_QUEUED = 256;
export const SSE_MAX_LIFETIME_MS = 30 * 60_000;
export const SSE_PATH = "/sse/messages";

// Every open stream's way out, so a shutdown can end them all. Without it an
// open tab would hold the HTTP server's close() until its grace period ran
// out, on every deploy.
const openStreams = new Set<() => void>();
let closedForGood = false;

/** Ends every open stream and takes no new one: the process is going away.
 *  A stream opened during the grace period held the shutdown for all of it.
 *  The tabs reconnect, to whoever serves then. */
export function endAllStreams(): number {
  closedForGood = true;
  const n = openStreams.size;
  for (const end of [...openStreams]) end();
  return n;
}

export function _resetSseForTest(): void {
  closedForGood = false;
  openStreams.clear();
}

export function createSseRoutes(
  { heartbeatMs = SSE_HEARTBEAT_MS, maxLifetimeMs = SSE_MAX_LIFETIME_MS }: { heartbeatMs?: number; maxLifetimeMs?: number } = {},
): Hono<HonoEnv> {
  const sse = new Hono<HonoEnv>();

  sse.all(SSE_PATH, (c) => {
    if (c.req.method !== "GET") return c.body(null, 405, { Allow: "GET" });
    if (closedForGood) {
      return c.json({ error: "shutting_down" }, 503, { "Retry-After": "30", "Cache-Control": "no-store", Connection: "close" });
    }
    if (listenerCount() >= SSE_MAX_CONNECTIONS) {
      return c.json({ error: "too_many_streams" }, 503, { "Retry-After": "30", "Cache-Control": "no-store" });
    }
    // streamSSE runs the callback up to its first await before it returns:
    // the place is taken in the same tick the count was checked in.
    const res = streamSSE(c, async (stream) => {
      let wake: (() => void) | null = null;
      let queued = 0;
      let over = false;
      const end = () => { over = true; openStreams.delete(end); wake?.(); };
      openStreams.add(end);
      const unsubscribe = subscribeMessageEvents((msg) => {
        if (over) return;
        if (queued >= SSE_MAX_QUEUED) { end(); return; } // nobody is reading
        queued++;
        // write() swallows its own errors: a tab that just went away must
        // never reach the sender's code path.
        void stream
          .writeSSE({ data: JSON.stringify({ id: msg.id, thread_id: msg.correlation_id ?? msg.id, created_at: msg.created_at }) })
          .then(() => { queued--; });
      });
      stream.onAbort(() => { unsubscribe(); end(); });
      const endsAt = Date.now() + maxLifetimeMs;
      await stream.write(": open\n\n");
      while (!stream.aborted && !over && Date.now() < endsAt) {
        // Not stream.sleep(): that timer would outlive the connection by up
        // to 25 s, for every tab that was ever closed.
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, Math.min(heartbeatMs, Math.max(0, endsAt - Date.now())));
          wake = () => { clearTimeout(timer); resolve(); };
        });
        if (stream.aborted || over || Date.now() >= endsAt) break;
        await stream.write(": ping\n\n");
      }
      unsubscribe();
      openStreams.delete(end);
      // Returning closes the response; with a reader that does not read, the
      // waiting writes are dropped with it.
      if (over && !stream.aborted) stream.abort();
    });
    res.headers.set("Cache-Control", "no-store");
    res.headers.set("X-Accel-Buffering", "no");
    return res;
  });

  return sse;
}
