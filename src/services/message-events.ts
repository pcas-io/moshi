// Process-local pub/sub for newly-persisted messages.
// Used by the v2 dashboard SSE endpoints to push live thread updates
// without polling. Module-level state is intentional — there is one
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

/** For tests: drop every subscription. Not used in production. */
export function _resetMessageEventsForTest(): void {
  listeners.clear();
}
