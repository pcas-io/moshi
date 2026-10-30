// Makes the calls. Once a second it takes what is due (src/services/
// webhook-queue.ts), builds the body, signs it and posts it, a few at a time.
// It runs beside the requests and never inside one: a send has long been
// answered when its hook is called.
//
// The body, in the envelope of Standard Webhooks:
//
//   { "type": "message.created", "timestamp": "<ISO>",
//     "data": { "agent", "inbox_pending", "count", "messages": [...], "truncated" } }
//
// `inbox_pending` is asked from the broker at the time of the call, with the
// same arithmetic as every tool reply (`waitingFor`); null when the broker
// does not answer. Every attempt is signed with a fresh timestamp, under the
// delivery's id.

import type Database from "better-sqlite3";
import type { MeshNats } from "../mcp/shared.js";
import { waitingFor } from "../mcp/shared.js";
import type { ActivityService } from "./activity.js";
import type { WebhookService } from "./webhooks.js";
import { claimDue, announced, recordSuccess, recordFailure, drop } from "./webhook-queue.js";
import type { Claim, FailureOutcome } from "./webhook-queue.js";
import { postWebhook } from "./webhook-target.js";
import type { PostResult } from "./webhook-target.js";
import { signingHeaders } from "./webhook-sign.js";
import { log } from "./logger.js";

export const TICK_MS = 1_000;
/** Calls in flight at once, across all agents. */
export const MAX_IN_FLIGHT = 8;

export type Poster = (url: string, headers: Record<string, string>, body: string) => Promise<PostResult>;

export interface DispatcherDeps {
  db: Database.Database;
  webhooks: WebhookService;
  nats: Pick<MeshNats, "inboxPending">;
  activity?: ActivityService;
  post?: Poster;
  now?: () => number;
}

export class WebhookDispatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = new Set<Promise<void>>();
  private readonly post: Poster;
  private readonly now: () => number;

  constructor(private readonly deps: DispatcherDeps) {
    this.post = deps.post ?? ((url, headers, body) => postWebhook(url, headers, body));
    this.now = deps.now ?? Date.now;
  }

  start(intervalMs: number = TICK_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref();
  }

  /** No new calls. Those in flight end on their own, within their timeout;
   *  one cut short by the exit is taken again when its lease runs out. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Takes what is due and starts it. Resolves when those calls are done. */
  async tick(): Promise<void> {
    const room = MAX_IN_FLIGHT - this.inFlight.size;
    if (room <= 0) return;
    let claims: Claim[];
    try {
      claims = claimDue(this.deps.db, room, this.now());
    } catch (err) {
      log("error", "webhook claim failed", { err: String(err) });
      return;
    }
    const started = claims.map((claim) => {
      const run: Promise<void> = this.attempt(claim).finally(() => this.inFlight.delete(run));
      this.inFlight.add(run);
      return run;
    });
    await Promise.all(started);
  }

  private async attempt(claim: Claim): Promise<void> {
    try {
      const material = this.deps.webhooks.material(claim.agentKey);
      if (!material) {
        // Its agent was deactivated: nobody is to be woken. (A removed or
        // switched-off hook took its deliveries with it.)
        drop(this.deps.db, claim);
        return;
      }
      if (material.secret === null) {
        this.outcome(claim, material.agentName, { retryable: false, error: "secret_unreadable: set the webhook again" });
        return;
      }
      const { count, messages } = announced(this.deps.db, claim.id);
      const now = this.now();
      const body = JSON.stringify({
        type: "message.created",
        timestamp: new Date(now).toISOString(),
        data: {
          agent: material.agentName,
          inbox_pending: await this.pendingFor(claim.agentKey),
          count,
          messages,
          truncated: count > messages.length,
        },
      });
      const seconds = Math.floor(this.now() / 1000);
      const headers: Record<string, string> =
        material.authMode === "bearer"
          ? { "webhook-id": claim.id, "webhook-timestamp": String(seconds), authorization: `Bearer ${material.secret}` }
          : signingHeaders(material.secret, claim.id, seconds, body);
      const result = await this.post(material.url, headers, body);
      if (result.ok) {
        recordSuccess(this.deps.db, claim, this.now());
        return;
      }
      this.outcome(claim, material.agentName, result);
    } catch (err) {
      // A bug here must not take the dispatcher down; the lease runs out and
      // the delivery is taken again.
      log("error", "webhook attempt failed", { delivery: claim.id, err: String(err) });
    }
  }

  private outcome(claim: Claim, agentName: string, failure: { retryable: boolean; error: string }): void {
    const outcome: FailureOutcome = recordFailure(this.deps.db, claim, failure, this.now());
    log(outcome === "retry" ? "warn" : "error", "webhook delivery failed", {
      agent: agentName,
      delivery: claim.id,
      attempt: claim.attempt,
      outcome,
      error: failure.error,
    });
    if (outcome === "failed" || outcome === "disabled") {
      this.deps.activity?.logAsync({
        action: outcome === "disabled" ? "webhook_disabled" : "webhook_failed",
        entity_type: "agent",
        entity_id: claim.agentKey,
        summary:
          outcome === "disabled"
            ? `Webhook of "${agentName}" switched off after repeated failures (${failure.error})`
            : `Webhook of "${agentName}" could not be delivered (${failure.error})`,
        agent_name: agentName,
      });
    }
  }

  private async pendingFor(agentKey: string): Promise<number | null> {
    try {
      return waitingFor({ db: this.deps.db, inboxKey: agentKey }, await this.deps.nats.inboxPending(agentKey));
    } catch {
      return null;
    }
  }
}
