// Failed sign-ins, counted per client (src/services/signin-throttle.ts).

import { describe, it, expect } from "vitest";
import { SignInThrottle, FAILURE_LIMIT, FAILURE_WINDOW_MS, MAX_TRACKED_CLIENTS } from "../../src/services/signin-throttle";

function setup() {
  let now = 1_800_000_000_000;
  const throttle = new SignInThrottle(() => now);
  return { throttle, advance: (ms: number) => { now += ms; } };
}

describe("SignInThrottle", () => {
  it("lets ten failures through and answers the eleventh with how long to wait", () => {
    expect(FAILURE_LIMIT).toBe(10);
    expect(FAILURE_WINDOW_MS).toBe(15 * 60_000);
    const { throttle, advance } = setup();
    for (let i = 0; i < FAILURE_LIMIT; i++) {
      expect(throttle.retryAfter("203.0.113.7"), `attempt ${i + 1}`).toBe(0);
      throttle.fail("203.0.113.7");
      advance(1000);
    }
    // Ten failures, the oldest ten seconds ago: free again in 15 minutes minus 10 seconds.
    expect(throttle.retryAfter("203.0.113.7")).toBe(15 * 60 - 10);
  });

  it("counts per client", () => {
    const { throttle } = setup();
    for (let i = 0; i < FAILURE_LIMIT; i++) throttle.fail("203.0.113.7");
    expect(throttle.retryAfter("203.0.113.7")).toBeGreaterThan(0);
    expect(throttle.retryAfter("203.0.113.8")).toBe(0);
  });

  it("forgets a failure after fifteen minutes, one at a time", () => {
    const { throttle, advance } = setup();
    for (let i = 0; i < FAILURE_LIMIT; i++) { throttle.fail("c"); advance(60_000); }
    expect(throttle.retryAfter("c")).toBe(5 * 60); // the oldest is ten minutes old
    advance(5 * 60_000 - 1);
    expect(throttle.retryAfter("c")).toBe(1);
    advance(1);
    expect(throttle.retryAfter("c")).toBe(0);
    throttle.fail("c");
    expect(throttle.retryAfter("c")).toBe(60); // the next oldest leaves in a minute
  });

  it("says once that a client got throttled, not on every attempt after that", () => {
    const { throttle } = setup();
    const told: boolean[] = [];
    for (let i = 0; i < FAILURE_LIMIT + 5; i++) told.push(throttle.fail("c").justThrottled);
    expect(told.filter(Boolean)).toHaveLength(1);
    expect(told[FAILURE_LIMIT - 1]).toBe(true);
  });

  it("does not keep more failures per client than it needs to decide", () => {
    const { throttle } = setup();
    for (let i = 0; i < 100_000; i++) throttle.fail("c");
    expect(throttle.size()).toBe(1);
    expect(throttle.failuresOf("c")).toBe(FAILURE_LIMIT);
  });

  it("does not grow without bound under a flood of addresses, and drops the quietest first", () => {
    const { throttle, advance } = setup();
    for (let i = 0; i < FAILURE_LIMIT; i++) throttle.fail("the-one-to-remember");
    advance(1000);
    for (let i = 0; i < MAX_TRACKED_CLIENTS + 500; i++) throttle.fail(`198.51.${Math.floor(i / 256) % 256}.${i % 256}-${i}`);
    expect(throttle.size()).toBeLessThanOrEqual(MAX_TRACKED_CLIENTS);
    // A client that is currently throttled is not the one to forget.
    expect(throttle.retryAfter("the-one-to-remember")).toBeGreaterThan(0);
  });

  it("still counts a newcomer when the table is full of clients that were throttled once", () => {
    // 10,000 addresses at ten failures each used to switch the throttle off
    // for good: the newcomer was the only entry with fewer than ten, and the
    // one that was evicted. Nobody new was counted until a restart.
    const { throttle, advance } = setup();
    for (let i = 0; i < MAX_TRACKED_CLIENTS; i++) for (let n = 0; n < FAILURE_LIMIT; n++) throttle.fail(`flood-${i}`);
    for (let n = 0; n < FAILURE_LIMIT; n++) throttle.fail("203.0.113.7");
    expect(throttle.retryAfter("203.0.113.7")).toBeGreaterThan(0);
    expect(throttle.size()).toBeLessThanOrEqual(MAX_TRACKED_CLIENTS);

    advance(24 * 60 * 60_000);
    for (let n = 0; n < FAILURE_LIMIT; n++) throttle.fail("203.0.113.8");
    expect(throttle.retryAfter("203.0.113.8")).toBeGreaterThan(0);
    // What aged out is gone, not kept for ever because it once had ten.
    expect(throttle.size()).toBeLessThan(100);
  });

  it("evicts in strides, not on every insert once it is full", () => {
    const { throttle } = setup();
    for (let i = 0; i < MAX_TRACKED_CLIENTS + 1; i++) throttle.fail(`c-${i}`);
    expect(throttle.size()).toBeLessThanOrEqual(MAX_TRACKED_CLIENTS * 0.9 + 1);
    expect(throttle.failuresOf(`c-${MAX_TRACKED_CLIENTS}`)).toBe(1);
  });

  it("fails open when the clock steps back, and never asks for more than the window", () => {
    const { throttle, advance } = setup();
    for (let n = 0; n < FAILURE_LIMIT; n++) { throttle.fail("c"); advance(1000); }
    expect(throttle.retryAfter("c")).toBe(15 * 60 - 10);
    advance(-2 * 60 * 60_000);
    expect(throttle.retryAfter("c")).toBeLessThanOrEqual(FAILURE_WINDOW_MS / 1000);
    expect(throttle.retryAfter("c")).toBe(0);
  });

  it("is safe with names that are properties of every object", () => {
    const { throttle } = setup();
    for (const name of ["constructor", "__proto__", "toString"]) {
      expect(throttle.retryAfter(name)).toBe(0);
      throttle.fail(name);
      expect(throttle.failuresOf(name)).toBe(1);
    }
  });
});
