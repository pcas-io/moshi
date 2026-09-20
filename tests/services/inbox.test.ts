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
  infoCalls: number;
  /** Stream sequence of the last message this consumer handed out. */
  deliveredSeq: number;
}

function fakeConsumer(queue: string[]): FakeConsumer {
  const enc = new TextEncoder();
  const self: FakeConsumer = {
    fetchCalls: [],
    queue: queue.map((s) => enc.encode(s)),
    acked: 0,
    infoCalls: 0,
    deliveredSeq: 0,
    async info() {
      self.infoCalls++;
      return { num_pending: self.queue.length, num_ack_pending: 0, delivered: { stream_seq: self.deliveredSeq } };
    },
    async fetch(opts) {
      self.fetchCalls.push(opts);
      const batch = self.queue.splice(0, opts.max_messages);
      return {
        async *[Symbol.asyncIterator]() {
          for (const data of batch) {
            self.deliveredSeq++;
            yield { data, seq: self.deliveredSeq, ack: () => { self.acked++; } };
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

describe("pullInbox — messages the caller does not want", () => {
  const text = (m: { data: Uint8Array }) => new TextDecoder().decode(m.data);
  const drop = (data: Uint8Array, from: "inbox" | "broadcast") => {
    const s = new TextDecoder().decode(data);
    return s.startsWith("expired") || (from === "broadcast" && s.startsWith("mine"));
  };

  it("acks and leaves out the puller's own broadcast: two waiting, one comes back, both are acked", async () => {
    const bc = fakeConsumer(["mine-1", "theirs-1"]);
    const src = source({ [inboxConsumerName("alpha")]: fakeConsumer([]), [broadcastConsumerName("alpha")]: bc });
    const res = await pullInbox(src, "alpha", 10, { drop });
    expect(res.messages.map(text)).toEqual(["theirs-1"]);
    expect(bc.acked).toBe(1); // the dropped one; the kept one is acked by whoever reads it
    expect(res.dropped).toBe(1);
    expect(res.remaining).toBe(0);
  });

  it("only drops an own message on the broadcast side: a direct message to oneself is a message", async () => {
    const inbox = fakeConsumer(["mine-direct"]);
    const src = source({ [inboxConsumerName("alpha")]: inbox, [broadcastConsumerName("alpha")]: fakeConsumer([]) });
    const res = await pullInbox(src, "alpha", 10, { drop });
    expect(res.messages.map(text)).toEqual(["mine-direct"]);
    expect(res.dropped).toBe(0);
  });

  it("pulls again until the limit is filled with messages that count", async () => {
    const inbox = fakeConsumer(["expired-1", "expired-2", "a", "expired-3", "b", "c", "d"]);
    const src = source({ [inboxConsumerName("alpha")]: inbox, [broadcastConsumerName("alpha")]: fakeConsumer([]) });
    const res = await pullInbox(src, "alpha", 3, { drop });
    expect(res.messages.map(text)).toEqual(["a", "b", "c"]);
    expect(res.dropped).toBe(3);
    expect(res.remaining).toBe(1); // "d" was never fetched: it is not in limbo until the ack wait ends
    expect(inbox.queue).toHaveLength(1);
    // Never more per fetch than there is room for: what is fetched and kept must fit the limit.
    expect(inbox.fetchCalls.map((c) => c.max_messages)).toEqual([3, 2, 1]);
  });

  it("empties an inbox that holds nothing but dropped messages, and says it is empty", async () => {
    const inbox = fakeConsumer(Array.from({ length: 25 }, (_, i) => `expired-${i}`));
    const src = source({ [inboxConsumerName("alpha")]: inbox, [broadcastConsumerName("alpha")]: fakeConsumer([]) });
    const res = await pullInbox(src, "alpha", 10, { drop });
    expect(res.messages).toEqual([]);
    expect(res.dropped).toBe(25);
    expect(res.remaining).toBe(0);
    expect(inbox.acked).toBe(25);
  });

  it("stops after a bounded number of rounds, and stays honest about what is left", async () => {
    const inbox = fakeConsumer(Array.from({ length: 500 }, (_, i) => `expired-${i}`));
    const src = source({ [inboxConsumerName("alpha")]: inbox, [broadcastConsumerName("alpha")]: fakeConsumer([]) });
    const res = await pullInbox(src, "alpha", 1, { drop });
    expect(res.messages).toEqual([]);
    expect(inbox.fetchCalls.length).toBeLessThanOrEqual(25);
    expect(res.dropped).toBe(inbox.fetchCalls.length);
    expect(res.remaining).toBe(500 - res.dropped);
  });

  it("asks the broker for its counts once per side, however often it has to pull again", async () => {
    // A second look would count the messages just handed out as waiting for
    // redelivery, and the next fetch would sit out its deadline for them.
    const inbox = fakeConsumer(["expired-1", "a", "expired-2", "b"]);
    const bc = fakeConsumer(["mine-1", "c"]);
    const src = source({ [inboxConsumerName("alpha")]: inbox, [broadcastConsumerName("alpha")]: bc });
    const res = await pullInbox(src, "alpha", 10, { drop });
    expect(res.messages.map(text)).toEqual(["a", "b", "c"]);
    expect(inbox.infoCalls).toBe(1);
    expect(bc.infoCalls).toBe(1);
  });

  it("does not pull again when the consumer gave less than was asked for: the rest waits for redelivery", async () => {
    const inbox = fakeConsumer(["expired-1"]);
    inbox.info = async () => ({ num_pending: 1, num_ack_pending: 2, delivered: { stream_seq: 0 } });
    const src = source({ [inboxConsumerName("alpha")]: inbox, [broadcastConsumerName("alpha")]: fakeConsumer([]) });
    const res = await pullInbox(src, "alpha", 10, { drop });
    expect(inbox.fetchCalls).toHaveLength(1);
    expect(res.remaining).toBe(2);
  });

  it("reports how far the broadcast side has read after the pull, and what it still holds", async () => {
    const bc = fakeConsumer(["mine-1", "x", "mine-2", "y", "z"]);
    bc.deliveredSeq = 40;
    const src = source({ [inboxConsumerName("alpha")]: fakeConsumer(["i1", "i2"]), [broadcastConsumerName("alpha")]: bc });
    const res = await pullInbox(src, "alpha", 3, { drop });
    expect(res.messages.map(text)).toEqual(["i1", "i2", "x"]);
    expect(res.broadcastDeliveredSeq).toBe(42); // mine-1 and x
    expect(res.remainingBroadcast).toBe(3);
    expect(res.remaining).toBe(3);
    // Nothing read from that side: the position the broker reported.
    const untouched = fakeConsumer(["x"]);
    untouched.deliveredSeq = 7;
    const none = await pullInbox(source({ [inboxConsumerName("b")]: fakeConsumer(["i"]), [broadcastConsumerName("b")]: untouched }), "b", 1, { drop });
    expect(none.broadcastDeliveredSeq).toBe(7);
  });

  it("never moves the read position backwards: a redelivered older message can arrive after a newer one", async () => {
    const enc = new TextEncoder();
    const consumer: PullConsumer = {
      async info() { return { num_pending: 1, num_ack_pending: 1, delivered: { stream_seq: 40 } }; },
      async fetch() {
        return { async *[Symbol.asyncIterator]() {
          yield { data: enc.encode("new"), seq: 42, ack: () => {} };
          yield { data: enc.encode("redelivered"), seq: 17, ack: () => {} };
        } };
      },
    };
    const src: ConsumerSource = { async get(name) { if (name === broadcastConsumerName("alpha")) return consumer; throw notFoundError(); } };
    const res = await pullInbox(src, "alpha", 10, { drop: () => false });
    expect(res.messages).toHaveLength(2);
    expect(res.broadcastDeliveredSeq).toBe(42);
  });

  it("hands the caller the very bytes it showed to the drop rule", async () => {
    // nats.js builds `data` anew on every access. A caller that remembers
    // what it parsed per `data` object would not find it again, and would
    // ack a message it never returned.
    const bytes = new TextEncoder().encode("a");
    const consumer: PullConsumer = {
      async info() { return { num_pending: consumerLeft, num_ack_pending: 0 }; },
      async fetch() {
        consumerLeft = 0;
        return { async *[Symbol.asyncIterator]() { yield { get data() { return bytes.slice(); }, ack: () => {} }; } };
      },
    };
    let consumerLeft = 1;
    const src: ConsumerSource = { async get(name) { if (name === inboxConsumerName("alpha")) return consumer; throw notFoundError(); } };
    const seen: Uint8Array[] = [];
    const res = await pullInbox(src, "alpha", 10, { drop: (data) => { seen.push(data); return false; } });
    expect(res.messages).toHaveLength(1);
    expect(res.messages[0]!.data).toBe(seen[0]);
  });

  it("without a drop rule everything comes back, as before", async () => {
    const bc = fakeConsumer(["mine-1", "expired-1"]);
    const src = source({ [inboxConsumerName("alpha")]: fakeConsumer([]), [broadcastConsumerName("alpha")]: bc });
    const res = await pullInbox(src, "alpha", 10);
    expect(res.messages.map(text)).toEqual(["mine-1", "expired-1"]);
    expect(res.dropped).toBe(0);
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
    expect(await inboxPending(src, "alpha")).toMatchObject({ inbox: 2, broadcast: 1, total: 3, missing: false });
    expect(inbox.fetchCalls).toEqual([]);
  });

  it("counts delivered-but-unacked messages as pending too", async () => {
    const c = fakeConsumer([]);
    c.info = async () => ({ num_pending: 0, num_ack_pending: 2 });
    const src = source({ [inboxConsumerName("alpha")]: c });
    expect((await inboxPending(src, "alpha")).total).toBe(2);
  });

  it("reports how far the broadcast consumer has read, for the caller to tell own broadcasts apart", async () => {
    const bc = fakeConsumer(["b1", "b2"]);
    bc.deliveredSeq = 41;
    const src = source({ [inboxConsumerName("alpha")]: fakeConsumer(["i1"]), [broadcastConsumerName("alpha")]: bc });
    expect(await inboxPending(src, "alpha")).toMatchObject({ inbox: 1, broadcast: 2, total: 3, broadcastDeliveredSeq: 41 });
    expect((await inboxPending(source({}), "alpha")).broadcastDeliveredSeq).toBeNull();
  });

  it("is zero for an agent without consumers", async () => {
    expect(await inboxPending(source({}), "ghost")).toMatchObject({ inbox: 0, broadcast: 0, total: 0, missing: true });
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
