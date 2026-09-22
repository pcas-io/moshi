// A message the broker has given up on: handed out `max_deliver` times and
// never acked. It stays in the stream and is never delivered again, and
// nobody saw that happen (src/services/dead-letter.ts).

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import type Database from "better-sqlite3";
import { initDatabase } from "../../src/services/db";
import { ActivityService } from "../../src/services/activity";
import { AgentService } from "../../src/services/agent";
import { createMessage, persistMessage } from "../../src/services/message";
import { DEAD_LETTER_SUBJECT, MESSAGE_DEAD_LETTER, parseDeadLetter, recordDeadLetter } from "../../src/services/dead-letter";

const enc = new TextEncoder();
const advisory = (over: Record<string, unknown> = {}) =>
  enc.encode(JSON.stringify({
    type: "io.nats.jetstream.advisory.v1.max_deliver",
    id: "adv1", timestamp: "2026-09-21T10:00:00Z",
    stream: "MESH_MESSAGES", consumer: "agent-beta", stream_seq: 7, deliveries: 5,
    ...over,
  }));

describe("parseDeadLetter", () => {
  it("listens where the broker reports it, for this stream only", () => {
    expect(DEAD_LETTER_SUBJECT).toBe("$JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.MESH_MESSAGES.*");
  });

  it("reads consumer, sequence and deliveries", () => {
    expect(parseDeadLetter(advisory())).toEqual({ consumer: "agent-beta", streamSeq: 7, deliveries: 5 });
  });

  it("refuses what is not such an advisory, without throwing", () => {
    for (const bad of [
      enc.encode("not json"), enc.encode("null"), enc.encode("42"), enc.encode("[]"),
      advisory({ stream: "OTHER" }), advisory({ consumer: 5 }), advisory({ consumer: "" }),
      advisory({ stream_seq: "7" }), advisory({ stream_seq: 0 }), advisory({ stream_seq: 1.5 }),
      advisory({ deliveries: "many" }),
    ]) {
      expect(parseDeadLetter(bad)).toBeNull();
    }
  });
});

describe("recordDeadLetter", () => {
  let db: Database.Database;
  let activity: ActivityService;
  let agents: AgentService;
  const rows = () =>
    db.prepare("SELECT entity_type, entity_id, summary, agent_name FROM activity_log WHERE action = ? ORDER BY rowid").all(MESSAGE_DEAD_LETTER) as
      { entity_type: string; entity_id: string; summary: string; agent_name: string }[];
  function stored(seq: number, opts: { to?: string; toKey?: string | null; from?: string } = {}) {
    const msg = createMessage({ from: opts.from ?? "alpha", to: opts.to ?? "beta", type: "info", payload: "x", context: "ctx" });
    persistMessage(db, msg, { fromKey: "alpha", toKey: opts.toKey === undefined ? "beta" : opts.toKey, streamSeq: seq });
    return msg;
  }

  beforeEach(() => {
    db = initDatabase(":memory:");
    activity = new ActivityService(db);
    agents = new AgentService(db, activity);
    agents.create("alpha");
    agents.create("beta");
  });

  it("names the message, its sender and the agent that never acknowledged it", () => {
    const msg = stored(7);
    expect(recordDeadLetter(db, activity, { consumer: "agent-beta", streamSeq: 7, deliveries: 5 })).toBe(true);
    expect(rows()).toEqual([{
      entity_type: "message",
      entity_id: msg.id,
      summary: `beta was handed ${msg.id} from alpha 5 times and never acknowledged it; the broker has stopped delivering it. mesh_inbox still shows it.`,
      agent_name: "beta",
    }]);
  });

  it("writes it once, however often the broker says it", () => {
    stored(7);
    recordDeadLetter(db, activity, { consumer: "agent-beta", streamSeq: 7, deliveries: 5 });
    expect(recordDeadLetter(db, activity, { consumer: "agent-beta", streamSeq: 7, deliveries: 5 })).toBe(false);
    expect(rows()).toHaveLength(1);
  });

  it("a broadcast can be given up on for one reader and then for another", () => {
    const msg = stored(9, { to: "broadcast", toKey: null });
    recordDeadLetter(db, activity, { consumer: "agent-beta-broadcast", streamSeq: 9, deliveries: 5 });
    recordDeadLetter(db, activity, { consumer: "agent-alpha-broadcast", streamSeq: 9, deliveries: 5 });
    expect(rows().map((r) => [r.entity_id, r.agent_name])).toEqual([[msg.id, "beta"], [msg.id, "alpha"]]);
  });

  it("finds the agent by its key after a rename", () => {
    stored(7);
    agents.rename(agents.getByName("beta")!.id, "gamma", "admin");
    recordDeadLetter(db, activity, { consumer: "agent-beta", streamSeq: 7, deliveries: 5 });
    expect(rows()[0].agent_name).toBe("gamma");
    expect(rows()[0].summary.startsWith("gamma was handed")).toBe(true);
  });

  it("does not take another agent's message that has the same sequence", () => {
    // Two volumes: after a lost stream the sequences start again, and the
    // history keeps the old rows. Sequence 7 to somebody else is not it.
    stored(7, { to: "alpha", toKey: "alpha", from: "beta" });
    recordDeadLetter(db, activity, { consumer: "agent-beta", streamSeq: 7, deliveries: 5 });
    expect(rows()).toEqual([{
      entity_type: "message",
      entity_id: "seq:7",
      summary: "beta was handed a message (stream sequence 7) 5 times and never acknowledged it; the broker has stopped delivering it. The history has no row for it.",
      agent_name: "beta",
    }]);
  });

  it("does not name a row from before the stream: after a lost volume the sequences start again", () => {
    const old = stored(7);
    db.prepare("UPDATE messages SET created_at = ? WHERE id = ?").run("2026-09-01T00:00:00.000Z", old.id);
    recordDeadLetter(db, activity, { consumer: "agent-beta", streamSeq: 7, deliveries: 5 }, "2026-09-10T00:00:00.000Z");
    expect(rows()[0].entity_id).toBe("seq:7");
  });

  it("takes the newest row when a sequence is there twice", () => {
    const old = stored(7);
    db.prepare("UPDATE messages SET created_at = ? WHERE id = ?").run(new Date(Date.now() - 86_400_000).toISOString(), old.id);
    const current = stored(7);
    recordDeadLetter(db, activity, { consumer: "agent-beta", streamSeq: 7, deliveries: 5 });
    expect(rows()[0].entity_id).toBe(current.id);
  });

  it("still says something for a durable of an agent that is gone", () => {
    stored(7);
    agents.deleteById(agents.getByName("beta")!.id, "admin");
    recordDeadLetter(db, activity, { consumer: "agent-beta", streamSeq: 7, deliveries: 5 });
    expect(rows()[0].agent_name).toBe("beta");
  });

  it("ignores a consumer that is not an agent's", () => {
    expect(recordDeadLetter(db, activity, { consumer: "somebody-elses", streamSeq: 7, deliveries: 5 })).toBe(false);
    expect(rows()).toEqual([]);
  });
});

describe("the bootstrap", () => {
  // src/index.tsx cannot be imported by a test. Without this line the broker's
  // notice is parsed, logged and dropped, with every other test green.
  it("hands what the broker reports to the audit log", () => {
    const source = readFileSync(new URL("../../src/index.tsx", import.meta.url), "utf-8");
    expect(source).toMatch(/^nats\.onDeadLetter\(\(letter, streamCreated\) => recordDeadLetter\(db, activity, letter, streamCreated\)\);$/m);
  });
});
