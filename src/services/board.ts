// The board: who has the ball between two agents, and whether it is moving.
//
// A strand is a PAIR of agents (A ↔ B, either way round), not a thread: the
// agents often go on in a new thread instead of replying in the old one, and
// a strand per thread left a ball in every abandoned thread (decision
// 06ae5d56). The ball lies with the RECIPIENT of the last direct message
// between the two, whichever thread it was in: whoever was written to last is
// the one expected to answer or deliver. Broadcasts move no ball.
//
//   done            the last message between them ends the strand
//   input_required  the sender needs a human: the ball is outside the mesh
//
// A holder whose own `working_on` says it waits for a human ("waiting for a
// human: …") is listed with them. A human is a role here, never a name.
//
// The light says whether the holder can be WOKEN and how long the ball has
// lain. Red means nobody can wake it: not online, and no hook whose last
// call succeeded. A reachable holder is green for a while, then yellow. A
// strand with nothing for a day, or done, is grey; a human's ball is neutral.
//
// Nothing of a message's text is shown: only who, to whom, which type and
// when. "Delivers next" is the holder's own `working_on`. The one thing read
// from a text is a RESULT LINK: a URL on a host the operator listed
// (MESH_RESULT_LINK_HOSTS), and only the link is shown, never the words
// around it; its label is the linked entity's title when moshi may ask for
// it (src/services/result-titles.ts), else the end of its id.

import type Database from "better-sqlite3";
import type { Presence, AgentWithPresence } from "./presence.js";
import type { WebhookStatus } from "./webhooks.js";
import { inboxKeyOf } from "./agent.js";

export const DONE_TYPE = "done";
export const INPUT_REQUIRED_TYPE = "input_required";
/** Types that hand over a result: the recipient is to pick it up. A message
 *  with a result link counts as well. */
export const DELIVERY_TYPES: readonly string[] = ["delivered", "review_result", "deploy_status"];
/** Actions listed per pair when a row is opened. */
export const HISTORY_LISTED = 10;
/** How much of a payload or context is searched for a result link. */
const LINK_SEARCH_CHARS = 65_536;

/** Start values. Minutes without movement, and hours until a strand is quiet. */
export const BOARD_THRESHOLDS = {
  greenMinutes: 15,
  quietHours: 24,
  /** How far back the board looks for strands at all. */
  windowDays: 7,
} as const;

/** How many finished or quiet strands the board still lists. */
export const QUIET_LISTED = 10;

/** `working_on` that says its agent waits for a human, in either language. */
const WAITS_FOR_HUMAN = /^\s*(wartet auf (einen |eine )?(mensch|menschen)|waiting (for|on) (a )?human|wait(s)? for (a )?human)\b/i;

export type Light = "green" | "yellow" | "red" | "grey" | "human";

/** A link to a result, on a host the operator allowed. */
export interface ResultLink {
  url: string;
  /** The entity id in its path (a UUID). */
  id: string;
  /** Its title, when known; else the view shows the end of the id. */
  title: string | null;
}

export interface Action {
  type: string;
  from: string;
  to: string;
  at: string;
  link: ResultLink | null;
}

/** Where result links may point, and what moshi knows of their titles. */
export interface ResultLinks {
  hosts: readonly string[];
  titleOf(id: string): string | null;
}

/** How the holder can be woken: by being online, by its hook, or not at all. */
export type Reach = "online" | "hook" | "stale" | "unreachable";

