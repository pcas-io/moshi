// The board (src/services/board.ts): who has the ball, and whether it moves.
// Real SQLite and a fixed clock; presence and hooks are given per test.

import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { initDatabase } from "../../src/services/db";
import { AgentService } from "../../src/services/agent";
import { ActivityService } from "../../src/services/activity";
import { createMessage, persistMessage } from "../../src/services/message";
import type { AgentWithPresence, Presence } from "../../src/services/presence";
import type { WebhookStatus } from "../../src/services/webhooks";
import { buildBoard, lightOf, reachOf, isVague, BOARD_THRESHOLDS, QUIET_LISTED } from "../../src/services/board";

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
  persistMessage(db, m, { toKey: to === "broadcast" ? "" : to.toLowerCase() });
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

describe("whose ball it is", () => {
  it("lies with the recipient of the last direct message, and moves with a review", () => {
    const t = say("kate", "tech", 30, { type: "review_request" });
    expect(board().inPlay[0]).toMatchObject({ threadId: t, holder: "tech", from: "kate", to: "tech" });
    say("tech", "kate", 5, { type: "review_result", thread: t });
    expect(board().inPlay).toHaveLength(1);
    expect(board().inPlay[0]).toMatchObject({ threadId: t, holder: "kate" });
  });

  it("is moved by no broadcast", () => {
    const t = say("kate", "tech", 10);
    say("worky", "broadcast", 1, { thread: t });
    expect(board().inPlay[0]).toMatchObject({ holder: "tech" });
  });

  it("is with a human after input_required, and lists it apart", () => {
    say("kate", "worky", 5, { type: "input_required" });
    const b = board();
    expect(b.inPlay).toEqual([]);
    expect(b.waitingForHuman[0]).toMatchObject({ humanBall: true, holder: null, from: "kate", light: "red" });
  });

  it("is with nobody once a strand is done", () => {
    const t = say("kate", "tech", 30);
    say("tech", "kate", 2, { type: "done", thread: t });
    const b = board();
    expect(b.inPlay).toEqual([]);
    expect(b.quiet[0]).toMatchObject({ threadId: t, done: true, light: "grey", holder: null });
  });

  it("goes grey after a day without anything, and lists at most the newest quiet ones", () => {
    for (let i = 0; i < QUIET_LISTED + 3; i++) say("kate", "tech", BOARD_THRESHOLDS.quietHours * 60 + i);
    const b = board();
    expect(b.inPlay).toEqual([]);
    expect(b.quiet).toHaveLength(QUIET_LISTED);
  });

  it("never carries a payload or a context", () => {
    say("kate", "tech", 5);
    expect(JSON.stringify(board())).not.toContain("SECRET");
  });
});

describe("the light", () => {
  it("goes by time for a reachable holder", () => {
    expect(lightOf("online", 5)).toBe("green");
    expect(lightOf("hook", BOARD_THRESHOLDS.greenMinutes)).toBe("yellow");
    expect(lightOf("online", BOARD_THRESHOLDS.redMinutes)).toBe("red");
  });

  it("is yellow at best for a holder that is only quiet, red for one that cannot be reached", () => {
    expect(lightOf("stale", 1)).toBe("yellow");
    expect(lightOf("unreachable", 1)).toBe("red");
  });

  it("counts a sleeping bot with a working hook as reachable", () => {
    expect(reachOf("stale", hook())).toBe("hook");
    expect(reachOf("offline", hook())).toBe("hook");
    expect(reachOf("stale", hook({ last_success_at: null }))).toBe("stale");
    expect(reachOf("offline", hook({ state: "disabled" }))).toBe("unreachable");
    expect(reachOf("live", null)).toBe("online");
  });

  it("puts it together per strand: a bot asleep with a working hook is green, without one red", () => {
    say("kate", "tech", 5);
    expect(board({ tech: "offline" }, { tech: hook() }).inPlay[0]).toMatchObject({ light: "green", reach: "hook" });
    expect(board({ tech: "offline" }).inPlay[0]).toMatchObject({ light: "red", reach: "unreachable" });
  });

  it("is red for a holder that was deactivated", () => {
    say("kate", "tech", 5);
    agents.revokeById(agents.getByName("tech")!.id, "admin");
    expect(board().inPlay[0]).toMatchObject({ light: "red", reach: "unreachable" });
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
