// Failed sign-ins, counted per client address.
//
// What this is for: a line in the log when somebody tries tokens, a 429 that
// tells a misconfigured client to back off, and an end to unbounded attempts.
// What it is NOT: the thing that keeps a token from being guessed. Tokens
// have well over a hundred bits of entropy.
//
// That decides one design question. A throttled client's VALID credentials
// still pass: only failures are answered with 429. Several agents share one
// address (one machine, one NAT), and one connector with an old token,
// retrying all day, must not lock the others out.

export const FAILURE_LIMIT = 10;
export const FAILURE_WINDOW_MS = 15 * 60_000;
/** A flood of addresses must not become a memory problem. */
export const MAX_TRACKED_CLIENTS = 10_000;

/** When the table is full it is cut down to this, so that a flood pays for
 *  one scan per thousand new clients and not for one per client. */
const EVICT_DOWN_TO = Math.floor(MAX_TRACKED_CLIENTS * 0.9);
/** What has aged out is swept this often at most. */
const SWEEP_EVERY_MS = 60_000;

export class SignInThrottle {
  /** Client -> times of its last failures, oldest first, at most FAILURE_LIMIT. */
  private readonly failures = new Map<string, number[]>();
  private lastSweep = Number.NEGATIVE_INFINITY;

  constructor(private readonly now: () => number = Date.now) {}

  /** Failures that count right now: inside the window, and not from the
   *  future. A clock that steps back would otherwise extend every block by
   *  the size of the step; this way it fails open. */
  private live(times: readonly number[], now: number): number[] {
    const cutoff = now - FAILURE_WINDOW_MS;
    return times.filter((t) => t > cutoff && t <= now);
  }

  private recent(client: string): number[] {
    const times = this.failures.get(client);
    if (!times) return [];
    const kept = this.live(times, this.now());
    if (kept.length === 0) this.failures.delete(client);
    else if (kept.length !== times.length) this.failures.set(client, kept);
    return kept;
  }

  /** Seconds until a failure of this client is answered normally again. 0: now. */
  retryAfter(client: string): number {
    const times = this.recent(client);
    if (times.length < FAILURE_LIMIT) return 0;
    const seconds = Math.ceil((times[0] + FAILURE_WINDOW_MS - this.now()) / 1000);
    return Math.min(FAILURE_WINDOW_MS / 1000, Math.max(1, seconds));
  }

  /** Records a failure. `justThrottled` is true for the one that fills the limit. */
  fail(client: string): { justThrottled: boolean } {
    const now = this.now();
    const times = this.recent(client);
    const wasThrottled = times.length >= FAILURE_LIMIT;
    times.push(now);
    // Only the newest LIMIT decide anything.
    if (times.length > FAILURE_LIMIT) times.splice(0, times.length - FAILURE_LIMIT);
    // Re-insert: a Map keeps insertion order, so the quietest client is first.
    this.failures.delete(client);
    this.failures.set(client, times);
    // `recent()` only ever tidies the client it is asked about. Without this
    // a table of clients that never came back stays full for ever.
    if (now - this.lastSweep >= SWEEP_EVERY_MS || now < this.lastSweep) this.sweep(now, client);
    if (this.failures.size > MAX_TRACKED_CLIENTS) this.evict(now, client);
    return { justThrottled: !wasThrottled && times.length >= FAILURE_LIMIT };
  }

  /** Forgets every client whose failures have all aged out. */
  private sweep(now: number, keep: string): void {
    this.lastSweep = now;
    for (const [client, times] of this.failures) {
      if (client !== keep && this.live(times, now).length === 0) this.failures.delete(client);
    }
  }

  /**
   * Makes room, never at the expense of `keep`, the client that just failed.
   * It used to be the first to go: in a table full of clients with ten
   * failures each, the newcomer was the only one with fewer, so nobody new
   * was ever counted again until a restart.
   */
  private evict(now: number, keep: string): void {
    this.sweep(now, keep);
    // The quietest clients that are not throttled right now.
    for (const [client, times] of this.failures) {
      if (this.failures.size <= EVICT_DOWN_TO) return;
      if (client !== keep && this.live(times, now).length < FAILURE_LIMIT) this.failures.delete(client);
    }
    // Everybody left is throttled: then the oldest go after all.
    for (const client of this.failures.keys()) {
      if (this.failures.size <= EVICT_DOWN_TO) return;
      if (client !== keep) this.failures.delete(client);
    }
  }

  size(): number { return this.failures.size; }
  failuresOf(client: string): number { return this.recent(client).length; }
}
