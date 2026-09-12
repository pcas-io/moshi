// V2 Home — the "Daylight" landing page.
//
// The screen reads as a sentence before it reads as a dashboard: how many
// agents are awake, what moved through the mesh today, and whether anything
// wants the operator. Then the two things people actually read — the latest
// conversation and what every agent is working on — and a standing offer to
// connect one more.
//
// Gone from the SENTINEL version: the dark hero, the four-cell KPI band, the
// force-directed mesh topology (and `layout-engine.ts` with it), the recent
// activity list and the hidden avatar pool the SSE script used to clone from.
// The live thread stays: it is the one place on the dashboard where waiting
// for a reload would be wrong.

import type { FC } from "hono/jsx";
import { PRESENCE_TTL_SECONDS } from "../../types.js";
import type { Presence } from "../../services/presence.js";
import type { AttentionItem } from "../../services/attention.js";
import { V2Layout } from "./layout.js";
import { V2_TOKENS } from "./tokens.js";
import {
  CARD_STYLE,
  PRESENCE_COLOR,
  PRESENCE_WORD,
  V2Avatar,
  V2Btn,
} from "./components.js";
import { renderAvatarSvg } from "./avatar.js";
import {
  bubbleStyle,
  colStyle,
  headStyle,
  PREVIEW_MAX,
  rowStyle,
  THREAD_BOX_ID,
  threadScript,
  TIME_STYLE,
} from "./home-thread.js";

const T = V2_TOKENS;

/** The README is the product's documentation; there is no /docs route. */
const DOCS_URL = "https://github.com/pcas-io/moshi#readme";

// ── Props ───────────────────────────────────────────────────────
// `loadV2HomeData` in services/v2-home-data.ts fills everything below
// except `now` (tests pin it) and the two auth props the route adds.

export interface V2HomeAgent {
  id: string;
  name: string;
  role: string | null;
  presence: Presence;
  msg24: number;
  working_on: string | null;
  last_seen_at: string | null;
}

export interface V2HomeThread {
  correlation_id: string;
  /** The sender's own context line, shown after the participants. */
  context: string | null;
  /** Everyone in the thread, senders and recipients — may include "broadcast". */
  participants: string[];
  /** Full thread length; the card renders only the last few messages. */
  messageCount: number;
  messages: Array<{
    id: string;
    from: string;
    type: string;
    payload: string;
    created_at: string;
  }>;
}

/** The most recent incident of the last 24h, and who answered it. */
export interface V2HomeIncident {
  openedAt: string;
  closedBy: string | null;
  minutesToClose: number | null;
}

export interface V2HomeProps {
  stats: {
    agentsTotal: number;
    agentsLive: number;
    agentsStale: number;
    msg24h: number;
    threads: number;
    incidents24h: number;
  };
  agents: V2HomeAgent[];
  attention: AttentionItem[];
  latestIncident: V2HomeIncident | null;
  liveThread: V2HomeThread | null;
  /** Injectable clock — the date line, the incident wording and the live
   *  window all read it, and a test needs them to stand still. */
  now?: Date;
  userRole?: string;
  userName?: string;
  csrfToken?: string;
}

// ── Formatting ──────────────────────────────────────────────────

/** `Friday, 12 September · 14:16` — composed by hand because no locale
 *  puts the comma after the weekday AND the day before the month. */
function fmtDateLine(d: Date): string {
  const weekday = d.toLocaleDateString("en-GB", { weekday: "long" });
  const month = d.toLocaleDateString("en-GB", { month: "long" });
  return `${weekday}, ${d.getDate()} ${month} · ${fmtClock(d)}`;
}

