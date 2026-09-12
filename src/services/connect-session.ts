/**
 * Server-side memory for the guided connect flow (`/agents/connect`).
 *
 * One entry per run of "Connect an agent". The plaintext bearer token is
 * shown exactly once and steps 2, 3 and 4 all need it, so — unlike
 * `services/flash.ts` — reading an entry here does NOT consume it. The key
 * travels in the URL as `?s=`, so it is 144 bits of CSPRNG randomness and
 * never anything derived from the agent (a guessable key would hand the
 * token to whoever guessed it).
 *
 * The store is in-memory and therefore lost on a restart: redeploy while
 * someone is on step 3 and they land back on step 1 with the token gone.
 * That is accepted rather than overlooked. The deployment is explicitly
 * single-node (one process, NATS JetStream and SQLite beside it), the flow
 * takes about two minutes end to end, and the recovery path is one click —
 * reset the token from /agents. Writing a plaintext token to disk to
 * survive a restart that will rarely land mid-flow is the worse trade.
 *
 * If moshi ever runs more than one node, this has to move to SQLite (with
 * the token encrypted at rest) or the flow has to become sticky — a second
 * node simply will not find the `?s=` key.
 */

import { randomBytes } from "node:crypto";

/** How long the token stays on screen. Step 2's expired copy states it. */
export const CONNECT_SESSION_TTL_MS = 15 * 60 * 1000;

export interface ConnectSession {
  /** Opaque, unguessable URL key (`?s=`). */
  key: string;
  agentId: string;
  agentName: string;
  /** Plaintext bearer token — only ever held here and in the rendered page. */
  token: string;
  createdAt: number;
}

export type ConnectSessionInput = Omit<ConnectSession, "key" | "createdAt">;

const sessions = new Map<string, ConnectSession>();

function newKey(): string {
  return randomBytes(18).toString("base64url");
}

/** Drop everything past its TTL. Cheap enough to run on every read: the map
 *  holds one entry per connect run, and a connect run is a rare event. */
function sweep(now: number): void {
  for (const [key, session] of sessions) {
    if (now - session.createdAt >= CONNECT_SESSION_TTL_MS) sessions.delete(key);
  }
}

export function createConnectSession(
  input: ConnectSessionInput,
  now: number = Date.now(),
): ConnectSession {
  sweep(now);
  const session: ConnectSession = { ...input, key: newKey(), createdAt: now };
  sessions.set(session.key, session);
  return session;
}

/** The entry for `key`, or null when it never existed or has expired.
 *  Repeatable: steps 2, 3 and 4 each read the same entry. */
export function readConnectSession(
  key: string | undefined,
  now: number = Date.now(),
): ConnectSession | null {
  sweep(now);
  if (!key) return null;
  return sessions.get(key) ?? null;
}

/** Test seam. Production never needs to empty the store — the sweep does. */
export function clearConnectSessions(): void {
  sessions.clear();
}
