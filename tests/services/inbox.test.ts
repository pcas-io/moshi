import { describe, it, expect } from "vitest";
import {
  pullInbox,
  inboxPending,
  isConsumerNotFound,
  inboxConsumerName,
  broadcastConsumerName,
} from "../../src/services/inbox";
import type { ConsumerSource, PullConsumer } from "../../src/services/inbox";

interface FakeConsumer extends PullConsumer {
  fetchCalls: { max_messages: number; expires: number }[];
  queue: Uint8Array[];
  acked: number;
}

function fakeConsumer(queue: string[]): FakeConsumer {
  const enc = new TextEncoder();
  const self: FakeConsumer = {
    fetchCalls: [],
    queue: queue.map((s) => enc.encode(s)),
    acked: 0,
    async info() {
      return { num_pending: self.queue.length, num_ack_pending: 0 };
    },
    async fetch(opts) {
      self.fetchCalls.push(opts);
      const batch = self.queue.splice(0, opts.max_messages);
      return {
        async *[Symbol.asyncIterator]() {
          for (const data of batch) {
            yield { data, ack: () => { self.acked++; } };
          }
        },
      };
    },
  };
  return self;
}

function notFoundError(): Error {
  const err = new Error("consumer not found") as Error & { api_error: { err_code: number } };
  err.api_error = { err_code: 10014 };
  return err;
}

function source(map: Record<string, FakeConsumer | Error>): ConsumerSource {
  return {
    async get(name) {
      const c = map[name];
      if (!c) throw notFoundError();
      if (c instanceof Error) throw c;
      return c;
    },
  };
}

describe("pullInbox", () => {
  it("never fetches from a consumer with nothing pending (D1)", async () => {
    const inbox = fakeConsumer([]);
    const bc = fakeConsumer([]);
    const src = source({ [inboxConsumerName("Alpha")]: inbox, [broadcastConsumerName("Alpha")]: bc });
    const res = await pullInbox(src, "Alpha", 10);
    expect(res.messages).toEqual([]);
    expect(res.remaining).toBe(0);
    expect(inbox.fetchCalls).toEqual([]);
    expect(bc.fetchCalls).toEqual([]);
  });

  it("sizes the fetch to what is pending so it returns without waiting for the deadline", async () => {
    const inbox = fakeConsumer(["a", "b", "c"]);
    const src = source({ [inboxConsumerName("alpha")]: inbox });
    const res = await pullInbox(src, "alpha", 10);
    expect(inbox.fetchCalls).toEqual([{ max_messages: 3, expires: 2000 }]);
    expect(res.messages).toHaveLength(3);
    expect(res.remaining).toBe(0);
  });

  it("shares the limit between inbox and broadcast and reports the rest (D5)", async () => {
    const inbox = fakeConsumer(["i1", "i2", "i3"]);
    const bc = fakeConsumer(["b1", "b2", "b3"]);
    const src = source({ [inboxConsumerName("alpha")]: inbox, [broadcastConsumerName("alpha")]: bc });
    const res = await pullInbox(src, "alpha", 4);
    expect(inbox.fetchCalls).toEqual([{ max_messages: 3, expires: 2000 }]);
    expect(bc.fetchCalls).toEqual([{ max_messages: 1, expires: 1000 }]);
    expect(res.messages).toHaveLength(4);
    expect(res.remaining).toBe(2);
  });

  it("skips the broadcast consumer entirely when the inbox used up the limit", async () => {
    const inbox = fakeConsumer(["i1", "i2"]);
    const bc = fakeConsumer(["b1"]);
    const src = source({ [inboxConsumerName("alpha")]: inbox, [broadcastConsumerName("alpha")]: bc });
    const res = await pullInbox(src, "alpha", 2);
    expect(bc.fetchCalls).toEqual([]);
    expect(res.messages).toHaveLength(2);
    expect(res.remaining).toBe(1);
  });

  it("treats a missing consumer as empty, but propagates broker errors", async () => {
    const onlyInbox = source({ [inboxConsumerName("alpha")]: fakeConsumer(["x"]) });
    const res = await pullInbox(onlyInbox, "alpha", 5);
    expect(res.messages).toHaveLength(1);

    const broken = source({ [inboxConsumerName("alpha")]: new Error("nats: timeout") });
    await expect(pullInbox(broken, "alpha", 5)).rejects.toThrow("timeout");
  });

  it("acks through to the underlying message", async () => {
    const inbox = fakeConsumer(["a"]);
    const src = source({ [inboxConsumerName("alpha")]: inbox });
    const res = await pullInbox(src, "alpha", 5);
    res.messages[0].ack();
    expect(inbox.acked).toBe(1);
  });
});

