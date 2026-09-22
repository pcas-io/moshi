import { describe, it, expect } from "vitest";
import { RateLimiter } from "../../src/services/ratelimit";

describe("RateLimiter", () => {
  it("allows requests under the limit", () => {
    const limiter = new RateLimiter(5, 60_000);

    for (let i = 0; i < 5; i++) {
      const result = limiter.check("agent-a");
      expect(result.allowed).toBe(true);
      expect(result.retryAfterSeconds).toBeUndefined();
    }
  });

  it("blocks requests over the limit", () => {
    const limiter = new RateLimiter(3, 60_000);

    // Use up all tokens
    for (let i = 0; i < 3; i++) {
      limiter.check("agent-a");
    }

    const result = limiter.check("agent-a");
    expect(result.allowed).toBe(false);
    expect(result.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("tracks agents independently", () => {
    const limiter = new RateLimiter(2, 60_000);

    // Use up agent-a's tokens
    limiter.check("agent-a");
    limiter.check("agent-a");
    const blockedA = limiter.check("agent-a");
    expect(blockedA.allowed).toBe(false);

    // agent-b should still have tokens
    const allowedB = limiter.check("agent-b");
    expect(allowedB.allowed).toBe(true);
  });

  it("refills tokens after interval", () => {
    const limiter = new RateLimiter(2, 100); // 100ms refill

    limiter.check("agent-a");
    limiter.check("agent-a");

    const blocked = limiter.check("agent-a");
    expect(blocked.allowed).toBe(false);

    // Wait for refill — we manipulate the bucket by calling after interval
    // Use a synchronous approach: just wait slightly over 100ms
    const start = Date.now();
    while (Date.now() - start < 110) {
      // busy wait
    }

    const result = limiter.check("agent-a");
    expect(result.allowed).toBe(true);
  });
});

// The limiter used to be a fixed window: the bucket was filled to the brim
// once a minute. One message at 0:00, 59 at 0:59 and 60 at 1:00 made 119
// messages inside one second, twice what "60 per minute" says.
describe("RateLimiter — a token bucket, not a window", () => {
  const at = (start = 0) => {
    const clock = { now: start };
    return { clock, limiter: new RateLimiter(60, 60_000, () => clock.now) };
  };
  const take = (limiter: RateLimiter, n: number, key = "alpha") => {
    let allowed = 0;
    for (let i = 0; i < n; i++) if (limiter.check(key).allowed) allowed++;
    return allowed;
  };

  it("has no window edge to burst across", () => {
    const { clock, limiter } = at();
    expect(take(limiter, 1)).toBe(1);
    clock.now = 59_000;
    expect(take(limiter, 59)).toBe(59);
    clock.now = 60_000;
    // One second later one token is back, plus the one that was never used.
    expect(take(limiter, 60)).toBe(2);
  });

  it("refills one token a second, not sixty a minute", () => {
    const { clock, limiter } = at();
    expect(take(limiter, 60)).toBe(60);
    expect(limiter.check("alpha").allowed).toBe(false);
    clock.now = 1_000;
    expect(take(limiter, 5)).toBe(1);
    clock.now = 11_000;
    expect(take(limiter, 50)).toBe(10);
  });

  it("says how long until the next token, not until the next minute", () => {
    const { clock, limiter } = at();
    take(limiter, 60);
    expect(limiter.check("alpha")).toEqual({ allowed: false, retryAfterSeconds: 1 });
    clock.now = 400;
    expect(limiter.check("alpha")).toEqual({ allowed: false, retryAfterSeconds: 1 });
  });

  it("keeps the part of a token that has not been used yet", () => {
    const { clock, limiter } = at();
    take(limiter, 60);
    clock.now = 1_500;
    expect(take(limiter, 3)).toBe(1);
    clock.now = 2_000; // the half token from before, and half a second more
    expect(take(limiter, 3)).toBe(1);
  });

  it("never holds more than its capacity, however long it was idle", () => {
    const { clock, limiter } = at();
    take(limiter, 10);
    clock.now = 24 * 60 * 60_000;
    expect(take(limiter, 200)).toBe(60);
  });

  it("does not go backwards with a clock that does", () => {
    const { clock, limiter } = at(10_000);
    take(limiter, 60);
    clock.now = 5_000;
    expect(limiter.check("alpha").allowed).toBe(false);
    clock.now = 11_000;
    expect(take(limiter, 5)).toBe(1);
  });
});
