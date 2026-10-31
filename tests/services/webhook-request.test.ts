// What a call looks like per kind of hook, and what its outcome means
// (src/services/webhook-request.ts). A Claude Code routine starts a session on
// every call that arrives, so it is only called again when nothing arrived.

import { describe, it, expect } from "vitest";
import { requestFor, verdictFor, routineText, ANTHROPIC_VERSION } from "../../src/services/webhook-request";
import type { Announcement } from "../../src/services/webhook-request";
import type { WebhookMaterial } from "../../src/services/webhooks";
import { verifySignature } from "../../src/services/webhook-sign";
import { isClaudeRoutineUrl, parseRetryAfter } from "../../src/services/webhook-target";
import type { PostResult } from "../../src/services/webhook-target";

const ROUTINE_URL = "https://api.anthropic.com/v1/claude_code/routines/trig_01ABCdef/fire";
const NOW = Date.parse("2026-10-31T11:00:00Z");

const data: Announcement = {
  agent: "scout",
  inbox_pending: 2,
  count: 2,
  truncated: false,
  messages: [
    { message_id: "msg_1", from: "worky", to: "scout", type: "question", priority: "normal", correlation_id: null, created_at: "2026-10-31T10:59:00Z" },
    { message_id: "msg_2", from: "kate", to: "scout", type: "task_update", priority: "high", correlation_id: "msg_1", created_at: "2026-10-31T10:59:30Z" },
  ],
};

const material = (over: Partial<WebhookMaterial> = {}): WebhookMaterial & { secret: string } => ({
  agentName: "scout", kind: "webhook", url: "https://hooks.example.com/t", authMode: "standard_webhooks",
  secret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw", ...over,
} as WebhookMaterial & { secret: string });

const failed = (over: Partial<Extract<PostResult, { ok: false }>>): PostResult =>
  ({ ok: false, retryable: true, reached: true, error: "x", ...over });

describe("isClaudeRoutineUrl", () => {
  it("knows a routine's API trigger and nothing else", () => {
    expect(isClaudeRoutineUrl(ROUTINE_URL)).toBe(true);
    for (const other of [
      "https://api.anthropic.com/v1/messages",
      "https://api.anthropic.com/v1/claude_code/routines/trig_1/fire?x=1",
      "https://api.anthropic.com.evil.example/v1/claude_code/routines/trig_1/fire",
      "http://api.anthropic.com/v1/claude_code/routines/trig_1/fire",
      "https://hooks.example.com/v1/claude_code/routines/trig_1/fire",
      "not a url",
    ]) {
      expect(isClaudeRoutineUrl(other), other).toBe(false);
    }
  });
});

describe("parseRetryAfter", () => {
  it("reads seconds and HTTP dates, caps at an hour, ignores junk", () => {
    expect(parseRetryAfter("120")).toBe(120);
    expect(parseRetryAfter(new Date(NOW + 90_000).toUTCString(), NOW)).toBe(90);
    expect(parseRetryAfter("86400")).toBe(3600);
    expect(parseRetryAfter("soon")).toBeUndefined();
    expect(parseRetryAfter(undefined)).toBeUndefined();
  });
});

describe("requestFor", () => {
  it("calls a routine with its token, the API version and {text}, no webhook headers", () => {
    const { headers, body } = requestFor(material({ kind: "claude_routine", url: ROUTINE_URL, authMode: "bearer", secret: "test-routine-token-abc" }), "wh_1", data, NOW);
    expect(headers).toEqual({ authorization: "Bearer test-routine-token-abc", "anthropic-version": ANTHROPIC_VERSION });
    const parsed = JSON.parse(body) as { text: string };
    expect(Object.keys(parsed)).toEqual(["text"]);
    expect(parsed.text.split("\n\n")[0]).toBe("moshi: 2 new messages for scout from worky, kate. Read them with mesh_receive.");
    expect(JSON.parse(parsed.text.split("\n\n")[1])).toEqual(data);
  });

  it("still signs a webhook after Standard Webhooks", () => {
    const { headers, body } = requestFor(material(), "wh_1", data, NOW);
    expect(JSON.parse(body)).toEqual({ type: "message.created", timestamp: new Date(NOW).toISOString(), data });
    expect(verifySignature("whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw", headers, body, NOW / 1000)).toBe(true);
  });

  it("says one message in the singular", () => {
    expect(routineText({ ...data, count: 1, messages: data.messages.slice(0, 1) })).toMatch(/^moshi: 1 new message for scout from worky\./);
  });
});

describe("verdictFor a routine", () => {
  it("waits as long as a busy routine says, without counting it", () => {
    expect(verdictFor("claude_routine", failed({ status: 429, retryAfterSeconds: 120, error: "HTTP 429" })))
      .toEqual({ kind: "defer", waitSeconds: 120, error: "HTTP 429" });
    expect(verdictFor("claude_routine", failed({ status: 429, error: "HTTP 429" }))).toMatchObject({ kind: "defer", waitSeconds: 60 });
    expect(verdictFor("claude_routine", failed({ status: 503, retryAfterSeconds: 30 }))).toMatchObject({ kind: "defer", waitSeconds: 30 });
  });

  it("calls again only when nothing can have started: not reached, or overloaded", () => {
    expect(verdictFor("claude_routine", failed({ reached: false, error: "ECONNREFUSED" }))).toMatchObject({ kind: "fail", retryable: true });
    expect(verdictFor("claude_routine", failed({ status: 503 }))).toMatchObject({ kind: "fail", retryable: true });
  });

  it("does not call again after a timeout or a 500: a session may have started", () => {
    expect(verdictFor("claude_routine", failed({ error: "timeout after 5000 ms" }))).toMatchObject({ kind: "fail", retryable: false });
    expect(verdictFor("claude_routine", failed({ status: 500 }))).toMatchObject({ kind: "fail", retryable: false });
  });

  it("leaves a webhook's verdict as the poster gave it", () => {
    expect(verdictFor("webhook", failed({ status: 500 }))).toMatchObject({ kind: "fail", retryable: true });
    expect(verdictFor("webhook", failed({ status: 429, retryAfterSeconds: 120 }))).toMatchObject({ kind: "fail", retryable: true });
  });
});