export interface BoardRow {
  /** The pair, independent of direction: what an opened row is kept by. */
  pairKey: string;
  /** The last message between the two delivered something: the holder is to pick it up. */
  delivered: boolean;
  /** The newest result link between the two, if any. */
  result: ResultLink | null;
  /** The last `HISTORY_LISTED` direct messages between the two, newest first. */
  history: Action[];
  /** The two agents, ordered: who moved the ball last first. */
  from: string;
  to: string;
  /** The newest thread between them: where the link goes. */
  threadId: string;
  /** The type of the last direct message (as the sender wrote it). */
  type: string;
  /** The agent holding the ball; null when it is with a human or done. */
  holder: string | null;
  /** The agent that waits for a human; null unless `humanBall`. */
  waiting: string | null;
  humanBall: boolean;
  done: boolean;
  /** When the ball came to its holder (ISO). */
  since: string;
  /** Last message between the two at all, broadcasts not counted (ISO). */
  lastActivity: string;
  light: Light;
  reach: Reach | null;
  /** The holder's (or the waiting agent's) `working_on`, as announced. */
  deliversNext: string | null;
  /** The holder holds a ball but says nothing about what comes next. */
  vagueNext: boolean;
  hook: WebhookStatus | null;
}

export interface Board {
  /** Strands whose ball is with a human. */
  waitingForHuman: BoardRow[];
  /** Strands where an agent has the ball: red, then yellow, then green; newest first in each. */
  inPlay: BoardRow[];
  /** Finished or quiet strands, newest first, at most `QUIET_LISTED`. */
  quiet: BoardRow[];
  /** At least one strand is open, and none is green. */
  nothingMoving: boolean;
}

interface LastBetween {
  pair: string;
  thread_id: string;
  from_agent: string;
  to_agent: string;
  to_key: string | null;
  type: string;
  created_at: string;
  last_activity: string;
}

/** The last direct message between every pair of agents with traffic in the window. */
export function lastBetweenPairs(db: Database.Database, now: number): LastBetween[] {
  const since = new Date(now - BOARD_THRESHOLDS.windowDays * 86_400_000).toISOString();
  return db
    .prepare(
      `WITH direct AS (
         SELECT COALESCE(correlation_id, id) AS thread_id, from_agent, to_agent, to_key, type, created_at, rowid AS rid,
                lower(COALESCE(from_key, from_agent)) AS a, lower(COALESCE(NULLIF(to_key, ''), to_agent)) AS b
           FROM messages WHERE created_at >= ? AND to_agent != 'broadcast'
       ),
       paired AS (SELECT direct.*, min(a, b) || char(31) || max(a, b) AS pair FROM direct),
       ranked AS (
         SELECT paired.*, ROW_NUMBER() OVER (PARTITION BY pair ORDER BY created_at DESC, rid DESC) AS rn,
                MAX(created_at) OVER (PARTITION BY pair) AS last_activity
           FROM paired
       )
       SELECT pair, thread_id, from_agent, to_agent, to_key, type, created_at, last_activity
         FROM ranked WHERE rn = 1
        ORDER BY created_at DESC
        LIMIT 500`,
    )
    .all(since) as LastBetween[];
}

/** A `working_on` that says nothing about the next delivery. */
export function isVague(workingOn: string | null | undefined): boolean {
  const text = (workingOn ?? "").trim();
  return text === "" || /^(idle|none|nothing|n\/a|-+|waiting|wartet|nichts|leer)\.?$/i.test(text);
}

export function waitsForHuman(workingOn: string | null | undefined): boolean {
  return WAITS_FOR_HUMAN.test(workingOn ?? "");
}

export function reachOf(presence: Presence | undefined, hook: WebhookStatus | null): Reach {
  if (presence === "live") return "online";
  if (hook && hook.state === "active" && hook.last_success_at !== null) return "hook";
  return presence === "stale" ? "stale" : "unreachable";
}

/**
 * The light of a strand that an agent holds. Red only when nobody can wake
 * the holder; a quiet one that may still look in is yellow; a reachable one
 * is green until the ball has lain for `greenMinutes`, then yellow.
 */
export function lightOf(reach: Reach, minutesSince: number): Light {
  if (reach === "unreachable") return "red";
  if (reach === "stale" || minutesSince >= BOARD_THRESHOLDS.greenMinutes) return "yellow";
  return "green";
}

