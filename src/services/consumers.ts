// The two durable consumers every agent has, created on first use and then
// remembered for the life of the process (or until the connection comes
// back, or the agent is revoked or deleted).
//
// Two things this replaces, both measured during a broker outage:
// - a bare `catch` around the lookup that treated a timeout like "not found"
//   and answered it with a create: a second full timeout, per durable;
// - the lookups themselves on every single /mcp request.
//
// Written against a two-method interface so it can be tested without a
// broker, like the pull logic in inbox.ts.

import { AckPolicy } from "nats";
import type { ConsumerConfig } from "nats";
import { inboxConsumerName, broadcastConsumerName, isConsumerNotFound } from "./inbox.js";

// 30 s ack wait, in nanoseconds
const ACK_WAIT_NS = 30 * 1_000_000_000;
const MAX_DELIVER = 5;

export interface ConsumerAdmin {
  info(name: string): Promise<unknown>;
  add(config: Partial<ConsumerConfig>): Promise<unknown>;
}

export class ConsumerRegistry {
  private readonly ensured = new Set<string>();
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(private readonly admin: ConsumerAdmin) {}

  /** Make sure both durables for `inboxKey` exist. Throws when the broker
   *  cannot be asked; callers degrade, the next request tries again. */
  ensure(inboxKey: string): Promise<void> {
    const key = inboxKey.toLowerCase();
    if (this.ensured.has(key)) return Promise.resolve();
    const running = this.inFlight.get(key);
    if (running) return running;

    const work = (async () => {
      await this.ensureOne(inboxConsumerName(key), `mesh.agents.${key}.inbox`);
      await this.ensureOne(broadcastConsumerName(key), "mesh.broadcast");
      this.ensured.add(key);
    })().finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, work);
    return work;
  }

  /** The durables of this key were deleted (revoke, delete). */
  forget(inboxKey: string): void {
    this.ensured.delete(inboxKey.toLowerCase());
  }

  /** Nothing is certain any more (reconnect: the broker may be a new one). */
  clear(): void {
    this.ensured.clear();
  }

  private async ensureOne(durable: string, filterSubject: string): Promise<void> {
    try {
      await this.admin.info(durable);
      return;
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
    });
  }
}