describe("a durable that is not there", () => {
  // The service remembers which keys it has ensured. When a durable vanishes
  // behind its back, "empty inbox" is the wrong answer to keep giving: the
  // pull has to say that something is missing, so the service can look again.
  it("reports a missing consumer instead of passing it off as an empty inbox", async () => {
    const bc = fakeConsumer(["b1"]);
    const onlyBroadcast = source({ [broadcastConsumerName("alpha")]: bc });
    const pull = await pullInbox(onlyBroadcast, "alpha", 10);
    expect(pull.missing).toBe(true);
    expect(pull.messages).toHaveLength(1); // what is there is still delivered
    expect((await inboxPending(onlyBroadcast, "alpha")).missing).toBe(true);

    const both = source({ [inboxConsumerName("alpha")]: fakeConsumer([]), [broadcastConsumerName("alpha")]: fakeConsumer([]) });
    expect((await pullInbox(both, "alpha", 10)).missing).toBe(false);
    expect((await inboxPending(both, "alpha")).missing).toBe(false);
  });

  it("reads 'no responders' from a fetch, after the info answered, as a vanished consumer and not as an outage", async () => {
    // Revoke or delete of this very agent, landing between info and fetch.
    // nats.js ends the fetch with code 503. The broker just answered the
    // info: it is there. Passed on as it is, this would open the circuit
    // breaker for every agent for five seconds.
    const vanishing = fakeConsumer(["m1"]);
    vanishing.fetch = async () => ({
      // eslint-disable-next-line require-yield
      async *[Symbol.asyncIterator]() { throw Object.assign(new Error("no responders"), { code: "503" }); },
    });
    const src = source({ [inboxConsumerName("alpha")]: vanishing, [broadcastConsumerName("alpha")]: fakeConsumer([]) });
    const pull = await pullInbox(src, "alpha", 10);
    expect(pull.messages).toEqual([]);
    expect(pull.missing).toBe(true);
  });

  it("still passes on a timeout from the fetch: that one is an outage", async () => {
    const stalling = fakeConsumer(["m1"]);
    stalling.fetch = async () => { throw Object.assign(new Error("TIMEOUT"), { code: "TIMEOUT" }); };
    const src = source({ [inboxConsumerName("alpha")]: stalling, [broadcastConsumerName("alpha")]: fakeConsumer([]) });
    await expect(pullInbox(src, "alpha", 10)).rejects.toMatchObject({ code: "TIMEOUT" });
  });
});

describe("inboxPending", () => {
  it("sums pending across inbox and broadcast without fetching", async () => {
    const inbox = fakeConsumer(["a", "b"]);
    const bc = fakeConsumer(["c"]);
    const src = source({ [inboxConsumerName("alpha")]: inbox, [broadcastConsumerName("alpha")]: bc });
    expect(await inboxPending(src, "alpha")).toEqual({ inbox: 2, broadcast: 1, total: 3, missing: false });
    expect(inbox.fetchCalls).toEqual([]);
  });

  it("counts delivered-but-unacked messages as pending too", async () => {
    const c = fakeConsumer([]);
    c.info = async () => ({ num_pending: 0, num_ack_pending: 2 });
    const src = source({ [inboxConsumerName("alpha")]: c });
    expect((await inboxPending(src, "alpha")).total).toBe(2);
  });

  it("is zero for an agent without consumers", async () => {
    expect(await inboxPending(source({}), "ghost")).toEqual({ inbox: 0, broadcast: 0, total: 0, missing: true });
  });
});

describe("isConsumerNotFound", () => {
  it("matches the JetStream api error code and the message text", () => {
    expect(isConsumerNotFound(notFoundError())).toBe(true);
    expect(isConsumerNotFound(new Error("Consumer Not Found"))).toBe(true);
    expect(isConsumerNotFound(new Error("timeout"))).toBe(false);
    expect(isConsumerNotFound(undefined)).toBe(false);
  });
});
