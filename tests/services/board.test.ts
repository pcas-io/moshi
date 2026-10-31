// The board (src/services/board.ts): who has the ball between two agents, and
// whether it moves. Real SQLite and a fixed clock; presence and hooks are
// given per test.

import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { initDatabase } from "../../src/services/db";
import { AgentService } from "../../src/services/agent";
import { ActivityService } from "../../src/services/activity";
import { createMessage, persistMessage } from "../../src/services/message";
import type { AgentWithPresence, Presence } from "../../src/services/presence";
import type { WebhookStatus } from "../../src/services/webhooks";
import { buildBoard, lightOf, reachOf, isVague, waitsForHuman, resultLinksIn, BOARD_THRESHOLDS, QUIET_LISTED, HISTORY_LISTED } from "../../src/services/board";

const NOW = Date.parse("2026-10-31T12:00:00.000Z");
let db: Database.Database;
let agents: AgentService;

beforeEach(() => {
  db = initDatabase(":memory:");
  agents = new AgentService(db, new ActivityService(db));
  for (const name of ["kate", "worky", "tech"]) agents.create(name);
});

/** A message `minutesAgo` before NOW; returns its id (the thread of a first message). */
function say(from: string, to: string, minutesAgo: number, opts: { type?: string; thread?: string } = {}): string {
  const m = createMessage({ from, to, type: opts.type ?? "info", payload: "SECRET PAYLOAD", context: "SECRET CONTEXT", correlation_id: opts.thread });
  m.created_at = new Date(NOW - minutesAgo * 60_000).toISOString();
  persistMessage(db, m, { fromKey: from.toLowerCase(), toKey: to === "broadcast" ? "" : to.toLowerCase() });
  return m.id;
}

function roster(presence: Record<string, Presence> = {}, workingOn: Record<string, string | null> = {}): AgentWithPresence[] {
  return agents.list().map((a) => {
    const full = agents.getByName(a.name)!;
    return {
      agent: { ...full, working_on: a.name in workingOn ? workingOn[a.name] : "delivering: something concrete" },
      presence: presence[a.name] ?? "live",
      effectiveLastSeen: null,
    };
  });
}

const hook = (over: Partial<WebhookStatus> = {}): WebhookStatus => ({ state: "active", last_success_at: "2026-10-31T11:00:00Z", last_failure_at: null, ...over });

const board = (presence: Record<string, Presence> = {}, hooks: Record<string, WebhookStatus> = {}, workingOn: Record<string, string | null> = {}) =>
  buildBoard({ db, agents: roster(presence, workingOn), hooks: new Map(Object.entries(hooks)), now: NOW });

describe("one line per pair of agents", () => {
  it("keeps a conversation that goes on in new threads on one line, with the newest thread linked", () => {
    // What the agents do: every turn a new mesh_send, no correlation_id.
    say("kate", "tech", 30, { type: "review_request" });
    say("tech", "kate", 20, { type: "review_result" });
    const newest = say("kate", "tech", 5, { type: "task_update" });
    const b = board();
    expect(b.inPlay).toHaveLength(1);
    expect(b.inPlay[0]).toMatchObject({ holder: "tech", from: "kate", to: "tech", threadId: newest });
  });

  it("moves the ball with each direct message, either way round", () => {
    say("kate", "tech", 30, { type: "review_request" });
    expect(board().inPlay[0]).toMatchObject({ holder: "tech" });
    say("tech", "kate", 5, { type: "review_result" });
    expect(board().inPlay).toHaveLength(1);
    expect(board().inPlay[0]).toMatchObject({ holder: "kate" });
  });

  it("keeps different pairs apart, and broadcasts out", () => {
    say("kate", "tech", 10);
    say("kate", "worky", 8);
    say("worky", "broadcast", 1);
    expect(board().inPlay.map((r) => r.holder).sort()).toEqual(["tech", "worky"]);
  });

  it("is ended by done and starts again with the next message", () => {
    say("kate", "tech", 30);
    say("tech", "kate", 10, { type: "done" });
    expect(board().inPlay).toEqual([]);
    expect(board().quiet[0]).toMatchObject({ done: true, light: "grey", holder: null });
    say("kate", "tech", 2);
    expect(board().inPlay[0]).toMatchObject({ holder: "tech" });
  });

  it("goes grey after a day without anything, and lists at most the newest quiet ones", () => {
    for (let i = 0; i < QUIET_LISTED + 3; i++) {
      agents.create(`a${i}`);
      say("kate", `a${i}`, BOARD_THRESHOLDS.quietHours * 60 + i);
    }
    const b = board();
    expect(b.inPlay).toEqual([]);
    expect(b.quiet).toHaveLength(QUIET_LISTED);
    expect(b.quiet[0].to).toBe("a0"); // newest first
  });

  it("never carries a payload or a context", () => {
    say("kate", "tech", 5);
    expect(JSON.stringify(board())).not.toContain("SECRET");
  });
});

