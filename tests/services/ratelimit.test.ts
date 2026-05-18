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
