// A circuit breaker for calls to a broker that may have stopped answering.
//
// closed     calls go through. An outage error opens the breaker.
// open       calls fail at once with BrokerUnavailableError, until the
//            cool-down is over.
// half-open  the cool-down is over: exactly one call goes through as a probe.
//            Success closes the breaker, an outage error opens it again.
//
// "Down" is a separate, externally set condition (the connection is known to
// be gone): no probes at all until markUp(). Pure logic, clock injected
// (monotonic by default).

export class BrokerUnavailableError extends Error {
  constructor(message = "broker unavailable") {
    super(message);
    this.name = "BrokerUnavailableError";
  }
}

export type BreakerState = "closed" | "open" | "half-open";

export interface CircuitBreakerOptions {
  /** How long to fail fast after an outage error before probing again. */
  coolDownMs: number;
  now?: () => number;
  /** Start in the "down" condition — for a client that has not connected yet. */
  startDown?: boolean;
}

export class CircuitBreaker {
  private readonly coolDownMs: number;
  private readonly now: () => number;
  private down: boolean;
  private openUntil = 0;
  private probing = false;
  /** Counts markUp() calls. A call that started before the connection came
   *  back says nothing about the new connection when it finally fails. */
  private generation = 0;

  constructor(opts: CircuitBreakerOptions) {
    this.coolDownMs = opts.coolDownMs;
    // Monotonic by default. Date.now follows the wall clock, and a step
    // backwards during a cool-down would hold the breaker open for as long
    // as the step was.
    this.now = opts.now ?? (() => performance.now());
    this.down = opts.startDown ?? false;
  }

  state(): BreakerState {
    if (this.down) return "open";
    if (this.openUntil === 0) return "closed";
    return this.now() < this.openUntil ? "open" : "half-open";
  }

  /** The connection is known to be gone. No probes until markUp(). */
  markDown(): void {
    this.down = true;
  }

  /** The connection is (back) up: close at once, whatever came before. */
  markUp(): void {
    this.generation++;
    this.down = false;
    this.openUntil = 0;
    this.probing = false;
  }

  /**
   * Run `fn` unless the breaker says the broker is not answering.
   * `isOutage` tells an outage (timeout, connection lost) from an error that
   * is an answer ("consumer not found"): only the former opens the breaker.
   */
  async run<T>(fn: () => Promise<T>, isOutage: (err: unknown) => boolean): Promise<T> {
    const state = this.state();
    if (state === "open" || (state === "half-open" && this.probing)) {
      throw new BrokerUnavailableError();
    }
    const isProbe = state === "half-open";
    const generation = this.generation;
    if (isProbe) this.probing = true;
    try {
      const result = await fn();
      if (isProbe && generation === this.generation) this.openUntil = 0;
      return result;
    } catch (err) {
      // Only the outcome of a call on the CURRENT connection counts.
      if (generation === this.generation) {
        if (isOutage(err)) this.openUntil = this.now() + this.coolDownMs;
        else if (isProbe) this.openUntil = 0; // an error that is an answer: the broker is there
      }
      throw err;
    } finally {
      if (isProbe && generation === this.generation) this.probing = false;
    }
  }
}