describe("wait for human", () => {
  it("takes a strand handed to a human with input_required, neutral rather than red", () => {
    say("kate", "worky", 5, { type: "input_required" });
    const b = board();
    expect(b.inPlay).toEqual([]);
    expect(b.waitingForHuman[0]).toMatchObject({ humanBall: true, holder: null, waiting: "kate", light: "human" });
  });

  it("takes a holder whose working_on says it waits for a human", () => {
    say("kate", "tech", 50);
    const b = board({}, {}, { tech: "wartet auf Mensch: Admin-Login für die UI-Abnahme" });
    expect(b.inPlay).toEqual([]);
    expect(b.waitingForHuman[0]).toMatchObject({ waiting: "tech", light: "human", deliversNext: "wartet auf Mensch: Admin-Login für die UI-Abnahme" });
  });

  it("knows the phrases in both languages, and nothing else", () => {
    for (const yes of ["wartet auf Mensch: Login", "Wartet auf einen Menschen", "waiting for a human: sign-off", "waits for human"]) {
      expect(waitsForHuman(yes), yes).toBe(true);
    }
    for (const no of ["delivering: fix to kate", "waiting", "humane waiting", null]) expect(waitsForHuman(no), String(no)).toBe(false);
  });
});

describe("the light", () => {
  it("is red only when nobody can wake the holder", () => {
    expect(lightOf("unreachable", 1)).toBe("red");
    expect(lightOf("online", 600)).toBe("yellow");
    expect(lightOf("hook", 600)).toBe("yellow");
  });

  it("is green for a reachable holder whose ball is fresh, yellow after a while or when only quiet", () => {
    expect(lightOf("online", 5)).toBe("green");
    expect(lightOf("hook", BOARD_THRESHOLDS.greenMinutes)).toBe("yellow");
    expect(lightOf("stale", 1)).toBe("yellow");
  });

  it("counts a sleeping bot with a working hook as reachable", () => {
    expect(reachOf("stale", hook())).toBe("hook");
    expect(reachOf("offline", hook())).toBe("hook");
    expect(reachOf("stale", hook({ last_success_at: null }))).toBe("stale");
    expect(reachOf("offline", hook({ state: "disabled" }))).toBe("unreachable");
    expect(reachOf("live", null)).toBe("online");
  });

  it("puts it together per strand", () => {
    say("kate", "tech", 5);
    expect(board({ tech: "offline" }, { tech: hook() }).inPlay[0]).toMatchObject({ light: "green", reach: "hook" });
    expect(board({ tech: "offline" }).inPlay[0]).toMatchObject({ light: "red", reach: "unreachable" });
    expect(board({ tech: "live" }).inPlay[0]).toMatchObject({ light: "green", reach: "online" });
  });

  it("is red for a holder that was deactivated", () => {
    say("kate", "tech", 5);
    agents.revokeById(agents.getByName("tech")!.id, "admin");
    expect(board().inPlay[0]).toMatchObject({ light: "red", reach: "unreachable" });
  });

  it("sorts red, yellow, green, and the newest first within each", () => {
    say("kate", "tech", 100);
    say("kate", "worky", 50);
    say("worky", "tech", 2, {});
    // Three pairs: kate↔tech 100 min, kate↔worky 50 min (both yellow), worky↔tech 2 min (green).
    const order = board().inPlay.map((r) => `${r.light}:${r.from}>${r.holder}`);
    expect(order).toEqual(["yellow:kate>worky", "yellow:kate>tech", "green:worky>tech"]);
    expect(board({ worky: "offline" }).inPlay.map((r) => r.light)).toEqual(["red", "yellow", "green"]);
  });
});

describe("nothing moving", () => {
  it("is said when strands are open and none is green", () => {
    say("kate", "tech", 50);
    expect(board().nothingMoving).toBe(true);
    say("tech", "kate", 1);
    expect(board().nothingMoving).toBe(false);
  });

  it("is not said when nothing is open at all", () => {
    expect(board().nothingMoving).toBe(false);
  });
});

