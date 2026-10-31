// The board: who has the ball in each conversation, and whether it is moving.
//
// A strand is a moshi thread. Its ball lies with the RECIPIENT of its last
// direct message: whoever was written to last is the one expected to answer
// or deliver. Broadcasts move no ball. Two message types say more than that:
//
//   done            the strand is finished; nobody holds a ball
//   input_required  the ball is with a human, not with an agent: the sender
//                   needs a decision or an answer from outside the mesh
//
// No person is named anywhere here: the human is a role. The light measures
// whether the holder can be REACHED (online, or a hook that last succeeded:
// a bot that sleeps between wake-up calls is reachable all the same) and how
// long the ball has lain. A strand with nothing for a day goes grey.
//
// Nothing of a message's text is used: only who, to whom, which type and
// when. "Delivers next" is the holder's own `working_on`.

import type Database from "better-sqlite3";
import type { Presence, AgentWithPresence } from "./presence.js";
import type { WebhookStatus } from "./webhooks.js";
import { inboxKeyOf } from "./agent.js";

export const DONE_TYPE = "done";
export const INPUT_REQUIRED_TYPE = "input_required";

/** Start values. Minutes without movement, and hours until a strand is quiet. */
export const BOARD_THRESHOLDS = {
  greenMinutes: 15,
  redMinutes: 45,
  quietHours: 24,
  /** How far back the board looks for strands at all. */
  windowDays: 7,
} as const;

/** How many finished or quiet strands the board still lists. */
export const QUIET_LISTED = 10;

export type Light = "green" | "yellow" | "red" | "grey";

/** How the holder can be woken: by its hook, by being online, or not at all. */
export type Reach = "online" | "hook" | "stale" | "unreachable";

export interface BoardRow {
  threadId: string;
  /** Who moved the ball last, and to whom. */
  from: string;
  to: string;
  /** The type of that message (as the sender wrote it). */
  type: string;
  /** The agent holding the ball; null when a human holds it or nobody does. */
  holder: string | null;
  humanBall: boolean;
  done: boolean;
  /** When the ball came to its holder (ISO). */
  since: string;
  /** Last message of the strand at all (ISO). */
  lastActivity: string;
  light: Light;
  reach: Reach | null;
  /** The holder's `working_on`, as it announced it. */
  deliversNext: string | null;
  /** The holder holds a ball but says nothing about what comes next. */
  vagueNext: boolean;
  hook: WebhookStatus | null;
}

export interface Board {
  /** Strands where a human has the ball. */
  waitingForHuman: BoardRow[];
  /** Strands where an agent has the ball. */
  inPlay: BoardRow[];
  /** Finished or quiet strands, newest first, at most `QUIET_LISTED`. */
  quiet: BoardRow[];
  /** At least one strand is in play or waits for a human, and none is green. */
  nothingMoving: boolean;
}

interface LastDirect {
  thread_id: string;
  from_agent: string;
  to_agent: string;
  to_key: string | null;
  type: string;
  created_at: string;
  last_activity: string;
}

/** The last direct message of every thread with traffic in the window. */
export function lastDirectMessages(db: Database.Database, now: number): LastDirect[] {
  const since = new Date(now - BOARD_THRESHOLDS.windowDays * 86_400_000).toISOString();
  return db
    .prepare(
      `WITH recent AS (
         SELECT COALESCE(correlation_id, id) AS thread_id, from_agent, to_agent, to_key, type, created_at, rowid AS rid
           FROM messages WHERE created_at >= ?
       ),
       activity AS (SELECT thread_id, MAX(created_at) AS last_activity FROM recent GROUP BY thread_id),
       ranked AS (
         SELECT recent.*, ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY created_at DESC, rid DESC) AS rn
           FROM recent WHERE to_agent != 'broadcast'
       )
       SELECT r.thread_id, r.from_agent, r.to_agent, r.to_key, r.type, r.created_at, a.last_activity
         FROM ranked r JOIN activity a ON a.thread_id = r.thread_id
        WHERE r.rn = 1
        ORDER BY r.created_at DESC
        LIMIT 500`,
    )
    .all(since) as LastDirect[];
}

