// NatsService with fake clients: the decisions it makes around the broker,
// without a broker. tests/integration covers the same service against a real
// one, but a frozen container never drops its connection, so nothing there
// can show what happens on disconnect and reconnect.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NatsService, BrokerUnavailableError } from "../../src/services/nats";

const timeout = () => Object.assign(new Error("TIMEOUT"), { code: "TIMEOUT" });
const noResponders = () => Object.assign(new Error("no responders"), { code: "503" });
const notFound = () => Object.assign(new Error("consumer not found"), { api_error: { err_code: 10014 } });

function statusFeed() {
  const waiting: ((v: IteratorResult<{ type: string; data?: string }>) => void)[] = [];
  const queued: { type: string }[] = [];
  return {
    push(type: string) {
      const next = waiting.shift();
      if (next) next({ value: { type }, done: false }); else queued.push({ type });
    },
    iterator: {
      [Symbol.asyncIterator]() { return this; },
      next(): Promise<IteratorResult<{ type: string }>> {
        const q = queued.shift();
        if (q) return Promise.resolve({ value: q, done: false });
        return new Promise((resolve) => waiting.push(resolve));
      },
    },
  };
}

function setup() {
  const feed = statusFeed();
  const durables = new Set<string>();
  let closed = false;
  const nc = {
    status: () => feed.iterator,
    flush: vi.fn(async () => {}),
    isClosed: () => closed,
    close: vi.fn(async () => { closed = true; }),
    drain: vi.fn(async () => { if (closed) throw Object.assign(new Error("CONNECTION_CLOSED"), { code: "CONNECTION_CLOSED" }); closed = true; }),
  };
  const consumer = { info: vi.fn(async () => ({ num_pending: 0, num_ack_pending: 0 })), fetch: vi.fn() };
  const js = {
    publish: vi.fn(async () => ({ seq: 1, duplicate: false })),
    consumers: { get: vi.fn(async (_s: string, name: string) => { if (!durables.has(name)) throw notFound(); return consumer; }) },
  };
  const jsm = {
    consumers: {
      info: vi.fn(async (_s: string, name: string) => { if (!durables.has(name)) throw notFound(); return {}; }),
      add: vi.fn(async (_s: string, cfg: { durable_name: string }) => { durables.add(cfg.durable_name); return {}; }),
      delete: vi.fn(async (_s: string, name: string) => { if (!durables.delete(name)) throw notFound(); return true; }),
    },
    streams: { info: vi.fn(async () => ({ state: { bytes: 0, messages: 0 }, config: {} })) },
  };
  const kv = { put: vi.fn(async () => 1), get: vi.fn(async () => null) };
  const service = new NatsService("nats://unused.invalid:4222");
  service.attach({ nc, js, jsm, kv } as never);
  return { service, feed, nc, js, jsm, kv, durables, close: () => { closed = true; } };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("NatsService — what opens the breaker", () => {
  it("fails fast before anything is attached, instead of dereferencing a client that is not there", async () => {
    const fresh = new NatsService("nats://unused.invalid:4222");
    await expect(fresh.publish("mesh.broadcast", new Uint8Array(), "m")).rejects.toBeInstanceOf(BrokerUnavailableError);
    expect(await fresh.ping()).toBe(false);
    await expect(fresh.close()).resolves.toBeUndefined();
  });

  it("opens on a timeout from the presence bucket, so the calls behind it fail fast", async () => {
    const t = setup();
    t.kv.put.mockRejectedValueOnce(timeout());
    await expect(t.service.updatePresence("a", {})).rejects.toMatchObject({ code: "TIMEOUT" });
    await expect(t.service.publish("mesh.broadcast", new Uint8Array(), "m")).rejects.toBeInstanceOf(BrokerUnavailableError);
    expect(t.js.publish).not.toHaveBeenCalled();
  });

  it("does NOT switch messaging off when only the presence bucket is unavailable", async () => {
    // 503 on the bucket means the bucket is gone, not the broker. Presence is
    // a hint; it must not take delivery down with it.
    const t = setup();
    t.kv.put.mockRejectedValue(noResponders());
    t.kv.get.mockRejectedValue(noResponders());
    await expect(t.service.updatePresence("a", {})).rejects.toMatchObject({ code: "503" });
    await expect(t.service.getPresence(["a"])).rejects.toMatchObject({ code: "503" });
    await expect(t.service.publish("mesh.broadcast", new Uint8Array(), "m")).resolves.toEqual({ seq: 1, duplicate: false });
    expect(t.js.publish).toHaveBeenCalledTimes(1);
  });

  it("passes an outage on from getPresence, and reads anything else as 'not live'", async () => {
    const t = setup();
    t.kv.get.mockRejectedValueOnce(new Error("unparseable entry"));
    expect((await t.service.getPresence(["a"])).size).toBe(0);
    t.kv.get.mockRejectedValueOnce(timeout());
    await expect(t.service.getPresence(["a"])).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("gives a publish more room than a read: the outcome of a timed-out publish is unknown", async () => {
    const t = setup();
    await t.service.publish("mesh.agents.a.inbox", new Uint8Array([1]), "msg_1");
    expect(t.js.publish).toHaveBeenCalledWith("mesh.agents.a.inbox", expect.anything(), { msgID: "msg_1", timeout: 4000 });
  });
});

describe("NatsService — connection events", () => {
  it("holds the breaker open from disconnect to reconnect, and trusts no remembered consumer afterwards", async () => {
    const t = setup();
    await t.service.ensureConsumer("scout");
    expect(t.jsm.consumers.add).toHaveBeenCalledTimes(2);

    t.feed.push("disconnect");
    await tick();
    await expect(t.service.publish("mesh.broadcast", new Uint8Array(), "m")).rejects.toBeInstanceOf(BrokerUnavailableError);
    expect(await t.service.ping()).toBe(false);

    t.feed.push("reconnect");
    await tick();
    await expect(t.service.publish("mesh.broadcast", new Uint8Array(), "m")).resolves.toEqual({ seq: 1, duplicate: false });
    t.jsm.consumers.info.mockClear();
    await t.service.ensureConsumer("scout");
    expect(t.jsm.consumers.info).toHaveBeenCalledTimes(2); // asked again: the broker may be a fresh one
  });

  it("treats a stale connection like a disconnect", async () => {
    const t = setup();
    t.feed.push("staleConnection");
    await tick();
    await expect(t.service.publish("mesh.broadcast", new Uint8Array(), "m")).rejects.toBeInstanceOf(BrokerUnavailableError);
  });

  it("ignores the events of a connection it has replaced", async () => {
    // A retried connect() leaves the old connection's status loop running
    // until that connection closes. Its late 'reconnect' must not mark a
    // half-made new connection as up.
    const old = setup();
    const next = setup();
    old.service.attach({ nc: next.nc, js: next.js, jsm: next.jsm, kv: next.kv } as never);
    old.feed.push("disconnect"); // from the replaced connection
    await tick();
    await expect(old.service.publish("mesh.broadcast", new Uint8Array(), "m")).resolves.toEqual({ seq: 1, duplicate: false });
  });
});

describe("NatsService — consumers", () => {
  it("does not count a remembered consumer as proof that the broker is back", async () => {
    vi.useFakeTimers();
    try {
      const t = setup();
      await t.service.ensureConsumer("scout");
      t.js.publish.mockRejectedValueOnce(timeout());
      await t.service.publish("mesh.broadcast", new Uint8Array(), "m1").catch(() => {});
      await vi.advanceTimersByTimeAsync(5000); // half-open now
      await t.service.ensureConsumer("scout"); // answered from memory
      t.js.publish.mockRejectedValueOnce(timeout());
      // The publish is the probe. Had the memory hit closed the breaker, this
      // call would be an ordinary one and the next would go through as well.
      await t.service.publish("mesh.broadcast", new Uint8Array(), "m2").catch(() => {});
      await expect(t.service.publish("mesh.broadcast", new Uint8Array(), "m3")).rejects.toBeInstanceOf(BrokerUnavailableError);
    } finally { vi.useRealTimers(); }
  });

  it("looks again after a pull found a durable missing, instead of reporting an empty inbox for good", async () => {
    const t = setup();
    await t.service.ensureConsumer("scout");
    t.durables.clear(); // deleted behind the service's back, connection still up
    const pull = await t.service.pullInbox("scout", 10);
    expect(pull.missing).toBe(true);
    t.jsm.consumers.add.mockClear();
    await t.service.ensureConsumer("scout");
    expect(t.jsm.consumers.add).toHaveBeenCalledTimes(2); // healed on the next request

    t.durables.clear();
    expect((await t.service.inboxPending("scout")).missing).toBe(true);
    t.jsm.consumers.add.mockClear();
    await t.service.ensureConsumer("scout");
    expect(t.jsm.consumers.add).toHaveBeenCalledTimes(2);
  });

  it("deleteConsumer: not found is fine, an outage is reported", async () => {
    const t = setup();
    await expect(t.service.deleteConsumer("nobody")).resolves.toBeUndefined();
    await t.service.ensureConsumer("scout");
    t.jsm.consumers.delete.mockRejectedValueOnce(timeout());
    await expect(t.service.deleteConsumer("scout")).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("finishes a delete the outage swallowed, before the key is used again", async () => {
    // Otherwise the durables of a deleted agent survive, and a new agent
    // that is given the same key reads the old one's mail.
    vi.useFakeTimers();
    try {
      const t = setup();
      await t.service.ensureConsumer("scout");
      t.jsm.consumers.delete.mockRejectedValueOnce(timeout());
      await t.service.deleteConsumer("scout").catch(() => {});
      expect(t.durables.size).toBe(2); // still there
      await vi.advanceTimersByTimeAsync(5000);
      t.jsm.consumers.delete.mockClear();
      t.jsm.consumers.add.mockClear();
      await t.service.ensureConsumer("scout");
      expect(t.jsm.consumers.delete).toHaveBeenCalledTimes(2); // old ones removed first
      expect(t.jsm.consumers.add).toHaveBeenCalledTimes(2);    // then fresh ones
    } finally { vi.useRealTimers(); }
  });
});

describe("NatsService — close", () => {
  afterEach(() => vi.useRealTimers());

  it("resolves when the connection is already closed", async () => {
    const t = setup();
    t.close();
    await expect(t.service.close()).resolves.toBeUndefined();
    expect(t.nc.drain).not.toHaveBeenCalled();
  });

  it("does not wait forever for a drain against a broker that does not answer", async () => {
    vi.useFakeTimers();
    const t = setup();
    t.nc.drain.mockImplementation(() => new Promise<void>(() => { /* never */ }));
    let done = false;
    const closing = t.service.close().then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(2999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await closing;
    expect(done).toBe(true);
  });
});

describe("NatsService — what it hands on to the registry and to the pull", () => {
  it("creates a new agent's durables from its inbox_since", async () => {
    const t = setup();
    await t.service.ensureConsumer("scout", "2026-09-20T10:00:00.000Z");
    expect(t.jsm.consumers.add.mock.calls.map(([, cfg]) => cfg)).toEqual([
      expect.objectContaining({ durable_name: "agent-scout", deliver_policy: "by_start_time", opt_start_time: "2026-09-20T10:00:00.000Z" }),
      expect.objectContaining({ durable_name: "agent-scout-broadcast", deliver_policy: "by_start_time", opt_start_time: "2026-09-20T10:00:00.000Z" }),
    ]);
  });

  it("lets the caller's drop rule see every message of a pull", async () => {
    const t = setup();
    await t.service.ensureConsumer("scout");
    const bytes = new TextEncoder().encode("x");
    let left = 1;
    t.js.consumers.get.mockImplementation(async (_s: string, name: string) => ({
      info: async () => ({ num_pending: name === "agent-scout" ? left : 0, num_ack_pending: 0, delivered: { stream_seq: 0 } }),
      fetch: async () => { left = 0; return { async *[Symbol.asyncIterator]() { yield { data: bytes, seq: 1, ack: () => {} }; } }; },
    }) as never);
    const seen: string[] = [];
    const pull = await t.service.pullInbox("scout", 10, { drop: (_d, side) => { seen.push(side); return true; } });
    expect(seen).toEqual(["inbox"]);
    expect(pull.messages).toEqual([]);
    expect(pull.dropped).toBe(1);
  });

  it("asks for the stream's bounds while broadcasts wait, and only then", async () => {
    const t = setup();
    await t.service.ensureConsumer("scout");
    let waitingBroadcasts = 0;
    t.js.consumers.get.mockImplementation(async (_s: string, name: string) => ({
      info: async () => ({ num_pending: name.endsWith("-broadcast") ? waitingBroadcasts : 0, num_ack_pending: 0, delivered: { stream_seq: 7 } }),
      fetch: async () => ({ async *[Symbol.asyncIterator]() { /* nothing */ } }),
    }) as never);
    t.jsm.streams.info.mockResolvedValue({ created: "2026-09-01T00:00:00.000000000Z", state: { first_seq: 3, last_seq: 9, bytes: 0, messages: 0 }, config: {} } as never);

    expect((await t.service.inboxPending("scout")).stream).toBeNull();
    expect(t.jsm.streams.info).not.toHaveBeenCalled();

    waitingBroadcasts = 2;
    expect(await t.service.inboxPending("scout")).toMatchObject({
      broadcast: 2, broadcastDeliveredSeq: 7,
      stream: { created: "2026-09-01T00:00:00.000000000Z", firstSeq: 3, lastSeq: 9 },
    });
    // Cannot be had: no bounds, and the caller then subtracts nothing.
    t.jsm.streams.info.mockRejectedValueOnce(Object.assign(new Error("TIMEOUT"), { code: "TIMEOUT" }));
    expect((await t.service.inboxPending("scout")).stream).toBeNull();
  });

  it("replaces a left-behind durable only when it is told to", async () => {
    const t = setup();
    t.durables.add("agent-scout");
    t.durables.add("agent-scout-broadcast");
    t.jsm.consumers.info.mockImplementation(async (_s: string, name: string) => { if (!t.durables.has(name)) throw Object.assign(new Error("consumer not found"), { api_error: { err_code: 10014 } }); return { created: "2026-08-01T00:00:00.000000000Z" }; });
    await t.service.ensureConsumer("scout", "2026-09-20T10:00:00.000Z");
    expect(t.jsm.consumers.delete).not.toHaveBeenCalled();
    t.feed.push("reconnect"); // forget what was ensured
    await new Promise((r) => setTimeout(r, 0));
    await t.service.ensureConsumer("scout", "2026-09-20T10:00:00.000Z", { replaceLeftBehind: true });
    expect(t.jsm.consumers.delete).toHaveBeenCalledTimes(2);
  });
});

