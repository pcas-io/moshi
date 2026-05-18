interface Bucket {
  tokens: number;
  lastRefill: number;
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>();

  constructor(
    private maxTokens: number = 60,
    private refillIntervalMs: number = 60_000,
  ) {}

  check(agentName: string): { allowed: boolean; retryAfterSeconds?: number } {
    const now = Date.now();
    let bucket = this.buckets.get(agentName);

    if (!bucket) {
      bucket = { tokens: this.maxTokens, lastRefill: now };
      this.buckets.set(agentName, bucket);
    }

    const elapsed = now - bucket.lastRefill;
    if (elapsed >= this.refillIntervalMs) {
      bucket.tokens = this.maxTokens;
      bucket.lastRefill = now;
    }

    if (bucket.tokens <= 0) {
      const waitMs = this.refillIntervalMs - (now - bucket.lastRefill);
      return { allowed: false, retryAfterSeconds: Math.ceil(waitMs / 1000) };
    }

    bucket.tokens--;
    return { allowed: true };
  }
}
