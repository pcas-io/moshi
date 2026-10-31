// What one call looks like for each kind of hook, and what its outcome means.
//
// A webhook gets the Standard Webhooks envelope, signed or with a bearer key.
// A Claude Code routine's API trigger takes `{"text": …}` and a required
// `anthropic-version` header, and starts a whole new session on every call
// that arrives. So for a routine a call is repeated only when it certainly
// did not arrive (`reached: false`) or the service said it was overloaded;
// a timeout or a 500 may have started a session, and a second call would
// start another. A busy routine (429, or 503 with a time to come back) is
// asked again when it said, which is no failure.

import type { AnnouncedMessage } from "./webhook-queue.js";
import type { WebhookMaterial } from "./webhooks.js";
import type { PostResult } from "./webhook-target.js";
import { signingHeaders } from "./webhook-sign.js";

/** The endpoint accepts every version from this one on and behaves the same. */
export const ANTHROPIC_VERSION = "2023-06-01";
/** How long a busy receiver is left alone when it does not say. */
const DEFAULT_WAIT_SECONDS = 60;

export interface Announcement {
  agent: string;
  inbox_pending: number | null;
  count: number;
  messages: AnnouncedMessage[];
  truncated: boolean;
}

/** The sentence a routine reads first; the metadata follows it as JSON. */
export function routineText(data: Announcement): string {
  const senders = [...new Set(data.messages.map((m) => m.from))];
  const from = senders.length > 0 ? ` from ${senders.join(", ")}` : "";
  const noun = data.count === 1 ? "message" : "messages";
  return `moshi: ${data.count} new ${noun} for ${data.agent}${from}. Read them with mesh_receive.\n\n${JSON.stringify(data)}`;
}

export function requestFor(
  material: WebhookMaterial & { secret: string },
  deliveryId: string,
  data: Announcement,
  now: number,
): { headers: Record<string, string>; body: string } {
  if (material.kind === "claude_routine") {
    return {
      headers: { authorization: `Bearer ${material.secret}`, "anthropic-version": ANTHROPIC_VERSION },
      body: JSON.stringify({ text: routineText(data) }),
    };
  }
  const body = JSON.stringify({ type: "message.created", timestamp: new Date(now).toISOString(), data });
  const seconds = Math.floor(now / 1000);
  const headers =
    material.authMode === "bearer"
      ? { "webhook-id": deliveryId, "webhook-timestamp": String(seconds), authorization: `Bearer ${material.secret}` }
      : signingHeaders(material.secret, deliveryId, seconds, body);
  return { headers, body };
}

export type Verdict =
  | { kind: "ok" }
  | { kind: "defer"; waitSeconds: number; error: string }
  | { kind: "fail"; retryable: boolean; error: string };

export function verdictFor(kind: WebhookMaterial["kind"], result: PostResult): Verdict {
  if (result.ok) return { kind: "ok" };
  if (kind === "webhook") return { kind: "fail", retryable: result.retryable, error: result.error };
  if (result.status === 429 || (result.status === 503 && result.retryAfterSeconds !== undefined)) {
    return { kind: "defer", waitSeconds: result.retryAfterSeconds ?? DEFAULT_WAIT_SECONDS, error: result.error };
  }
  const safe = !result.reached || result.status === 503;
  return { kind: "fail", retryable: result.retryable && safe, error: result.error };
}
