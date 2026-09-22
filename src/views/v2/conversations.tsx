// V2 Conversations — "Daylight": a sunk thread panel on the left, the open
// thread on the right, and a footer that explains why the dashboard cannot
// reply (ADR-004) and hands over the command that can. The READ-ONLY badge
// is gone: say why, then give the reader the thing that does the job.

import type { FC } from "hono/jsx";
import { raw } from "hono/html";
import type { ConversationSummary, ConversationThread, MessageView } from "../../services/message-queries.js";
import type { PaginatedResult } from "../../types.js";
import { DEFAULT_PREVIEW_CHARS, PRESENCE_TTL_SECONDS } from "../../types.js";
import { MCP_TOOL_CATALOG } from "../../mcp/catalog.js";
import { CONTAINER_APP, V2Layout } from "./layout.js";
import { V2Avatar, kindLabel } from "./components.js";
import { V2_FONT_FAMILY_MONO, V2_TOKENS, kindColors } from "./tokens.js";

const T = V2_TOKENS;

export interface V2ConversationsProps {
  /** The list: summaries, no message bodies. */
  result: PaginatedResult<ConversationSummary>;
  /** The open thread. The ROUTE decides: the one `?id=` names, wherever in
   *  the history it is, else the first of this page. */
  opened: ConversationThread | null;
  /** `?id=` that matched nothing. The pane says so instead of showing some
   *  other thread, which is what the old fallback did. */
  unknownId?: string;
  /** Render clock. Injected so page and fragment agree to the millisecond. */
  now?: number;
  query?: string;
  /** Only threads this agent took part in (`?agent=`). */
  filterAgent?: string;
  /** Drives the emblem's role stripe. Keyed on the agent name. */
  agentRoles: Record<string, string | null>;
  csrfToken?: string;
  userRole?: string;
  userName?: string;
}

// ── Constants ───────────────────────────────────────────────────
/** `to_agent` sentinel for a message sent to everyone (message-queries.ts). */
const BROADCAST = "broadcast";

/**
 * A thread reads as "still moving" for the same window in which an agent
 * still reads as online, so the dashboard's two live signals cannot
 * disagree with one another.
 */
const LIVE_WINDOW_MS = PRESENCE_TTL_SECONDS * 1000;

/** Safety cap only — the visible limit is the two-line CSS clamp. */
const ROW_PREVIEW_CHARS = 320;

// Three border values the palette has no token for (spec §9). Named for
// their use rather than folded into an existing token, because every
// existing border token is already spoken for at a measured contrast.
const LINE_THREAD_ROW = "#f2ece2";   // separator that reads on the sunk panel
const BUBBLE_LINE_OWN = "#cfe9d7";   // one step lighter than greenLine
const BUBBLE_LINE_OTHER = "#eae3d7"; // between line and lineStrong

/** Read from the catalog so a tool rename cannot leave this sentence behind. */
const REPLY_TOOL =
  MCP_TOOL_CATALOG.find((tool) => tool.name.endsWith("_reply"))?.name ?? "mesh_reply";

/** The command a reader would actually run to answer the open thread. */
function replyCommand(messageId: string): string {
  return `moshi reply ${messageId} "ack — watching the error rate"`;
}

// ── Formatting ──────────────────────────────────────────────────
function fmtTime(iso: string): string {
  return new Date(iso).toTimeString().slice(0, 5);
}

