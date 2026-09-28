// A name is a label and it can pass from one agent to another. Migration 0011
// resolved `activity_log.agent_name` to an inbox key by the name the agent
// holds TODAY, which lands a row about one agent on another; 0012 repairs a
// database where that already ran.

import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import SqliteDatabase from "better-sqlite3";
import type Database from "better-sqlite3";
import { initDatabase } from "../../src/services/db";
import { ActivityService } from "../../src/services/activity";
import { AgentService } from "../../src/services/agent";
import { MESSAGE_DEAD_LETTER } from "../../src/services/dead-letter";

/** The backfill exactly as 0011 shipped it, before this was found. */
const OLD_BACKFILL = `UPDATE activity_log
   SET agent_key = (SELECT a.inbox_key FROM agents a WHERE a.name = activity_log.agent_name COLLATE NOCASE)
 WHERE agent_key IS NULL AND agent_name IS NOT NULL`;

describe("activity_log.agent_key", () => {
  let db: Database.Database;
  let agents: AgentService;
  const MINUTE = 60_000;
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
  /** An agent that has been there a while, as every real one has. A row dated
   *  before its own agent existed cannot be tied to it by any rule. */
  const backdate = (id: string, ms: number) =>
    db.prepare("UPDATE agents SET created_at = ?, name_since = ? WHERE id = ?").run(ago(ms), ago(ms), id);
  const row = (id: string, action: string, name: string, at = ago(5 * MINUTE)) =>
    db.prepare(
      "INSERT INTO activity_log (id, action, entity_type, entity_id, summary, agent_name, agent_key, created_at) VALUES (?,?,?,?,?,?,NULL,?)",
    ).run(id, action, "message", `msg_${id}`, "…", name, at);
  const keyOf = (id: string) =>
    (db.prepare("SELECT agent_key FROM activity_log WHERE id = ?").get(id) as { agent_key: string | null }).agent_key;

  beforeEach(() => {
    db = initDatabase(":memory:");
    agents = new AgentService(db, new ActivityService(db));
  });

  /** A took the name, A was renamed away, B took the freed name. */
  function nameHandedOver() {
    const a = agents.create("bob").agent;      // inbox_key "bob"
    const b = agents.create("carol").agent;    // inbox_key "carol"
    backdate(a.id, 10 * MINUTE);
    backdate(b.id, 10 * MINUTE);
    row("amb", MESSAGE_DEAD_LETTER, "bob");    // written while A was called bob
    // Now, so name_since lands after the row, as a later rename does.
    expect(agents.rename(a.id, "alice")).toBe(true);
    expect(agents.rename(b.id, "bob")).toBe(true);
    return { a, b };
  }

  it("is what the OLD backfill got wrong, and the test says so in one line", () => {
    const { a, b } = nameHandedOver();
    db.prepare(OLD_BACKFILL).run();
    // The row is about A. It landed on B.
    expect(keyOf("amb")).toBe(b.inbox_key);
    expect(keyOf("amb")).not.toBe(a.inbox_key);
  });

  // 0011 ON ITS OWN, on a database that has not seen 0012: every file up to
  // 0010, then the fixture, then 0011. Run through initDatabase instead, 0012
  // would clear the row afterwards and the test would pass either way.
  it("0011 leaves a name it cannot pin to one agent alone", () => {
    const fresh = new SqliteDatabase(":memory:");
    const files = readdirSync("migrations").filter((f) => f.endsWith(".sql")).sort();
    for (const f of files.filter((f) => f < "0011")) fresh.exec(readFileSync(`migrations/${f}`, "utf-8"));

    // Raw SQL, not AgentService: the service's ActivityService already writes
    // agent_key, and this schema does not have the column yet. That is itself
    // the reason the migration has to run before any request does.
    const agent = (key: string, name: string, nameSince: string) =>
      fresh.prepare(
        "INSERT INTO agents (id, name, token_hash, inbox_key, name_since, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
      ).run(`ag_${key}`, name, `hash_${key}`, key, nameSince, ago(10 * MINUTE), ago(10 * MINUTE));

    // A held "bob" from ten minutes ago; the row is from five minutes ago.
    // Then A was renamed away and B took the freed name, both just now.
    agent("bob", "alice", ago(0));
    agent("carol", "bob", ago(0));
    fresh.prepare(
      "INSERT INTO activity_log (id, action, entity_type, entity_id, summary, agent_name, created_at) VALUES (?,?,?,?,?,?,?)",
    ).run("amb", MESSAGE_DEAD_LETTER, "message", "msg_amb", "…", "bob", ago(5 * MINUTE));

    fresh.exec(readFileSync("migrations/0011_activity_agent_key.sql", "utf-8"));
    const got = fresh.prepare("SELECT agent_key FROM activity_log WHERE id = 'amb'").get() as { agent_key: string | null };
    expect(got.agent_key).toBeNull();
    // Not the agent that holds the name now, which is what the first
    // version of 0011 wrote there.
    expect(got.agent_key).not.toBe("carol");
  });

  it("0012 clears what the old backfill wrote", () => {
    const { b } = nameHandedOver();
    db.prepare(OLD_BACKFILL).run();
    expect(keyOf("amb")).toBe(b.inbox_key);
    db.exec(readFileSync("migrations/0012_agent_key_repair.sql", "utf-8"));
    expect(keyOf("amb")).toBeNull();
  });

  it("keeps a key that still checks out", () => {
    const dave = agents.create("dave").agent;
    backdate(dave.id, 10 * MINUTE);
    row("ok", MESSAGE_DEAD_LETTER, "dave");
    db.prepare(OLD_BACKFILL).run();
    expect(keyOf("ok")).toBe(dave.inbox_key);
    db.exec(readFileSync("migrations/0012_agent_key_repair.sql", "utf-8"));
    expect(keyOf("ok")).toBe(dave.inbox_key);
  });

  // `message_expired` records the SENDER in agent_name, `message_dead_letter`
  // the READER. A key on both would make the column mean two things.
  it("carries a key for a dead letter and for nothing else", () => {
    const dave = agents.create("dave").agent;
    backdate(dave.id, 10 * MINUTE);
    row("dl", MESSAGE_DEAD_LETTER, "dave");
    row("exp", "message_expired", "dave");
    row("rnr", "read_not_recorded", "dave");
    db.prepare(OLD_BACKFILL).run();
    db.exec(readFileSync("migrations/0012_agent_key_repair.sql", "utf-8"));
    expect(keyOf("dl")).toBe(dave.inbox_key);
    expect(keyOf("exp")).toBeNull();
    expect(keyOf("rnr")).toBeNull();
  });

  // The check in recordDeadLetter asks by key; the schema holds the same rule,
  // so two processes on one volume cannot write two rows for one reader.
  it("lets the schema hold once per message and reader, by key", () => {
    agents.create("dave");
    const write = (id: string) =>
      db.prepare(
        "INSERT INTO activity_log (id, action, entity_type, entity_id, summary, agent_name, agent_key, created_at) VALUES (?,?,?,?,?,?,?,?)",
      ).run(id, MESSAGE_DEAD_LETTER, "message", "msg_same", "…", "dave", "dave", new Date().toISOString());
    write("one");
    expect(() => write("two")).toThrow(/UNIQUE/);
    // A row without a key is not caught by it, and must not be.
    expect(() =>
      db.prepare(
        "INSERT INTO activity_log (id, action, entity_type, entity_id, summary, agent_name, agent_key, created_at) VALUES (?,?,?,?,?,?,NULL,?)",
      ).run("three", MESSAGE_DEAD_LETTER, "message", "msg_same", "…", "someone-else", new Date().toISOString()),
    ).not.toThrow();
  });
});