describe("delivers next", () => {
  it("is the holder's working_on, and a vague one is pointed out", () => {
    say("kate", "tech", 5);
    expect(board({}, {}, { tech: "delivering: R3c fix to kate" }).inPlay[0]).toMatchObject({ deliversNext: "delivering: R3c fix to kate", vagueNext: false });
    expect(board({}, {}, { tech: "idle" }).inPlay[0]).toMatchObject({ vagueNext: true });
    expect(board({}, {}, { tech: null }).inPlay[0]).toMatchObject({ vagueNext: true });
  });

  it("knows the generic words", () => {
    for (const vague of ["", " ", "idle", "Idle.", "none", "-", "n/a", "waiting"]) expect(isVague(vague), vague).toBe(true);
    expect(isVague("idle until kate's review")).toBe(false);
  });
});

describe("stage 2: last action, delivery, result, history", () => {
  const HOST = "results.example.com";
  const link = (id: string) => `https://${HOST}/entities/${id}`;
  const ID1 = "06ae5d2b-cf6a-7b57-8000-625378008c57";
  const ID2 = "06ae5dc8-e919-7fc6-8000-131dead25f8d";
  const links = (titles: Record<string, string> = {}) => ({ hosts: [HOST], titleOf: (id: string) => titles[id] ?? null });

  function sayWith(from: string, to: string, minutesAgo: number, type: string, payload: string, context = "-") {
    const m = createMessage({ from, to, type, payload, context });
    m.created_at = new Date(NOW - minutesAgo * 60_000).toISOString();
    persistMessage(db, m, { fromKey: from, toKey: to });
  }
  const boardWith = (l = links()) => buildBoard({ db, agents: roster(), hooks: new Map(), now: NOW, links: l });

  it("finds result links only on allowed hosts, https, with an id; the last one in a text wins", () => {
    const text = `see ${link(ID1)}, then ${link(ID2)}. Not http://${HOST}/entities/${ID1}, not https://evil.example.com/entities/${ID1}, not https://${HOST}/no-id`;
    expect(resultLinksIn(text, [HOST])).toEqual([
      { url: link(ID1), id: ID1 },
      { url: link(ID2), id: ID2 },
    ]);
    expect(resultLinksIn(text, [])).toEqual([]);
    expect(resultLinksIn(`https://user:pw@${HOST}/entities/${ID1} https://${HOST}:8443/entities/${ID1}`, [HOST])).toEqual([]);
  });

  it("calls a review_result or delivered message a delivery, and a message with a result link too", () => {
    sayWith("kate", "tech", 5, "review_result", "looks good");
    expect(boardWith().inPlay[0]).toMatchObject({ holder: "tech", delivered: true, result: null });
    sayWith("tech", "kate", 3, "info", `done, see ${link(ID1)}`);
    expect(boardWith().inPlay[0]).toMatchObject({ holder: "kate", delivered: true, result: { id: ID1, url: link(ID1), title: null } });
    sayWith("kate", "tech", 1, "question", "and now?");
    expect(boardWith().inPlay[0]).toMatchObject({ holder: "tech", delivered: false });
    // The newest message that carried a link still names the result.
    expect(boardWith().inPlay[0]!.result).toMatchObject({ id: ID1 });
  });

  it("takes the title when it is known, from the context as well as the payload", () => {
    sayWith("kate", "tech", 2, "delivered", "here", `handoff ${link(ID2)}`);
    expect(boardWith(links({ [ID2]: "Handoff (2)" })).inPlay[0]!.result).toEqual({ url: link(ID2), id: ID2, title: "Handoff (2)" });
  });

  it("shows no link at all without allowed hosts", () => {
    sayWith("kate", "tech", 2, "delivered", link(ID2));
    expect(buildBoard({ db, agents: roster(), hooks: new Map(), now: NOW }).inPlay[0]).toMatchObject({ result: null, delivered: true });
  });

  it("lists the last ten actions between the two, newest first, without any text", () => {
    for (let i = 0; i < 12; i++) sayWith(i % 2 ? "tech" : "kate", i % 2 ? "kate" : "tech", 60 - i, "info", `SECRET ${i}`);
    const row = boardWith().inPlay[0]!;
    expect(row.history).toHaveLength(HISTORY_LISTED);
    expect(row.history[0]).toMatchObject({ from: "tech", to: "kate", type: "info", link: null });
    expect(row.history.map((h) => h.at)).toEqual([...row.history.map((h) => h.at)].sort().reverse());
    expect(JSON.stringify(row)).not.toContain("SECRET");
  });
});
