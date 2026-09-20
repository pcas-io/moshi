// Process-local pub/sub for newly-persisted messages.
// Used by GET /sse/messages (src/routes/sse.ts) to tell open dashboard tabs
// that something was sent. Module-level state is intentional — there is one
// pub/sub bus per server process.

import type { Message } from "../types.js";

type Listener = (msg: Message) => void;

const listeners = new Set<Listener>();

/** Notify all subscribers that a new message was just persisted.
 *  Called from `sendAndPersistMessage` after the SQLite insert. */
export function publishMessageEvent(msg: Message): void {
  for (const l of listeners) {
    try {
      l(msg);
    } catch {
      // Subscriber failures must never break the publisher path.
    }
  }
}

/** Subscribe to new-message events. Returns an unsubscribe function. */
export function subscribeMessageEvents(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** How many subscribers there are right now. Every open /sse/messages
 *  connection is exactly one, which is what /health reports and what the
 *  route's connection limit counts. */
export function listenerCount(): number {
  return listeners.size;
}

/** For tests: drop every subscription. Not used in production. */
export function _resetMessageEventsForTest(): void {
  listeners.clear();
}
