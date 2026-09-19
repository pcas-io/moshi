// Retention used to run once, inside start(). With deploy-only restarts the
// process plausibly ran for weeks: "30 days" meant "until the next restart",
// and abandoned OAuth flows left plaintext tokens in SQLite just as long.

import { describe, it, expect, vi, afterEach } from "vitest";
import { startMaintenance } from "../../src/services/maintenance";

afterEach(() => vi.useRealTimers());

describe("startMaintenance", () => {
  it("runs every task at once and then on every interval, until stopped", () => {
    vi.useFakeTimers();
    const a = vi.fn(() => 0), b = vi.fn(() => 2);
    const onResult = vi.fn();
    const stop = startMaintenance([{ name: "a", run: a }, { name: "b", run: b }], { intervalMs: 1000, onResult });
    expect(a).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(3000);
    expect(a).toHaveBeenCalledTimes(4);
    expect(b).toHaveBeenCalledTimes(4);
    stop();
    vi.advanceTimersByTime(5000);
    expect(a).toHaveBeenCalledTimes(4);
    // Only work that did something is worth a log line.
    expect(onResult.mock.calls.every(([name]) => name === "b")).toBe(true);
  });

  it("keeps going when one task throws", () => {
    vi.useFakeTimers();
    const boom = vi.fn(() => { throw new Error("db locked"); });
    const ok = vi.fn(() => 0);
    const onError = vi.fn();
    const stop = startMaintenance([{ name: "boom", run: boom }, { name: "ok", run: ok }], { intervalMs: 1000, onError });
    vi.advanceTimersByTime(2000);
    expect(ok).toHaveBeenCalledTimes(3);
    expect(onError).toHaveBeenCalledTimes(3);
    stop();
  });
});
