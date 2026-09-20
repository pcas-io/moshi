// The two durable consumers every agent has, created on first use and then
// remembered for the life of the process (or until the connection comes
// back, or the agent is revoked or deleted).
//
// Two things this replaces, both measured during a broker outage:
// - a bare `catch` around the lookup that treated a timeout like "not found"
//   and answered it with a create: a second full timeout, per durable;
// - the lookups themselves on every single /mcp request.
//
// Where a new durable starts: at the agent's `inbox_since` (creation or
// reactivation), not at the beginning of the stream. The default, DeliverAll,
// handed a brand-new agent a week of other agents' broadcasts, and replayed
// read mail after delete-and-recreate. Nothing that arrives between the
// agent's creation and its first request is lost that way either.
//
// Whose an existing durable is: a durable that the broker created BEFORE the
// agent's `inbox_since` was left behind by a predecessor with the same key
// (its delete got swallowed by an outage and the process restarted since).
// It is replaced, when the caller asks for that (`replaceLeftBehind`), and
// the log says so. Nothing has to be remembered for that across restarts.
//
// The caller asks for it only for agents that were created or reactivated
// after this rule came in. An agent from before may have inherited such a
// durable under the old code and been reading from it for weeks: replacing
// that one would hand it up to seven days of read mail again.
//
// Written against a small interface so it can be tested without a broker,
// like the pull logic in inbox.ts.

import { AckPolicy, DeliverPolicy } from "nats";
import type { ConsumerConfig } from "nats";
import { inboxConsumerName, broadcastConsumerName, isConsumerNotFound } from "./inbox.js";
import { log } from "./logger.js";

// 30 s ack wait, in nanoseconds
const ACK_WAIT_NS = 30 * 1_000_000_000;
const MAX_DELIVER = 5;

/** The app's clock and the broker's are not the same clock. A durable that
 *  is this much older than the agent is still the agent's own. */
const CLOCK_TOLERANCE_MS = 5_000;

export interface ConsumerAdmin {
  /** Rejects with "consumer not found" when there is none. `created` is the
   *  broker's timestamp, RFC 3339 with nanoseconds. */
  info(name: string): Promise<{ created?: string } | unknown>;
  add(config: Partial<ConsumerConfig>): Promise<unknown>;
  delete(name: string): Promise<unknown>;
}

export interface EnsureOptions {
  /** Delete and recreate a durable that is older than `since`. */
  replaceLeftBehind?: boolean;
}

export class ConsumerRegistry {
  private readonly ensured = new Set<string>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private generation = 0;

  private readonly clockToleranceMs: number;

  constructor(private readonly admin: ConsumerAdmin, opts: { clockToleranceMs?: number } = {}) {
    this.clockToleranceMs = opts.clockToleranceMs ?? CLOCK_TOLERANCE_MS;
  }

  /** Make sure both durables for `inboxKey` exist. `since` is the agent's
   *  `inbox_since`; without it nothing is known about the agent, and the
   *  durables are taken or created as they are. Throws when the broker cannot
   *  be asked; callers degrade, the next request tries again. */
  ensure(inboxKey: string, since?: string | null, opts: EnsureOptions = {}): Promise<void> {
    const key = inboxKey.toLowerCase();
    if (this.ensured.has(key)) return Promise.resolve();
    const running = this.inFlight.get(key);
    if (running) return running;

    const generation = this.generation;
    const work = (async () => {
      const replace = opts.replaceLeftBehind === true;
      await this.ensureOne(inboxConsumerName(key), `mesh.agents.${key}.inbox`, since ?? null, replace);
      await this.ensureOne(broadcastConsumerName(key), "mesh.broadcast", since ?? null, replace);
      // forget() or clear() while this ran: what was just confirmed may be
      // the very thing that got deleted. Do not remember it.
      if (generation === this.generation) this.ensured.add(key);
    })().finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, work);
    return work;
  }

  /** Already ensured? Lets the caller skip the broker, and the breaker,
   *  for a question that memory answers. */
  has(inboxKey: string): boolean {
    return this.ensured.has(inboxKey.toLowerCase());
  }

  /** The durables of this key were deleted (revoke, delete). */
  forget(inboxKey: string): void {
    this.generation++;
    this.ensured.delete(inboxKey.toLowerCase());
  }

  /** Nothing is certain any more (reconnect: the broker may be a new one). */
  clear(): void {
    this.generation++;
    this.ensured.clear();
  }

  private async ensureOne(durable: string, filterSubject: string, since: string | null, replace: boolean): Promise<void> {
    try {
      const info = (await this.admin.info(durable)) as { created?: string } | undefined;
      if (!replace || !isLeftBehind(info?.created, since, this.clockToleranceMs)) return;
      log("warn", "replacing a durable that is older than its agent", { durable, created: info?.created, inbox_since: since });
      await this.admin.delete(durable);
    } catch (err) {
      // Only "not found" means "create it". A timeout means "cannot tell".
      if (!isConsumerNotFound(err)) throw err;
    }
    await this.admin.add({
      durable_name: durable,
      filter_subject: filterSubject,
      ack_policy: AckPolicy.Explicit,
      max_deliver: MAX_DELIVER,
      ack_wait: ACK_WAIT_NS,
      ...(since ? { deliver_policy: DeliverPolicy.StartTime, opt_start_time: since } : {}),
    });
  }
}

/** Older than the agent it would serve, beyond what two clocks can differ. */
function isLeftBehind(created: string | undefined, since: string | null, toleranceMs: number): boolean {
  if (!created || !since) return false;
  const createdMs = Date.parse(created);
  const sinceMs = Date.parse(since);
  if (Number.isNaN(createdMs) || Number.isNaN(sinceMs)) return false;
  return createdMs < sinceMs - toleranceMs;
}
