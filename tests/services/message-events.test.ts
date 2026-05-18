import { describe, it, expect, beforeEach } from "vitest";
import {
  publishMessageEvent,
  subscribeMessageEvents,
  _resetMessageEventsForTest,
} from "../../src/services/message-events";
import type { Message } from "../../src/types";

function fixtureMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "msg_test",
    from: "alice",
    to: "bob",
    type: "info",
    payload: "{}",
    context: "ctx",
    correlation_id: null,
    reply_to: null,
    priority: "normal",
    ttl_seconds: 86400,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("message-events", () => {
  beforeEach(() => { _resetMessageEventsForTest(); });

  it("delivers an event to a single subscriber", () => {
    const seen: Message[] = [];
    subscribeMessageEvents((m) => seen.push(m));
    const msg = fixtureMessage();
    publishMessageEvent(msg);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.id).toBe("msg_test");
  });

  it("fans out to multiple subscribers", () => {
    let a = 0, b = 0, c = 0;
    subscribeMessageEvents(() => a++);
    subscribeMessageEvents(() => b++);
    subscribeMessageEvents(() => c++);
    publishMessageEvent(fixtureMessage());
    expect(a).toBe(1);
    expect(b).toBe(1);
    expect(c).toBe(1);
  });

  it("stops delivering after unsubscribe", () => {
    let count = 0;
    const off = subscribeMessageEvents(() => count++);
    publishMessageEvent(fixtureMessage());
    off();
    publishMessageEvent(fixtureMessage());
    expect(count).toBe(1);
  });

  it("a throwing subscriber does not stop other subscribers", () => {
    let later = 0;
    subscribeMessageEvents(() => { throw new Error("boom"); });
    subscribeMessageEvents(() => later++);
    expect(() => publishMessageEvent(fixtureMessage())).not.toThrow();
    expect(later).toBe(1);
  });

  it("does nothing when no listeners are registered", () => {
    expect(() => publishMessageEvent(fixtureMessage())).not.toThrow();
  });
});