/** A `working_on` that says nothing about the next delivery. */
export function isVague(workingOn: string | null | undefined): boolean {
  const text = (workingOn ?? "").trim();
  return text === "" || /^(idle|none|nothing|n\/a|-+|waiting|wartet|nichts|leer)\.?$/i.test(text);
}

export function reachOf(presence: Presence | undefined, hook: WebhookStatus | null): Reach {
  if (presence === "live") return "online";
  if (hook && hook.state === "active" && hook.last_success_at !== null) return "hook";
  return presence === "stale" ? "stale" : "unreachable";
}

/**
 * The light of a strand that an agent holds. Reachable holders go by time;
 * a quiet one that may still look in is yellow at best; one that cannot be
 * reached is red.
 */
export function lightOf(reach: Reach, minutesSince: number): Light {
  if (reach === "unreachable" || minutesSince >= BOARD_THRESHOLDS.redMinutes) return "red";
  if (reach === "stale" || minutesSince >= BOARD_THRESHOLDS.greenMinutes) return "yellow";
  return "green";
}

/** The board as the page and its fragment show it. */
export async function loadBoard(deps: {
  db: Database.Database;
  presence: { list(now?: number): Promise<AgentWithPresence[]> };
  webhooks: { statuses(): Map<string, WebhookStatus> };
  now: number;
}): Promise<Board> {
  return buildBoard({ db: deps.db, agents: await deps.presence.list(deps.now), hooks: deps.webhooks.statuses(), now: deps.now });
}

export interface BoardInputs {
  db: Database.Database;
  agents: AgentWithPresence[];
  hooks: Map<string, WebhookStatus>;
  now: number;
}

export function buildBoard({ db, agents, hooks, now }: BoardInputs): Board {
  const byKey = new Map(agents.map((a) => [inboxKeyOf(a.agent), a]));
  const byName = new Map(agents.map((a) => [a.agent.name.toLowerCase(), a]));
  const quietAfter = BOARD_THRESHOLDS.quietHours * 3_600_000;

  const rows: BoardRow[] = lastDirectMessages(db, now).map((m) => {
    const done = m.type === DONE_TYPE;
    const humanBall = !done && m.type === INPUT_REQUIRED_TYPE;
    const holderEntry = done || humanBall ? undefined : (m.to_key ? byKey.get(m.to_key) : undefined) ?? byName.get(m.to_agent.toLowerCase());
    const holderKey = holderEntry ? inboxKeyOf(holderEntry.agent) : null;
    const hook = holderKey ? hooks.get(holderKey) ?? null : null;
    const quiet = now - Date.parse(m.last_activity) >= quietAfter;
    const minutesSince = (now - Date.parse(m.created_at)) / 60_000;
    const reach = done || humanBall ? null : holderEntry && holderEntry.agent.is_active ? reachOf(holderEntry.presence, hook) : "unreachable";
    const light: Light = done || quiet ? "grey" : humanBall ? "red" : lightOf(reach!, minutesSince);
    const deliversNext = holderEntry?.agent.working_on ?? null;
    return {
      threadId: m.thread_id,
      from: m.from_agent,
      to: m.to_agent,
      type: m.type,
      holder: done || humanBall ? null : holderEntry?.agent.name ?? m.to_agent,
      humanBall,
      done,
      since: m.created_at,
      lastActivity: m.last_activity,
      light,
      reach,
      deliversNext,
      vagueNext: light !== "grey" && !humanBall && isVague(deliversNext),
      hook,
    };
  });

  const live = rows.filter((r) => r.light !== "grey");
  const waitingForHuman = live.filter((r) => r.humanBall);
  const inPlay = live.filter((r) => !r.humanBall).sort(byUrgency);
  return {
    waitingForHuman,
    inPlay,
    quiet: rows.filter((r) => r.light === "grey").slice(0, QUIET_LISTED),
    nothingMoving: live.length > 0 && !live.some((r) => r.light === "green"),
  };
}

const URGENCY: Record<Light, number> = { red: 0, yellow: 1, green: 2, grey: 3 };

/** Red first, then yellow, then green; the longest-lying ball first within each. */
function byUrgency(a: BoardRow, b: BoardRow): number {
  return URGENCY[a.light] - URGENCY[b.light] || a.since.localeCompare(b.since);
}
