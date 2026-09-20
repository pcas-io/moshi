// Log — `GET /log`. One route, two tabs.
//
// `/messages` and `/activity` answered the same question ("what just
// happened") from two nav items, so people checked both every time. This
// page owns the shell — heading, tabs, filters, pagination — and imports
// one table body per tab: `messages.tsx` and `activity.tsx`.
//
// All page state lives in the query string (`?tab= ?q= ?routing= ?offset=`),
// so every control is an anchor and the back button works. No client JS of
// its own: the Messages tab is a live section, refreshed by the layout's
// live-refresh script.

import type { Child, FC } from "hono/jsx";
import type { MessageListItem, MessageRouting } from "../../services/message-queries.js";
import type { Activity, PaginatedResult } from "../../types.js";
import type { ActivityActorCount } from "../../services/activity.js";
import { ACTIVITY_RETENTION_DAYS, LIMITS, MESSAGE_RETENTION_DAYS } from "../../types.js";
import { V2Layout } from "./layout.js";
import { V2_TOKENS } from "./tokens.js";
import { MessagesTable, MessagesTableBody } from "./messages.js";
import { AuditTable, BusiestTodayAside } from "./activity.js";

const T = V2_TOKENS;

export type LogTab = "messages" | "audit";
/** The three routing pills. "all" is the absence of a routing filter. */
export type LogRouting = "all" | MessageRouting;

const TABS: ReadonlyArray<readonly [LogTab, string]> = [
  ["messages", "Messages"],
  ["audit", "Audit trail"],
];

const ROUTINGS: ReadonlyArray<readonly [LogRouting, string]> = [
  ["all", "Everything"],
  ["direct", "One to one"],
  ["broadcast", "To everyone"],
];

const SEARCH_PLACEHOLDER = "Search payload, context, message or thread id";

/** `?tab=` → a tab. Anything unrecognised reads as Messages. */
export function parseLogTab(value: string | undefined | null): LogTab {
  return value === "audit" ? "audit" : "messages";
}

/** `?routing=` → a pill. Anything unrecognised reads as Everything. */
export function parseLogRouting(value: string | undefined | null): LogRouting {
  const hit = ROUTINGS.find(([key]) => key === value);
  return hit ? hit[0] : "all";
}

/** The pill as `listMessageItems` wants it: Everything means no filter. */
export function messageRoutingOf(routing: LogRouting): MessageRouting | undefined {
  return routing === "all" ? undefined : routing;
}

interface LogQuery {
  tab: LogTab;
  routing?: LogRouting;
  q?: string;
  offset?: number;
  agent?: string;
  entity?: string;
  range?: string;
}

function logHref(p: LogQuery): string {
  const u = new URLSearchParams();
  u.set("tab", p.tab);
  if (p.routing && p.routing !== "all") u.set("routing", p.routing);
  if (p.q) u.set("q", p.q);
  if (p.agent) u.set("agent", p.agent);
  if (p.entity) u.set("entity", p.entity);
  if (p.range) u.set("range", p.range);
  if (p.offset && p.offset > 0) u.set("offset", String(p.offset));
  return `/log?${u.toString()}`;
}

