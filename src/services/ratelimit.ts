// A token bucket per key: `capacity` tokens at most, refilled evenly over
// `refillIntervalMs`. With the defaults that is a burst of 60 and one more
// message a second after it.
//
// This used to be a fixed window (full again once a minute, counted from the
// first use): one message at 0:00, 59 at 0:59 and 60 at 1:00 went through,
// 119 inside a second.
//
// The key is the agent's inbox key, not its name: a rename does not hand out
// a fresh bucket.

interface Bucket {
  tokens: number;
  /** When `tokens` was last brought up to date. */
  at: number;
}

export interface RateCheck {
  allowed: boolean;
  /** Whole seconds until one token is there. Only when `allowed` is false. */
  retryAfterSeconds?: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly perMs: number;

  /** The default clock is monotonic: on the wall clock a step back refused
   *  every agent for the length of the step, each refusal saying "1 second". */
  constructor(
    private readonly capacity: number = 60,
    refillIntervalMs: number = 60_000,
    private readonly now: () => number = () => performance.now(),
  ) {
    this.perMs = capacity / refillIntervalMs;
  }

  /** Takes one token when there is one. Call it when everything else about
   *  the request has been checked: a refused request costs nothing. */
  check(key: string): RateCheck {
    const now = this.now();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: this.capacity, at: now };
      this.buckets.set(key, bucket);
    }

    // A clock that steps back refills nothing, and is not remembered: the
    // time until it has caught up would otherwise count twice.
    const elapsed = now - bucket.at;
    if (elapsed > 0) {
      bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsed * this.perMs);
      bucket.at = now;
    }

    if (bucket.tokens < 1) {
      const waitMs = (1 - bucket.tokens) / this.perMs;
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)) };
    }

    bucket.tokens -= 1;
    return { allowed: true };
  }
}
