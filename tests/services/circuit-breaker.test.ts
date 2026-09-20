// The breaker in front of JetStream. Without it a broker that has stopped
// answering costs every call its full timeout, and one agent request makes
// three to five such calls: 15 to 25 seconds per request, measured.

import { describe, it, expect, vi } from "vitest";
import { CircuitBreaker, BrokerUnavailableError } from "../../src/services/circuit-breaker";

function setup(opts: { coolDownMs?: number } = {}) {
  let now = 1_000_000;
  const breaker = new CircuitBreaker({ coolDownMs: opts.coolDownMs ?? 5000, now: () => now });
  return { breaker, advance: (ms: number) => { now += ms; } };
}
const outage = () => Promise.reject(Object.assign(new Error("TIMEOUT"), { code: "TIMEOUT" }));
const isOutage = (err: unknown) => (err as { code?: string }).code === "TIMEOUT";

describe("CircuitBreaker", () => {
  it("passes calls and their results through while the broker answers", async () => {
    const { breaker } = setup();
    await expect(breaker.run(async () => 42, isOutage)).resolves.toBe(42);
    expect(breaker.state()).toBe("closed");
  });

  it("opens on an outage error and then fails fast without calling the broker", async () => {
    const { breaker } = setup();
    await expect(breaker.run(outage, isOutage)).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(breaker.state()).toBe("open");

    let called = 0;
    await expect(breaker.run(async () => { called++; }, isOutage)).rejects.toBeInstanceOf(BrokerUnavailableError);
    expect(called).toBe(0);
  });

  it("does not open for an answer that is an error but proves the broker is there", async () => {
    const { breaker } = setup();
    const notFound = () => Promise.reject(Object.assign(new Error("consumer not found"), { api_error: { err_code: 10014 } }));
    await expect(breaker.run(notFound, isOutage)).rejects.toThrow("consumer not found");
    expect(breaker.state()).toBe("closed");
  });

  it("lets one probe through after the cool-down and closes when it succeeds", async () => {
    const { breaker, advance } = setup({ coolDownMs: 5000 });
    await breaker.run(outage, isOutage).catch(() => {});
    advance(4999);
    await expect(breaker.run(async () => 1, isOutage)).rejects.toBeInstanceOf(BrokerUnavailableError);
    advance(1);
    expect(breaker.state()).toBe("half-open");
    await expect(breaker.run(async () => "back", isOutage)).resolves.toBe("back");
    expect(breaker.state()).toBe("closed");
  });

  it("admits a single probe: concurrent callers fail fast while it is in flight", async () => {
    const { breaker, advance } = setup();
    await breaker.run(outage, isOutage).catch(() => {});
    advance(5000);
    let release!: (v: string) => void;
    const probe = breaker.run(() => new Promise<string>((r) => { release = r; }), isOutage);
    await expect(breaker.run(async () => "second", isOutage)).rejects.toBeInstanceOf(BrokerUnavailableError);
    release("ok");
    await expect(probe).resolves.toBe("ok");
    expect(breaker.state()).toBe("closed");
  });

  it("closes when the probe gets an error that is an answer", async () => {
    const { breaker, advance } = setup();
    await breaker.run(outage, isOutage).catch(() => {});
    advance(5000);
    const notFound = () => Promise.reject(Object.assign(new Error("consumer not found"), { api_error: { err_code: 10014 } }));
    await expect(breaker.run(notFound, isOutage)).rejects.toThrow("consumer not found");
    expect(breaker.state()).toBe("closed");
  });

  it("opens again for a full cool-down when the probe fails", async () => {
    const { breaker, advance } = setup();
    await breaker.run(outage, isOutage).catch(() => {});
    advance(5000);
    await breaker.run(outage, isOutage).catch(() => {});
    expect(breaker.state()).toBe("open");
    advance(4999);
    await expect(breaker.run(async () => 1, isOutage)).rejects.toBeInstanceOf(BrokerUnavailableError);
  });

  it("recovers from a second outage the same way as from the first", async () => {
    // A flag that is never reset passes every single-cycle test and then
    // leaves the breaker failing fast for good.
    const { breaker, advance } = setup();
    for (let cycle = 0; cycle < 3; cycle++) {
      await breaker.run(outage, isOutage).catch(() => {});
      expect(breaker.state(), `cycle ${cycle}`).toBe("open");
      advance(5000);
      await breaker.run(outage, isOutage).catch(() => {}); // the probe fails
      advance(5000);
      await expect(breaker.run(async () => "back", isOutage), `cycle ${cycle}`).resolves.toBe("back");
      expect(breaker.state()).toBe("closed");
    }
  });

  it("closes at once on markUp, also in the middle of a cool-down", async () => {
    const { breaker } = setup();
    await breaker.run(outage, isOutage).catch(() => {});
    expect(breaker.state()).toBe("open");
    breaker.markUp();
    expect(breaker.state()).toBe("closed");
    await expect(breaker.run(async () => 1, isOutage)).resolves.toBe(1);
  });

  it("ignores the late failure of a call that started before the connection came back", async () => {
    // In flight, then disconnect, reconnect, and only then the old call's
    // timeout fires. That outcome says nothing about the new connection.
    const { breaker } = setup();
    let fail!: (err: unknown) => void;
    const old = breaker.run(() => new Promise((_, reject) => { fail = reject; }), isOutage);
    breaker.markDown();
    breaker.markUp();
    fail(Object.assign(new Error("TIMEOUT"), { code: "TIMEOUT" }));
    await old.catch(() => {});
    expect(breaker.state()).toBe("closed");
  });

  it("uses a clock that cannot be set back, unless one is injected", async () => {
    // Date.now follows the wall clock: a VM resume or an NTP step backwards
    // during the cool-down would hold the breaker open for the length of the
    // step. performance.now only ever moves forward.
    const monotonic = vi.spyOn(performance, "now");
    const wall = vi.spyOn(Date, "now");
    try {
      const breaker = new CircuitBreaker({ coolDownMs: 50 });
      await breaker.run(outage, isOutage).catch(() => {});
      breaker.state();
      expect(monotonic).toHaveBeenCalled();
      expect(wall).not.toHaveBeenCalled();
    } finally { monotonic.mockRestore(); wall.mockRestore(); }
  });

  it("can be told from outside: a disconnect opens it for good, a reconnect closes it at once", async () => {
    const { breaker, advance } = setup();
    breaker.markDown();
    advance(60_000); // no probe while the connection is known to be gone
    await expect(breaker.run(async () => 1, isOutage)).rejects.toBeInstanceOf(BrokerUnavailableError);
    breaker.markUp();
    await expect(breaker.run(async () => 1, isOutage)).resolves.toBe(1);
  });

  it("starts down until the first connect, so calls before it fail fast instead of crashing", async () => {
    let now = 0;
    const breaker = new CircuitBreaker({ coolDownMs: 5000, now: () => now, startDown: true });
    await expect(breaker.run(async () => 1, isOutage)).rejects.toBeInstanceOf(BrokerUnavailableError);
    breaker.markUp();
    await expect(breaker.run(async () => 1, isOutage)).resolves.toBe(1);
  });
});