/** `1 284` — a plain space, as the count is set in COPY §8. */
function groupThousands(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

const PAGER_BTN =
  `background:${T.card};border:1px solid ${T.lineStrong};color:${T.ink};font-size:13.5px;` +
  "font-weight:600;padding:8px 14px;border-radius:9px;cursor:pointer;text-decoration:none";

/** Same footer on both tabs, inside the card, below the last row. */
const LogFooter: FC<{
  page: PaginatedResult<unknown>;
  href: (offset: number) => string;
}> = ({ page, href }) => {
  const { offset, limit, total, has_more } = page;
  if (total === 0) return null;
  return (
    <div
      style={`padding:14px 20px;display:flex;gap:16px;align-items:center;font-size:13.5px;` +
        `color:${T.dim};flex-wrap:wrap`}
    >
      {offset > 0 && (
        <a class="d-ghost" href={href(Math.max(0, offset - limit))} style={PAGER_BTN}>← Newer</a>
      )}
      {/* An offset past the end (a hand-edited URL, or rows rotated out
          between two clicks) has no honest count — but it must keep its
          way back, so the row still renders with `← Newer`. */}
      {offset < total && (
        <span>
          Showing {offset + 1}–{Math.min(offset + limit, total)} of {groupThousands(total)}
        </span>
      )}
      <span style="flex:1" />
      {has_more && <a class="d-ghost" href={href(offset + limit)} style={PAGER_BTN}>Older →</a>}
    </div>
  );
};

const TAB_BASE = "font-size:14.5px;padding:10px 16px;cursor:pointer;background:transparent;border:none;text-decoration:none";

const TabLink: FC<{ href: string; active: boolean; children?: Child }> = ({ href, active, children }) => (
  <a
    class={active ? undefined : "d-tab"}
    href={href}
    aria-current={active ? "page" : undefined}
    style={`${TAB_BASE};font-weight:${active ? 600 : 400};` +
      `border-bottom:2px solid ${active ? T.green : "transparent"};color:${active ? T.ink : T.dim}`}
  >
    {children}
  </a>
);

const PILL_BASE = "font-size:13.5px;padding:9px 14px;border-radius:999px;cursor:pointer;text-decoration:none";

const PillLink: FC<{ href: string; active: boolean; children?: Child }> = ({ href, active, children }) => (
  <a
    class={active ? undefined : "d-ghost"}
    href={href}
    aria-current={active ? "true" : undefined}
    style={`${PILL_BASE};font-weight:${active ? 600 : 400};` +
      `border:1px solid ${active ? T.lineStrong : T.line};` +
      `background:${active ? T.subtle : T.card};color:${active ? T.ink : T.dim}`}
  >
    {children}
  </a>
);

function emptyPage<Row>(): PaginatedResult<Row> {
  return { data: [], has_more: false, total: 0, limit: LIMITS.PAGINATION_DEFAULT, offset: 0 };
}

export interface V2LogProps {
  tab: LogTab;
  /** The messages page. Required when `tab === "messages"`. */
  messages?: PaginatedResult<MessageListItem>;
  /** The audit page. Required when `tab === "audit"`. */
  events?: PaginatedResult<Activity>;
  /** Real day totals from `ActivityService.topActors`, not a page count. */
  topActors?: readonly ActivityActorCount[];
  query?: string;
  routing?: LogRouting;
  /**
   * Filters with no control on this screen. `/messages` and `/activity`
   * redirect here with their query strings intact, so the links this page
   * builds have to carry them or the reader's filter resets on page two.
   */
  filterAgent?: string;
  filterEntity?: string;
  filterRange?: string;
  /** Role drives the emblem's stripe colour; the emblem is keyed on the name. */
  agentRoles: Record<string, string | null>;
  userRole?: string;
  userName?: string;
  csrfToken?: string;
  /** Render clock; defaults to now. */
  now?: number;
}

type LogSectionProps = Pick<V2LogProps,
  "messages" | "query" | "routing" | "filterAgent" | "filterEntity" | "filterRange" | "agentRoles" | "now">;

/** The query string both the page links and the fragment URL are built from. */
function carriedOf(p: LogSectionProps): Pick<LogQuery, "q" | "agent" | "entity" | "range"> {
  return { q: p.query, agent: p.filterAgent, entity: p.filterEntity, range: p.filterRange };
}

/** Where the messages card refreshes itself from: same filters, same page.
 *  `entity` and `range` do nothing to messages, but the pager links inside
 *  the fragment carry them, so the fragment has to know them too. */
export function logMessagesSrc(p: LogSectionProps): string {
  const page = logHref({ ...carriedOf(p), tab: "messages", routing: p.routing ?? "all", offset: p.messages?.offset ?? 0 });
  const qs = new URLSearchParams(page.slice(page.indexOf("?") + 1));
  qs.delete("tab");
  const text = qs.toString();
  return `/fragments/log/messages${text ? `?${text}` : ""}`;
}

/**
 * The inside of the messages card, pager included. Rendered by the page and
 * by GET /fragments/log/messages from the same props.
 */
export const LogMessagesSection: FC<LogSectionProps> = (p) => {
  const page = p.messages ?? emptyPage<MessageListItem>();
  const pageHref = (offset: number): string =>
    logHref({ ...carriedOf(p), tab: "messages", routing: p.routing ?? "all", offset });
  return (
    <MessagesTableBody
      result={page}
      agentRoles={p.agentRoles}
      now={p.now}
      footer={<LogFooter page={page} href={pageHref} />}
    />
  );
};

export const V2LogPage: FC<V2LogProps> = ({
  tab, messages, events, topActors = [], query, routing = "all",
  filterAgent, filterEntity, filterRange, agentRoles, userRole, userName, csrfToken, now,
}) => {
  const carried = { q: query, agent: filterAgent, entity: filterEntity, range: filterRange };
  const pageHref = (offset: number): string => logHref({ ...carried, tab, routing, offset });
  const section: LogSectionProps = { messages, query, routing, filterAgent, filterEntity, filterRange, agentRoles, now };

  return (
    <V2Layout title="Log" active="LOG" userRole={userRole} userName={userName} csrfToken={csrfToken}>
      <div style="margin-bottom:20px">
        <h1 style="margin:0 0 6px;font-size:clamp(24px,3vw,30px);font-weight:600;letter-spacing:-0.025em">
          Log
        </h1>
        {/* The two retention numbers are the rotation job's, not the copy deck's. */}
        <p style={`margin:0;font-size:15px;color:${T.body};max-width:70ch`}>
          Everything that happened, newest first. Messages keep {MESSAGE_RETENTION_DAYS} days
          of history; audit events keep {ACTIVITY_RETENTION_DAYS}.
        </p>
      </div>

      <div style={`display:flex;gap:6px;margin-bottom:18px;flex-wrap:wrap;border-bottom:1px solid ${T.line}`}>
        {TABS.map(([key, label]) => (
          <TabLink key={key} href={logHref({ ...carried, tab: key, routing })} active={key === tab}>
            {label}
          </TabLink>
        ))}
      </div>

      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px;align-items:center">
        {/* display:contents keeps the form out of the flex row's geometry. */}
        <form method="get" action="/log" style="display:contents">
          <input type="hidden" name="tab" value={tab} />
          {routing !== "all" && <input type="hidden" name="routing" value={routing} />}
          {filterAgent && <input type="hidden" name="agent" value={filterAgent} />}
          {filterEntity && <input type="hidden" name="entity" value={filterEntity} />}
          {filterRange && <input type="hidden" name="range" value={filterRange} />}
          <input
            class="d-input"
            type="text"
            name="q"
            value={query ?? ""}
            aria-label={SEARCH_PLACEHOLDER}
            placeholder={SEARCH_PLACEHOLDER}
            style={`flex:1 1 300px;min-width:0;background:${T.card};border:1px solid ${T.lineStrong};` +
              `border-radius:${T.radiusControl}px;font-size:13.5px;padding:10px 13px;outline:none;color:${T.ink}`}
          />
        </form>
        {/* Routing is a message concept: on the audit tab these pills would
            change nothing, so they are not drawn at all. */}
        {tab === "messages" &&
          ROUTINGS.map(([key, label]) => (
            <PillLink key={key} href={logHref({ ...carried, tab, routing: key })} active={key === routing}>
              {label}
            </PillLink>
          ))}
      </div>

      {tab === "messages" ? (
        <MessagesTable
          result={messages ?? emptyPage<MessageListItem>()}
          agentRoles={agentRoles}
          now={now}
          liveSrc={logMessagesSrc(section)}
          footer={<LogFooter page={messages ?? emptyPage<MessageListItem>()} href={pageHref} />}
        />
      ) : (
        <div style="display:flex;gap:18px;flex-wrap:wrap;align-items:flex-start">
          <AuditTable
            result={events ?? emptyPage<Activity>()}
            agentRoles={agentRoles}
            footer={<LogFooter page={events ?? emptyPage<Activity>()} href={pageHref} />}
          />
          <BusiestTodayAside actors={topActors} agentRoles={agentRoles} />
        </div>
      )}
    </V2Layout>
  );
};