/** Result links with a way to ask for the titles still missing. */
export type BoardLinks = ResultLinks & { want(ids: string[]): void };

/** The board as the page and its fragment show it. Titles it does not know
 *  yet are asked for afterwards, never waited for: the next refresh has them. */
export async function loadBoard(deps: {
  db: Database.Database;
  presence: { list(now?: number): Promise<AgentWithPresence[]> };
  webhooks: { statuses(): Map<string, WebhookStatus> };
  now: number;
  links?: BoardLinks;
}): Promise<Board> {
  const board = buildBoard({ db: deps.db, agents: await deps.presence.list(deps.now), hooks: deps.webhooks.statuses(), now: deps.now, links: deps.links });
  const unknown = [board.waitingForHuman, board.inPlay, board.quiet]
    .flat()
    .flatMap((r) => r.history.map((h) => h.link))
    .filter((l): l is ResultLink => l !== null && l.title === null)
    .map((l) => l.id);
  if (unknown.length > 0) deps.links?.want([...new Set(unknown)]);
  return board;
}

export interface BoardInputs {
  db: Database.Database;
  agents: AgentWithPresence[];
  hooks: Map<string, WebhookStatus>;
  now: number;
  /** Absent: no result links at all. */
  links?: ResultLinks;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Result links in `text`: https URLs on an allowed host with an entity id in
 *  their path. The last one wins: a message names its result at the end. */
export function resultLinksIn(text: string, hosts: readonly string[]): { url: string; id: string }[] {
  if (hosts.length === 0) return [];
  const found: { url: string; id: string }[] = [];
  for (const raw of text.match(/https:\/\/[^\s"'<>()[\]{}`]+/g) ?? []) {
    let u: URL;
    try {
      u = new URL(raw.replace(/[.,;:!?]+$/, ""));
    } catch {
      continue;
    }
    if (u.username || u.password || u.port !== "" || !hosts.includes(u.hostname.toLowerCase())) continue;
    const ids = u.pathname.match(UUID);
    if (ids) found.push({ url: u.toString(), id: ids[ids.length - 1]!.toLowerCase() });
  }
  return found;
}

interface Recent {
  pair: string;
  from_agent: string;
  to_agent: string;
  type: string;
  created_at: string;
  payload_head: string;
  context_head: string;
}

/** The newest direct messages of every pair in the window, up to `HISTORY_LISTED` each. */
function recentBetweenPairs(db: Database.Database, now: number): Map<string, Recent[]> {
  const since = new Date(now - BOARD_THRESHOLDS.windowDays * 86_400_000).toISOString();
  // A link search, not a preview: the head of a payload is enough to find a link.
  const rows = db
    .prepare(
      `WITH direct AS (
         SELECT from_agent, to_agent, type, created_at, rowid AS rid,
                substr(payload, 1, ${LINK_SEARCH_CHARS}) AS payload_head, substr(context, 1, ${LINK_SEARCH_CHARS}) AS context_head,
                lower(COALESCE(from_key, from_agent)) AS a, lower(COALESCE(NULLIF(to_key, ''), to_agent)) AS b
           FROM messages WHERE created_at >= ? AND to_agent != 'broadcast'
       ),
       ranked AS (
         SELECT direct.*, min(a, b) || char(31) || max(a, b) AS pair,
                ROW_NUMBER() OVER (PARTITION BY min(a, b) || char(31) || max(a, b) ORDER BY created_at DESC, rid DESC) AS rn
           FROM direct
       )
       SELECT pair, from_agent, to_agent, type, created_at, payload_head, context_head FROM ranked WHERE rn <= ${HISTORY_LISTED}
        ORDER BY created_at DESC`,
    )
    .all(since) as Recent[];
  const byPair = new Map<string, Recent[]>();
  for (const r of rows) byPair.set(r.pair, [...(byPair.get(r.pair) ?? []), r]);
  return byPair;
}

function historyOf(recent: Recent[], links: ResultLinks | undefined): Action[] {
  return recent.map((r) => {
    const found = links ? resultLinksIn(`${r.payload_head}\n${r.context_head}`, links.hosts) : [];
    const last = found[found.length - 1];
    return {
      type: r.type,
      from: r.from_agent,
      to: r.to_agent,
      at: r.created_at,
      link: last ? { ...last, title: links!.titleOf(last.id) } : null,
    };
  });
}

export function buildBoard({ db, agents, hooks, now, links }: BoardInputs): Board {
  const recent = recentBetweenPairs(db, now);
  const byKey = new Map(agents.map((a) => [inboxKeyOf(a.agent), a]));
  const byName = new Map(agents.map((a) => [a.agent.name.toLowerCase(), a]));
  const find = (key: string | null, name: string) => (key ? byKey.get(key) : undefined) ?? byName.get(name.toLowerCase());
  const quietAfter = BOARD_THRESHOLDS.quietHours * 3_600_000;

  const rows: BoardRow[] = lastBetweenPairs(db, now).map((m) => {
    const done = m.type === DONE_TYPE;
    const quiet = done || now - Date.parse(m.last_activity) >= quietAfter;
    const asked = !done && m.type === INPUT_REQUIRED_TYPE;
    const recipient = done || asked ? undefined : find(m.to_key, m.to_agent);
    const holderWaits = !quiet && Boolean(recipient) && waitsForHuman(recipient?.agent.working_on);
    const humanBall = !quiet && (asked || holderWaits);
    const waitingEntry = asked ? find(null, m.from_agent) : holderWaits ? recipient : undefined;
    const holderEntry = humanBall ? undefined : recipient;
    const hook = holderEntry ? hooks.get(inboxKeyOf(holderEntry.agent)) ?? null : null;
    const reach = done || humanBall ? null : holderEntry && holderEntry.agent.is_active ? reachOf(holderEntry.presence, hook) : "unreachable";
    const light: Light = quiet ? "grey" : humanBall ? "human" : lightOf(reach!, (now - Date.parse(m.created_at)) / 60_000);
    const deliversNext = (holderEntry ?? waitingEntry)?.agent.working_on ?? null;
    const history = historyOf(recent.get(m.pair) ?? [], links);
    const newest = history[0];
    return {
      pairKey: m.pair,
      delivered: !quiet && !humanBall && Boolean(newest) && (DELIVERY_TYPES.includes(newest!.type) || newest!.link !== null),
      result: history.find((h) => h.link)?.link ?? null,
      history,
      from: m.from_agent,
      to: m.to_agent,
      threadId: m.thread_id,
      type: m.type,
      holder: done || humanBall ? null : holderEntry?.agent.name ?? m.to_agent,
      waiting: humanBall ? waitingEntry?.agent.name ?? (asked ? m.from_agent : m.to_agent) : null,
      humanBall,
      done,
      since: m.created_at,
      lastActivity: m.last_activity,
      light,
      reach,
      deliversNext,
      vagueNext: !quiet && !humanBall && isVague(deliversNext),
      hook,
    };
  });

  const open = rows.filter((r) => r.light !== "grey");
  return {
    waitingForHuman: open.filter((r) => r.humanBall).sort(newestFirst),
    inPlay: open.filter((r) => !r.humanBall).sort(byUrgency),
    quiet: rows.filter((r) => r.light === "grey").sort(newestFirst).slice(0, QUIET_LISTED),
    nothingMoving: open.length > 0 && !open.some((r) => r.light === "green"),
  };
}

const URGENCY: Record<Light, number> = { red: 0, yellow: 1, green: 2, human: 3, grey: 4 };

function newestFirst(a: BoardRow, b: BoardRow): number {
  return b.since.localeCompare(a.since);
}

/** Red first, then yellow, then green; the newest first within each. */
function byUrgency(a: BoardRow, b: BoardRow): number {
  return URGENCY[a.light] - URGENCY[b.light] || newestFirst(a, b);
}