function fmtRel(iso: string, now: number): string {
  const min = Math.round((now - new Date(iso).getTime()) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function dayKey(iso: string): string {
  return new Date(iso).toDateString();
}

/** "Today, 12 September" · "Yesterday, 11 September" · "Friday, 5 September". */
function dayLabel(iso: string, now: Date): string {
  const day = new Date(iso);
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const prefix =
    day.toDateString() === now.toDateString() ? "Today"
    : day.toDateString() === yesterday.toDateString() ? "Yesterday"
    : day.toLocaleDateString("en-GB", { weekday: "long" });
  return `${prefix}, ${day.getDate()} ${day.toLocaleDateString("en-GB", { month: "long" })}`;
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Payloads travel as JSON; show the field a person would read. */
function previewPayload(payload: string, max: number): string {
  try {
    const parsed: unknown = JSON.parse(payload);
    if (typeof parsed === "string") return clip(parsed, max);
    if (parsed && typeof parsed === "object") {
      for (const key of ["text", "message", "summary", "payload"]) {
        const value = (parsed as Record<string, unknown>)[key];
        if (typeof value === "string") return clip(value, max);
      }
    }
  } catch { /* not JSON — fall through to the raw string */ }
  return clip(payload, max);
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function isLive(iso: string, now: number): boolean {
  return now - new Date(iso).getTime() < LIVE_WINDOW_MS;
}

// ── Thread identity ─────────────────────────────────────────────
interface ThreadParties {
  a: string;
  b: string | undefined;
  isBroadcast: boolean;
  /** "a and b", never "a → b" — a thread is a conversation, not a direction. */
  title: string;
}

function partiesOf(thread: ConversationSummary): ThreadParties {
  const isBroadcast = thread.participants.includes(BROADCAST);
  const named = thread.participants.filter((p) => p !== BROADCAST);
  const a = named[0] ?? BROADCAST;
  const b = named[1];
  const title = isBroadcast ? `${a} and everyone` : b ? `${a} and ${b}` : a;
  return { a, b, isBroadcast, title };
}

function metaLine(thread: ConversationSummary, now: number): string {
  const parts = [plural(thread.message_count, "message")];
  if (thread.first_context) parts.push(`about ${thread.first_context}`);
  parts.push(`last activity ${fmtRel(thread.last_activity, now)}`);
  return parts.join(" · ");
}

// ── Styles that an inline attribute cannot express ──────────────
// `d-row` from components.tsx fills with `sunk`, which is this panel's own
// ground — invisible here. A thread row lifts to `card` instead.
// The split is as tall as the viewport leaves (header, footer and the gap
// above the footer: 64 + 84 + 12 px), never taller: with 50 threads the list
// panel was 6283 px tall, both panes stretched to it, the inner scrollers
// never scrolled, and on a phone the open thread began some 6400 px down.
// Stacked (below about 790 px), the list takes at most 45dvh and the thread
// the rest; a row link jumps to #thread, so a tap lands on the thread.
const CONVOS_CSS = `
.d-thread { display: block; text-decoration: none; color: inherit; }
.d-thread:hover { background: var(--card); }
.d-search::placeholder { color: ${T.faint}; }
.d-list-panel { flex: 1 1 330px; max-width: 400px; min-width: 290px; min-height: 0; max-height: 45dvh; }
.d-thread-pane { flex: 1 1 460px; min-width: 0; min-height: 0; }
/* Side by side (the width at which the two flex bases stop fitting): each
   pane takes the split's height and scrolls inside. Stacked, the list keeps
   its 45dvh share and the thread takes the rest. */
@media (min-width: 790px) {
  .d-list-panel, .d-thread-pane { max-height: 100%; }
}
`;

const SPLIT_STYLE =
  // `flex:0 0 auto`, not `flex:1`: in a column flex container flex-basis is
  // the main size, so `flex:1` (basis 0, grow 1) made `height` moot and the
  // split grew to its content again — 5254 px with 50 threads.
  "flex:0 0 auto;display:flex;flex-wrap:wrap;align-items:stretch;gap:0;" +
  "height:calc(100dvh - 160px);min-height:420px;overflow:hidden;" +
  `border-left:1px solid ${T.line};border-right:1px solid ${T.line};background:${T.card}`;

const PANEL_STYLE =
  `border-right:1px solid ${T.line};display:flex;flex-direction:column;background:${T.sunk}`;

const SEARCH_STYLE =
  `width:100%;margin-top:14px;background:${T.card};border:1px solid ${T.lineStrong};` +
  `border-radius:${T.radiusControl}px;font-size:13.5px;padding:10px 13px;outline:none;color:${T.ink}`;

const COPY_BTN_STYLE =
  `position:absolute;top:12px;right:12px;background:${T.codeBtn};border:none;border-radius:8px;` +
  "color:#ffffff;font-size:12px;font-weight:600;cursor:pointer;padding:6px 11px";

// ── Pieces ──────────────────────────────────────────────────────
/** Amber `all` badge: the second participant of a broadcast is everyone. */
const AllBadge: FC = () => (
  <span
    style={`width:22px;height:22px;border-radius:7px;background:${T.amberSoft};color:${T.amberInk};` +
      "display:inline-flex;align-items:center;justify-content:center;font-size:11px;flex-shrink:0"}
  >
    all
  </span>
);

/** Label and colour in one place so the two lookups cannot drift. */
const KindPill: FC<{ type: string }> = ({ type }) => {
  const [ink, ground] = kindColors(type);
  return (
    <span
      title={type}
      style={`font-size:12px;color:${ink};background:${ground};padding:2px 9px;` +
        `border-radius:${T.radiusPill}px;white-space:nowrap`}
    >
      {kindLabel(type)}
    </span>
  );
};

const ThreadRow: FC<{
  thread: ConversationSummary;
  selected: boolean;
  href: string;
  agentRoles: Record<string, string | null>;
  now: number;
}> = ({ thread, selected, href, agentRoles, now }) => {
  const { a, b, isBroadcast, title } = partiesOf(thread);
  const live = isLive(thread.last_activity, now);
  // Only the selected row states a background. An unselected row leaves the
  // property unset: an inline `background:transparent` outranks any class rule
  // and would silently kill `.d-thread:hover`.
  const state = selected
    ? `;background:${T.card};box-shadow:inset 3px 0 0 ${T.green}`
    : "";
  return (
    <a
      class="d-thread"
      href={href}
      data-id={thread.thread_id}
      aria-current={selected ? "true" : undefined}
      style={`padding:14px 20px;border-bottom:1px solid ${LINE_THREAD_ROW};cursor:pointer${state}`}
    >
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:7px">
        <V2Avatar name={a} role={agentRoles[a] ?? undefined} size={22} bordered />
        {isBroadcast
          ? <AllBadge />
          : b
            ? <V2Avatar name={b} role={agentRoles[b] ?? undefined} size={22} bordered />
            : null}
        <span style="font-size:13.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
          {title}
        </span>
        <span style="flex:1" />
        {/* Always rendered, transparent when quiet, so the row never shifts. */}
        <span style={`width:7px;height:7px;border-radius:50%;flex-shrink:0;background:${live ? T.live : "transparent"}`} />
        <span style={`font-size:12px;color:${T.faint};flex-shrink:0`}>
          {fmtRel(thread.last_activity, now)}
        </span>
      </div>
      <div
        style={`font-size:13.5px;color:${T.body};line-height:1.45;margin-bottom:5px;overflow:hidden;` +
          "display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical"}
      >
        {previewPayload(thread.first_payload, ROW_PREVIEW_CHARS)}
      </div>
      {thread.first_context && (
        <div style={`font-size:12px;color:${T.faint};overflow:hidden;text-overflow:ellipsis;white-space:nowrap`}>
          {thread.first_context}
        </div>
      )}
    </a>
  );
};

const DaySeparator: FC<{ label: string }> = ({ label }) => (
  <div style="display:flex;align-items:center;gap:12px">
    <span style={`flex:1;height:1px;background:${T.lineSoft}`} />
    <span style={`font-size:12px;color:${T.faint}`}>{label}</span>
    <span style={`flex:1;height:1px;background:${T.lineSoft}`} />
  </div>
);

const MessageRow: FC<{
  message: MessageView;
  /** The sender is the thread's second participant — the bubble flips right. */
  ownSide: boolean;
  role?: string;
}> = ({ message, ownSide, role }) => {
  const bubble =
    `border-radius:${T.radiusInner}px;padding:13px 16px;font-size:14.5px;line-height:1.6;` +
    `color:${T.ink};white-space:pre-wrap;overflow-wrap:anywhere;` +
    (ownSide
      ? `background:${T.greenSoft};border:1px solid ${BUBBLE_LINE_OWN};border-bottom-right-radius:5px`
      : `background:${T.subtle};border:1px solid ${BUBBLE_LINE_OTHER};border-bottom-left-radius:5px`);
  return (
    <div
      data-id={message.id}
      style={`display:flex;gap:12px;align-items:flex-end;flex-direction:${ownSide ? "row-reverse" : "row"}`}
    >
      <V2Avatar name={message.from} role={role} size={34} bordered />
      <div
        style={"max-width:min(74%,720px);display:flex;flex-direction:column;" +
          `align-items:${ownSide ? "flex-end" : "flex-start"}`}
      >
        <div
          style={"display:flex;align-items:baseline;gap:9px;margin-bottom:6px;flex-wrap:wrap;" +
            `flex-direction:${ownSide ? "row-reverse" : "row"}`}
        >
          <span style="font-size:13.5px;font-weight:600">{message.from}</span>
          <KindPill type={message.type} />
          <span style={`font-size:12px;color:${T.faint}`}>{fmtTime(message.created_at)}</span>
        </div>
        <div style={bubble}>{previewPayload(message.payload, DEFAULT_PREVIEW_CHARS)}</div>
        {message.context && (
          <div
            style={`font-size:12px;color:${T.faint};margin-top:5px;overflow-wrap:anywhere;` +
              `text-align:${ownSide ? "right" : "left"}`}
          >
            on: {message.context}
          </div>
        )}
      </div>
    </div>
  );
};

/** Replaces the READ-ONLY · ADR-004 badge: the reason, then the command. */
const DetailFooter: FC<{ lastMessageId?: string }> = ({ lastMessageId }) => (
  <div style={`padding:16px clamp(16px,2.4vw,28px);border-top:1px solid ${T.lineSoft};background:${T.sunk}`}>
    <div style="display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap">
      <div style="flex:1 1 280px;min-width:0">
        <div style="font-size:13.5px;font-weight:600;margin-bottom:3px">
          Reading only — replies come from the agents themselves
        </div>
        <div style={`font-size:13px;color:${T.faint}`}>
          That's deliberate: every message has a verified sender. To answer, run this from your
          machine or let an agent call{" "}
          {/* 12.5px is below the floor for `dim`, so the tool name takes `faint`. */}
          <span style={`font-family:${V2_FONT_FAMILY_MONO};font-size:12.5px;color:${T.faint}`}>
            {REPLY_TOOL}
          </span>.
        </div>
      </div>
      {lastMessageId && (
        <div
          style={`position:relative;flex:1 1 320px;min-width:0;background:${T.codeBg};` +
            "border-radius:11px;padding:12px 14px"}
        >
          <button
            class="d-copy d-solid"
            type="button"
            data-label="Copy"
            data-copy-text={replyCommand(lastMessageId)}
            style={COPY_BTN_STYLE}
          >
            Copy
          </button>
          <pre
            style={`font-family:${V2_FONT_FAMILY_MONO};font-size:12.5px;color:${T.codeInk};` +
              "overflow-x:auto;padding-right:74px"}
          >
            {replyCommand(lastMessageId)}
          </pre>
        </div>
      )}
    </div>
  </div>
);

/** The container of the open thread. Rendered by the page; its CHILDREN are
 *  ConversationThreadSection, which is also what the fragment returns. */
const PANE_STYLE = "display:flex;flex-direction:column";

export interface ConversationThreadSectionProps {
  thread: ConversationThread | null;
  /** `?id=` that matched nothing. */
  unknownId?: string;
  agentRoles: Record<string, string | null>;
  now: number;
}

/**
 * Everything inside the open-thread pane: header, messages, footer. One
 * component for the page and for GET /fragments/conversations/thread, so the
 * two cannot drift. No entrance animation in here — it would replay on every
 * refresh.
 */
export const ConversationThreadSection: FC<ConversationThreadSectionProps> = ({ thread, unknownId, agentRoles, now }) => {
  const parties = thread ? partiesOf(thread) : null;
  const lastMessageId = thread?.messages[thread.messages.length - 1]?.id;
  const today = new Date(now);
  let openDay = "";
  return (
    <>
      <div
        style={"display:flex;align-items:center;gap:14px;padding:18px clamp(16px,2.4vw,28px);" +
          `border-bottom:1px solid ${T.lineSoft};flex-wrap:wrap`}
      >
        <div style="flex:1;min-width:200px">
          {thread && parties && (
            <>
              <div style="font-size:16px;font-weight:600;overflow-wrap:anywhere">{parties.title}</div>
              {/* A context is free text up to its own limit: let it break rather
                  than push the pane wider than the split. */}
              <div style={`font-size:13px;color:${T.dim};overflow-wrap:anywhere`}>
                {metaLine(thread, now)}
              </div>
            </>
          )}
        </div>
        {/* A claim about the page: "this updates by itself". True exactly
            while the message stream is open, which only the browser knows:
            rendered hidden, shown by live-refresh.ts. The hiding sits on a
            wrapper, because display:inline-flex would win over [hidden]. */}
        {thread && (
          <span data-live-pill hidden>
            <span
              style={"display:inline-flex;align-items:center;gap:6px;font-size:12.5px;" +
                `color:${T.greenDeep};background:${T.greenSoft};padding:4px 11px;border-radius:${T.radiusPill}px`}
            >
              <span class="m-pulse" style={`width:6px;height:6px;border-radius:50%;background:${T.live}`} />
              updating live
            </span>
          </span>
        )}
      </div>

      {thread && parties ? (
        <div
          data-live-scroll="thread"
          style={"flex:1;overflow-y:auto;padding:24px clamp(16px,2.4vw,30px);" +
            "display:flex;flex-direction:column;gap:20px"}
        >
          {thread.messages.map((message) => {
            const day = dayKey(message.created_at);
            const newDay = day !== openDay;
            openDay = day;
            return (
              <>
                {newDay && <DaySeparator label={dayLabel(message.created_at, today)} />}
                <MessageRow
                  message={message}
                  ownSide={!parties.isBroadcast && parties.b !== undefined && message.from === parties.b}
                  role={agentRoles[message.from] ?? undefined}
                />
              </>
            );
          })}
        </div>
      ) : (
        <div
          style={"flex:1;display:flex;align-items:center;justify-content:center;" +
            `padding:24px clamp(16px,2.4vw,30px);font-size:14.5px;color:${T.dim}`}
        >
          {unknownId
            ? <span style="text-align:center;overflow-wrap:anywhere">
                That conversation is not here. It may have aged out after 30 days,
                or the id is not one of ours: <span style={`font-family:${V2_FONT_FAMILY_MONO}`}>{unknownId}</span>
              </span>
            : "Pick a conversation on the left · もしもし"}
        </div>
      )}

      <DetailFooter lastMessageId={lastMessageId} />
    </>
  );
};

// ── The list section ────────────────────────────────────────────
export interface ConversationListSectionProps {
  result: PaginatedResult<ConversationSummary>;
  /** The open thread's id, for the highlight. May be a thread that is not
   *  on this page. */
  openedId?: string;
  query?: string;
  filterAgent?: string;
  agentRoles: Record<string, string | null>;
  now: number;
}

function filterQueryString(query?: string, filterAgent?: string): string {
  const filters = new URLSearchParams();
  if (query) filters.set("q", query);
  if (filterAgent) filters.set("agent", filterAgent);
  return filters.toString();
}

/** "12 threads · 3 still moving". liveCount is a count within this page.
 *  Threads sort by last activity, so every moving one is on page 1 — past
 *  that the clause would just read "0 still moving". */
export function conversationCountLine(result: PaginatedResult<ConversationSummary>, now: number): string {
  const liveCount = result.data.filter((t) => isLive(t.last_activity, now)).length;
  return plural(result.total, "thread") + (result.offset === 0 ? ` · ${liveCount} still moving` : "");
}

/**
 * Everything inside the thread list's scroller: rows and pager. One component
 * for the page and for GET /fragments/conversations/list.
 */
export const ConversationListSection: FC<ConversationListSectionProps> = ({
  result, openedId, query, filterAgent, agentRoles, now,
}) => {
  const threads = result.data;
  const filterQs = filterQueryString(query, filterAgent);
  const pageQs = result.offset > 0 ? `${filterQs ? `${filterQs}&` : ""}offset=${result.offset}` : filterQs;
  const threadHref = (id: string): string =>
    `/conversations?id=${encodeURIComponent(id)}${pageQs ? `&${pageQs}` : ""}#thread`;
  const pageHref = (offset: number): string =>
    offset > 0 ? `/conversations?offset=${offset}${filterQs ? `&${filterQs}` : ""}`
      : `/conversations${filterQs ? `?${filterQs}` : ""}`;
  return (
    <>
      {threads.length === 0 ? (
        <div style={`padding:32px 20px;font-size:13.5px;color:${T.faint};text-align:center`}>
          {query
            ? `Nothing matches "${query}".`
            : "Nothing here yet · しずか — no conversations so far."}
        </div>
      ) : (
        threads.map((thread) => (
          <ThreadRow
            thread={thread}
            selected={openedId === thread.thread_id}
            href={threadHref(thread.thread_id)}
            agentRoles={agentRoles}
            now={now}
          />
        ))
      )}
      {(result.offset > 0 || result.has_more) && (
        <div
          style={`display:flex;gap:14px;padding:14px 20px;border-top:1px solid ${LINE_THREAD_ROW};font-size:13px`}
        >
          {result.offset > 0 && (
            <a href={pageHref(Math.max(0, result.offset - result.limit))}>← Newer</a>
          )}
          <span style="flex:1" />
          {result.has_more && <a href={pageHref(result.offset + result.limit)}>Older →</a>}
        </div>
      )}
    </>
  );
};

/** The count line sits next to the search box, outside of the list, and a
 *  refresh must never touch that box. The list fragment hands the current
 *  line over in a response header (see OUT_OF_BAND_HEADER in fragments.tsx)
 *  and the live script writes it in here as text. */
export const COUNT_LINE_ID = "convos-count";

/** The fragment URL of the list: same filters, same page, same highlight. */
export function conversationListSrc(p: { query?: string; filterAgent?: string; offset: number; openedId?: string }): string {
  const qs = new URLSearchParams(filterQueryString(p.query, p.filterAgent));
  if (p.offset > 0) qs.set("offset", String(p.offset));
  if (p.openedId) qs.set("id", p.openedId);
  const text = qs.toString();
  return `/fragments/conversations/list${text ? `?${text}` : ""}`;
}

/** The fragment URL of one thread. The id is pinned on purpose. */
export function conversationThreadSrc(threadId: string): string {
  return `/fragments/conversations/thread?id=${encodeURIComponent(threadId)}`;
}

// ── Page ────────────────────────────────────────────────────────
export const V2ConversationsPage: FC<V2ConversationsProps> = ({
  result, opened, unknownId, now: nowProp, query, filterAgent, agentRoles, csrfToken, userRole, userName,
}) => {
  const now = nowProp ?? Date.now();
  // Search and agent filter are applied in SQL (listConversationSummaries),
  // so `result.data` is already the filtered page.
  const openedId = opened?.thread_id;

  return (
    <V2Layout
      title="Conversations"
      active="CONVOS"
      userRole={userRole}
      userName={userName}
      csrfToken={csrfToken}
      fullBleed
    >
      {raw(`<style>${CONVOS_CSS}</style>`)}
      {/* width:100% is load-bearing. As a flex item of the full-bleed <main>
          (a column flex container whose align-items computes to `normal`),
          this wrapper takes its content's width instead of the viewport's —
          so the split never learns it has to wrap, and the page scrolled
          sideways by ~190px on a phone. */}
      <div style={`${CONTAINER_APP};width:100%;flex:1;display:flex;flex-direction:column`}>
        {/* The one entrance animation on this screen. Never on the rows, and
            never inside a live container: it would replay on every refresh. */}
        <div class="m-rise" style={SPLIT_STYLE}>
          {/* Left: the thread panel */}
          <div class="d-list-panel" style={PANEL_STYLE}>
            <div style={`padding:22px 20px 16px;border-bottom:1px solid ${T.lineSoft}`}>
              <h1 style="margin:0 0 4px;font-size:21px;font-weight:600;letter-spacing:-0.02em">
                Conversations
              </h1>
              {/* Kept current by the list fragment, out of band. */}
              <div id={COUNT_LINE_ID} style={`font-size:13.5px;color:${T.faint}`}>
                {conversationCountLine(result, now)}
              </div>
              <form method="get" action="/conversations">
                <input
                  class="d-input d-search"
                  type="search"
                  name="q"
                  value={query ?? ""}
                  aria-label="Search conversations"
                  placeholder="Search what was said, or paste a message id"
                  style={SEARCH_STYLE}
                />
                {filterAgent && <input type="hidden" name="agent" value={filterAgent} />}
              </form>
              {/* Where the list came from, and the way back out. 12.5px is
                  below the floor for `dim`, so this line takes `faint`. */}
              {filterAgent && (
                <div style={`margin-top:10px;display:flex;align-items:center;gap:8px;font-size:12.5px;color:${T.faint}`}>
                  <span>
                    Threads with <span style={`color:${T.ink};font-weight:600`}>{filterAgent}</span>
                  </span>
                  <a href={query ? `/conversations?q=${encodeURIComponent(query)}` : "/conversations"}>
                    Clear
                  </a>
                </div>
              )}
            </div>

            <div
              data-live="convos-list"
              data-live-src={conversationListSrc({ query, filterAgent, offset: result.offset, openedId })}
              data-live-mark={result.offset === 0 ? "rows" : undefined}
              data-live-noun={result.offset === 0 ? "conversation" : undefined}
              style="flex:1;overflow-y:auto"
            >
              <ConversationListSection
                result={result}
                openedId={openedId}
                query={query}
                filterAgent={filterAgent}
                agentRoles={agentRoles}
                now={now}
              />
            </div>
          </div>

          {/* Right: the open thread. Live only when there is a thread. */}
          <div
            id="thread"
            class="d-thread-pane"
            data-live={opened ? "convos-thread" : undefined}
            data-live-src={opened ? conversationThreadSrc(opened.thread_id) : undefined}
            data-live-thread={opened ? opened.thread_id : undefined}
            data-live-mark={opened ? "rows" : undefined}
            data-live-noun={opened ? "message" : undefined}
            style={PANE_STYLE}
          >
            <ConversationThreadSection thread={opened} unknownId={unknownId} agentRoles={agentRoles} now={now} />
          </div>
        </div>
      </div>
    </V2Layout>
  );
};