function fmtClock(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function fmtTime(iso: string): string {
  return fmtClock(new Date(iso));
}

export function fmtRel(iso: string | null, now: number = Date.now()): string {
  if (!iso) return "—";
  const m = Math.round((now - new Date(iso).getTime()) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Show the message, not its envelope: a JSON payload's text field reads
 *  better in a bubble than the JSON does. */
export function previewPayload(rawStr: string, max: number = PREVIEW_MAX): string {
  try {
    const obj: unknown = JSON.parse(rawStr);
    if (typeof obj === "string") return obj.slice(0, max);
    if (obj && typeof obj === "object") {
      for (const key of ["text", "message", "summary", "payload"]) {
        const v = (obj as Record<string, unknown>)[key];
        if (typeof v === "string") return v.slice(0, max);
      }
    }
  } catch { /* not JSON — show it raw */ }
  return rawStr.slice(0, max);
}

// A sentence says "four agents", not "4 agents". Past twelve the word is
// longer than the number is useful, so the digits come back.
const NUMBER_WORDS = [
  "zero", "one", "two", "three", "four", "five", "six",
  "seven", "eight", "nine", "ten", "eleven", "twelve",
] as const;

function spell(n: number): string {
  return Number.isInteger(n) && n >= 0 && n < NUMBER_WORDS.length
    ? NUMBER_WORDS[n]!
    : String(n);
}

function sentenceCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * COPY.md §4 — the headline variants, in this order.
 *
 * The copy ships four, and every one of them assumes at least two agents:
 * at `total === 1` they read "One of your one agents is awake." and
 * "All one of your agents are awake and talking." That is the first-run
 * screen, so it gets its own sentence rather than broken grammar. The
 * deviation is deliberate and wants a COPY.md entry.
 */
export function homeHeadline(live: number, total: number): string {
  if (live === 0) return "Nobody is online right now.";
  if (total === 1) return "Your one agent is awake and talking.";
  if (live === 1) return `One of your ${spell(total)} agents is awake.`;
  if (live === total) return `All ${spell(total)} of your agents are awake and talking.`;
  return `${sentenceCase(spell(live))} of your ${spell(total)} agents are awake and talking.`;
}

function partOfDay(d: Date): string {
  const h = d.getHours();
  if (h < 12) return "morning";
  if (h < 18) return "afternoon";
  return "evening";
}

// ── Headline block ──────────────────────────────────────────────

const COUNTER_BOX =
  `background:${T.card};border:1px solid ${T.line};border-radius:${T.radiusInner}px;padding:14px 18px;min-width:120px`;

const Counter: FC<{ dot: string; value: number; label: string }> = ({ dot, value, label }) => (
  <div style={COUNTER_BOX}>
    <div style="display:flex;align-items:center;gap:7px">
      <span style={`width:8px;height:8px;border-radius:50%;background:${dot}`} />
      <span style="font-size:22px;font-weight:600;letter-spacing:-0.02em">{value}</span>
    </div>
    <div style={`font-size:13px;color:${T.dim};margin-top:2px`}>{label}</div>
  </div>
);

const Headline: FC<{
  stats: V2HomeProps["stats"];
  incident: V2HomeIncident | null;
  now: Date;
}> = ({ stats, incident, now }) => {
  const asleep = Math.max(0, stats.agentsTotal - stats.agentsLive - stats.agentsStale);
  return (
    <div class="m-rise" style="display:flex;gap:20px;align-items:flex-start;flex-wrap:wrap;margin-bottom:26px">
      <div style="flex:1 1 420px;min-width:0">
        {/* `dim` is rated against `card`; this line sits on `paper`, where it
            measures 4.20:1. `faint` is the contract's fallback at 5.13:1. */}
        <div style={`font-size:13px;color:${T.faint};margin-bottom:6px`}>{fmtDateLine(now)}</div>
        <h1 style="margin:0 0 10px;font-size:clamp(26px,3.2vw,34px);font-weight:600;letter-spacing:-0.025em;line-height:1.2">
          {homeHeadline(stats.agentsLive, stats.agentsTotal)}
        </h1>
        <p style={`margin:0;font-size:16px;color:${T.body};max-width:62ch`}>
          {`${plural(stats.msg24h, "message", "messages")} moved through the mesh today ` +
            `across ${plural(stats.threads, "thread", "threads")}.`}
          <IncidentClause count={stats.incidents24h} incident={incident} />
        </p>
      </div>
      {/* `flex:0 0 auto` alone pins the strip at its one-line max-content
          (3 × 120px + gaps = 380px), which scrolls a 360px phone sideways
          before the counters ever get to wrap. `max-width` clamps the
          hypothetical size instead, so they wrap as §5 intends. */}
      <div style="flex:0 0 auto;max-width:100%;display:flex;gap:10px;flex-wrap:wrap">
        <Counter dot={PRESENCE_COLOR.live} value={stats.agentsLive} label="online now" />
        <Counter dot={PRESENCE_COLOR.stale} value={stats.agentsStale} label="quiet a while" />
        <Counter dot={PRESENCE_COLOR.offline} value={asleep} label="asleep" />
      </div>
    </div>
  );
};

/**
 * COPY.md §4 sentence two. The copy names the agent who closed the incident
 * and how long it took, so both come from the database — saying "closed it
 * 12 minutes later" without knowing that would be an invention, and saying
 * "this afternoon" at nine in the morning would be another.
 */
const IncidentClause: FC<{ count: number; incident: V2HomeIncident | null }> = ({ count, incident }) => {
  if (count <= 0) return null;
  const when = incident ? `this ${partOfDay(new Date(incident.openedAt))}` : "today";
  const closer = incident?.closedBy;
  const later = incident?.minutesToClose
    ? plural(incident.minutesToClose, "minute", "minutes")
    : null;

  if (count === 1) {
    return closer && later
      ? (
        <>
          {` One incident came in ${when} and `}
          <strong style="font-weight:600">{closer}</strong>
          {` closed it ${later} later.`}
        </>
      )
      : <>{` One incident came in ${when} and nobody has answered it yet.`}</>;
  }
  const head = `${sentenceCase(spell(count))} incidents came in today`;
  return closer && later
    ? (
      <>
        {` ${head} — `}
        <strong style="font-weight:600">{closer}</strong>
        {` closed the latest one ${later} later.`}
      </>
    )
    : <>{` ${head}, and the latest one is still unanswered.`}</>;
};

// ── Needs-attention band ────────────────────────────────────────

/** Two named items at most; a third and beyond live in the count. */
const ATTENTION_SHOWN = 2;

const BAND_TITLE: Record<number, string> = {
  1: "One thing wants your attention",
  2: "Two things want your attention",
};

const AttentionBand: FC<{ items: AttentionItem[] }> = ({ items }) => {
  const n = items.length;
  if (n === 0) return null;
  const title = BAND_TITLE[n] ?? `${n} things want your attention`;
  const label = n === 1 ? "Review it" : n === 2 ? "Review both" : `Review all ${n}`;
  // buildAttentionItems returns the list in priority order, so the first item
  // is the one to act on first — and there is no page that shows all three
  // sources at once to send the button to instead.
  const href = items[0]!.href;
  const shown = items.slice(0, ATTENTION_SHOWN);

  return (
    <div
      style={`background:${T.amberSoft};border:1px solid ${T.amberLine};border-radius:${T.radiusBox}px;` +
        "padding:18px 20px;display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap;margin-bottom:26px"}
    >
      <span
        aria-hidden="true"
        style={`width:26px;height:26px;border-radius:9px;background:${T.amber};color:${T.card};` +
          "display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0"}
      >
        !
      </span>
      <div style="flex:1 1 320px;min-width:0">
        <div style="font-size:15px;font-weight:600;margin-bottom:3px">{title}</div>
        {/* amberInk is too saturated for a full line of body text; this is
            the band's reading colour, 6.3:1 on amberSoft. */}
        <div style="font-size:14px;color:#63594a">
          {shown.map((item, i) => (
            <span key={item.href + String(i)}>
              {i > 0 ? " · " : ""}
              {item.agent ? <strong style="font-weight:600">{item.agent}</strong> : null}
              {`${item.agent ? " " : ""}${item.text}${i === shown.length - 1 ? "." : ""}`}
            </span>
          ))}
        </div>
      </div>
      <V2Btn
        kind="white"
        href={href}
        style={`border-color:#e0cfa8;color:${T.amberInk};padding:9px 15px;border-radius:9px`}
      >
        {label}
      </V2Btn>
    </div>
  );
};

// ── Card A — Latest conversation ────────────────────────────────

const CARD_SHELL = `${CARD_STYLE};overflow:hidden`;
const CARD_HEAD = `padding:18px 22px 14px;border-bottom:1px solid ${T.lineSoft}`;
const CARD_H2 = "margin:0;font-size:16px;font-weight:600";
const CARD_SUB = `font-size:13px;color:${T.dim}`;

/** Messages shown in the card; the footer still counts the whole thread. */
const BUBBLES_SHOWN = 4;

/** `to_agent` sentinel for a message sent to everyone (message-queries.ts). */
const BROADCAST = "broadcast";

/** `participants` carries recipients too, so it can hold the wire sentinel.
 *  It is a destination, not a party to the conversation. */
function namedParticipants(thread: V2HomeThread | null): string[] {
  return (thread?.participants ?? []).filter((p) => p !== BROADCAST);
}

/** COPY.md §7 — the same title the Conversations screen gives this thread. */
function threadTitle(thread: V2HomeThread | null): string {
  const [a, b] = namedParticipants(thread);
  if (!a) return "";
  if (thread?.participants.includes(BROADCAST)) return `${a} and everyone`;
  return b ? `${a} and ${b}` : a;
}

/** One side of the conversation sits right for the whole card — the second
 *  named participant, the way the Conversations screen orders them. The
 *  server render and the SSE script must agree on it, so both ask here. */
function rightSide(thread: V2HomeThread | null): string {
  return (namedParticipants(thread)[1] ?? "").toLowerCase();
}

const LatestConversation: FC<{
  thread: V2HomeThread | null;
  agents: V2HomeAgent[];
  now: Date;
}> = ({ thread, agents, now }) => {
  const roleOf = (name: string): string | undefined =>
    agents.find((a) => a.name.toLowerCase() === name.toLowerCase())?.role ?? undefined;
  const presenceOf = (name: string): Presence | undefined =>
    agents.find((a) => a.name.toLowerCase() === name.toLowerCase())?.presence;

  const messages = thread?.messages ?? [];
  const sub = [threadTitle(thread), thread?.context].filter(Boolean).join(" · ");
  const mine = rightSide(thread);
  const last = messages[messages.length - 1];
  const isLive = Boolean(
    last &&
    now.getTime() - new Date(last.created_at).getTime() < PRESENCE_TTL_SECONDS * 1000 &&
    namedParticipants(thread).some((p) => presenceOf(p) === "live"),
  );

  return (
    <section style={CARD_SHELL}>
      <div style={`${CARD_HEAD};display:flex;align-items:center;gap:12px`}>
        <div style="flex:1;min-width:0">
          <h2 style={CARD_H2}>Latest conversation</h2>
          {sub ? <div style={CARD_SUB}>{sub}</div> : null}
        </div>
        {isLive && (
          <span
            style={`display:inline-flex;align-items:center;gap:6px;font-size:12px;color:${T.greenDeep};` +
              `background:${T.greenSoft};padding:4px 10px;border-radius:${T.radiusPill}px`}
          >
            <span class="m-pulse" style={`width:6px;height:6px;border-radius:50%;background:${T.live}`} />
            live
          </span>
        )}
      </div>

      <div
        id={THREAD_BOX_ID}
        style="padding:18px 22px;display:flex;flex-direction:column;gap:14px;max-height:340px;overflow-y:auto"
      >
        {messages.length === 0 ? (
          <div data-empty="1" style={`font-size:14px;color:${T.faint};padding:26px 0;text-align:center`}>
            Nothing here yet · しずか — no conversations so far.
          </div>
        ) : (
          messages.slice(-BUBBLES_SHOWN).map((m) => {
            const isMine = m.from.toLowerCase() === mine;
            return (
              <div key={m.id} data-msg-id={m.id} style={rowStyle(isMine)}>
                <V2Avatar name={m.from} role={roleOf(m.from)} size={28} bordered />
                <div style={colStyle(isMine)}>
                  <div style={headStyle(isMine)}>
                    <span style="font-size:13px;font-weight:600">{m.from}</span>
                    <span style={TIME_STYLE} title={fmtRel(m.created_at, now.getTime())}>
                      {fmtTime(m.created_at)}
                    </span>
                  </div>
                  <div style={bubbleStyle(isMine)}>{previewPayload(m.payload)}</div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {thread && (
        <div
          style={`padding:14px 22px;border-top:1px solid ${T.lineSoft};display:flex;gap:12px;align-items:center;flex-wrap:wrap`}
        >
          <a
            href={`/conversations?id=${encodeURIComponent(thread.correlation_id)}`}
            style="font-size:14px;font-weight:600"
          >
            Read the whole thread →
          </a>
          <span style="flex:1" />
          <span style={`font-size:13px;color:${T.faint}`}>
            {plural(thread.messageCount, "message", "messages")}
          </span>
        </div>
      )}
    </section>
  );
};

// ── Card B — What everyone is working on ────────────────────────

/** COPY.md §6 words, with `never seen` folded into `asleep` — Home has no
 *  room for the distinction, the Agents table makes it. */
function presenceWord(p: Presence): string {
  return PRESENCE_WORD[p === "never" ? "offline" : p];
}

/** `dim` fails 4.5:1 on these grounds at 12px, so the pills read in `faint`. */
const PRESENCE_PILL: Record<Presence, readonly [string, string]> = {
  live: [T.greenDeep, T.greenSoft],
  stale: [T.amberInk, T.amberSoft],
  offline: [T.faint, T.subtle],
  never: [T.faint, T.subtle],
};

/** Rows shown before the footer link takes over. */
const AGENT_ROWS_SHOWN = 5;

const WorkingOn: FC<{ agents: V2HomeAgent[]; total: number }> = ({ agents, total }) => (
  <section style={CARD_SHELL}>
    <div style={CARD_HEAD}>
      <h2 style={CARD_H2}>What everyone is working on</h2>
      <div style={CARD_SUB}>From each agent's last mesh_register call</div>
    </div>
    <div>
      {agents.slice(0, AGENT_ROWS_SHOWN).map((a) => {
        const [ink, ground] = PRESENCE_PILL[a.presence];
        return (
          <div
            key={a.id}
            class="d-row"
            style={`display:flex;gap:12px;align-items:center;padding:13px 22px;border-bottom:1px solid ${T.lineRow}`}
          >
            <V2Avatar name={a.name} role={a.role} size={34} bordered />
            <div style="flex:1;min-width:0">
              <div style="display:flex;align-items:center;gap:7px">
                <span style="font-size:14px;font-weight:600">{a.name}</span>
                <span
                  style={`font-size:12px;color:${ink};background:${ground};padding:1px 9px;border-radius:${T.radiusPill}px`}
                >
                  {presenceWord(a.presence)}
                </span>
              </div>
              <div
                style={`font-size:13.5px;color:${a.working_on ? T.body : T.faint};` +
                  "overflow:hidden;text-overflow:ellipsis;white-space:nowrap"}
              >
                {a.working_on || "Nothing announced"}
              </div>
            </div>
            <div style="text-align:right;flex-shrink:0">
              <div style="font-size:14px;font-weight:600">{a.msg24}</div>
              <div style={`font-size:11.5px;color:${T.faint}`}>msgs today</div>
            </div>
          </div>
        );
      })}
    </div>
    <div style="padding:14px 22px">
      <a href="/agents" style="font-size:14px;font-weight:600">All {total} agents →</a>
    </div>
  </section>
);

// ── Connect prompt ──────────────────────────────────────────────

const CONNECT_HEADING = "Adding an agent takes about a minute";
const CONNECT_BODY =
  "Name it, copy the token, paste one command into your client. " +
  "We'll wait for its first handshake and tell you when it's in.";
const BIG_BTN = "font-size:15px;padding:12px 20px";

const ConnectButtons: FC<{ justify?: string }> = ({ justify }) => (
  <div style={`display:flex;gap:10px;flex-wrap:wrap;${justify ? `justify-content:${justify}` : ""}`}>
    <V2Btn kind="primary" href="/agents/connect" style={BIG_BTN}>Connect an agent</V2Btn>
    <V2Btn kind="secondary" href={DOCS_URL} style={BIG_BTN}>Read the docs</V2Btn>
  </div>
);

const ConnectPrompt: FC = () => (
  <section
    style={`${CARD_STYLE};padding:24px;display:grid;` +
      "grid-template-columns:repeat(auto-fit,minmax(min(260px,100%),1fr));gap:22px;align-items:center"}
  >
    <div>
      <h2 style="margin:0 0 6px;font-size:17px;font-weight:600">{CONNECT_HEADING}</h2>
      <p style={`margin:0;font-size:14.5px;color:${T.body}`}>{CONNECT_BODY}</p>
    </div>
    <ConnectButtons justify="flex-end" />
  </section>
);

/** Zero agents: the invitation is the page, not a footnote under an empty one. */
const ConnectHero: FC = () => (
  <section
    class="m-rise"
    style={`${CARD_STYLE};padding:56px clamp(24px,5vw,56px);margin:26px auto 0;max-width:720px`}
  >
    <div style={`font-size:13px;color:${T.dim};margin-bottom:6px`}>
      No agents yet · まだ — connect your first one.
    </div>
    <h1 style="margin:0 0 10px;font-size:clamp(26px,3.2vw,34px);font-weight:600;letter-spacing:-0.025em;line-height:1.2">
      {CONNECT_HEADING}
    </h1>
    <p style={`margin:0 0 22px;font-size:16px;color:${T.body};max-width:62ch`}>{CONNECT_BODY}</p>
    <ConnectButtons />
  </section>
);

// ── Page ────────────────────────────────────────────────────────

export const V2HomePage: FC<V2HomeProps> = ({
  stats, agents, attention, latestIncident, liveThread, now, userRole, userName, csrfToken,
}) => {
  const clock = now ?? new Date();
  const empty = stats.agentsTotal === 0;
  const mine = rightSide(liveThread);
  // Only the thread's own parties. The whole roster would inline up to
  // MAX_AGENTS emblems at ~850 bytes each into a script that draws two or
  // three; an unknown sender falls back to the plain bordered box.
  const emblems: Record<string, string> = {};
  if (liveThread) {
    const parties = new Set(namedParticipants(liveThread).map((p) => p.toLowerCase()));
    for (const a of agents) {
      const key = a.name.toLowerCase();
      if (parties.has(key)) emblems[key] = renderAvatarSvg(a.name, a.role ?? undefined, { size: 28 });
    }
  }

  return (
    <V2Layout title="Home" active="HOME" userRole={userRole} userName={userName} csrfToken={csrfToken}>
      {empty ? (
        <ConnectHero />
      ) : (
        <>
          <Headline stats={stats} incident={latestIncident} now={clock} />
          <AttentionBand items={attention} />
          <div
            style="display:grid;grid-template-columns:repeat(auto-fit,minmax(min(460px,100%),1fr));gap:18px;margin-bottom:26px"
          >
            <LatestConversation thread={liveThread} agents={agents} now={clock} />
            <WorkingOn agents={agents} total={stats.agentsTotal} />
          </div>
          <ConnectPrompt />
          {liveThread && threadScript(liveThread.correlation_id, mine, emblems)}
        </>
      )}
    </V2Layout>
  );
};
