// presence.touch runs inside the auth middleware, in front of EVERY agent
// request. Its KV write is a liveness hint; the request must not wait for a
// broker that has stopped answering.

import { describe, it, expect, vi, afterEach } from "vitest";
import { initDatabase } from "../../src/services/db";
import { AgentService } from "../../src/services/agent";
import { ActivityService } from "../../src/services/activity";
import { PresenceService, TOUCH_KV_WAIT_MS } from "../../src/services/presence";
import type { NatsPresenceBackend } from "../../src/services/presence";

afterEach(() => vi.useRealTimers());

function setup(updatePresence: NatsPresenceBackend["updatePresence"]) {
  const db = initDatabase(":memory:");
  const agents = new AgentService(db, new ActivityService(db));
  agents.create("scout");
  const nats: NatsPresenceBackend = { updatePresence, getPresence: async () => new Map() };
  return { db, agents, presence: new PresenceService(db, nats) };
}

describe("PresenceService.touch", () => {
  it("returns after a short wait when the KV write never settles", async () => {
    vi.useFakeTimers();
    const { presence, agents } = setup(() => new Promise<void>(() => { /* never */ }));
    let done = false;
    const touching = presence.touch("scout").then(() => { done = true; });

    await vi.advanceTimersByTimeAsync(TOUCH_KV_WAIT_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await touching;
    expect(done).toBe(true);
    // SQLite, the authoritative record, was written before the wait began.
    expect(agents.getByName("scout")!.last_seen_at).not.toBeNull();
    expect(TOUCH_KV_WAIT_MS).toBeLessThanOrEqual(500);
  });

  it("still waits for a KV write that is quick, so the caller sees itself as live", async () => {
    const order: string[] = [];
    const { presence } = setup(async () => { await new Promise((r) => setTimeout(r, 20)); order.push("kv written"); });
    await presence.touch("scout");
    order.push("touch returned");
    expect(order).toEqual(["kv written", "touch returned"]);
  });

  it("does not leave an unhandled rejection behind when the write fails after the wait", async () => {
    vi.useFakeTimers();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const { presence } = setup(() => new Promise<void>((_, reject) => setTimeout(() => reject(new Error("TIMEOUT")), 1500)));
      const touching = presence.touch("scout");
      await vi.advanceTimersByTimeAsync(TOUCH_KV_WAIT_MS);
      await touching;
      await vi.advanceTimersByTimeAsync(2000);
      vi.useRealTimers();
      await new Promise((r) => setTimeout(r, 10));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("swallows a KV failure: auth must not fail on presence bookkeeping", async () => {
    const { presence } = setup(async () => { throw new Error("broker unavailable"); });
    await expect(presence.touch("scout")).resolves.toBeUndefined();
  });
});
