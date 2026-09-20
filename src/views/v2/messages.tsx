// Log · Messages tab — the table body for `/log?tab=messages`.
//
// This file used to be a page (`V2MessagesPage`). Messages and Activity
// answered the same question — "what just happened" — so they are now two
// tabs of one route; `log.tsx` owns the page, this owns one table.
//
// It is the leaf of the Log screen's import graph (log → messages,
// log → activity → messages), so the two strings both tabs share live
// here rather than in the page that would import them back.

import type { Child, FC } from "hono/jsx";
import type { MessageListItem } from "../../services/message-queries.js";
import type { PaginatedResult } from "../../types.js";
import { V2Avatar, kindLabel } from "./components.js";
import { V2_FONT_FAMILY_MONO, V2_TOKENS, kindColors } from "./tokens.js";

const T = V2_TOKENS;

/** The `to` value that means "every live agent". */
export const BROADCAST_RECIPIENT = "broadcast";

/** COPY §8 — the same line on both tabs and in the Busiest-today aside. */
export const LOG_EMPTY_TEXT = "Nothing matches this filter · なし";

/** The empty state inside a table card, on both tabs. */
export const LogEmptyBlock: FC = () => (
  <div style={`padding:48px 20px;text-align:center;font-size:14.5px;color:${T.dim}`}>
    {LOG_EMPTY_TEXT}
  </div>
);

export const LOG_CARD_STYLE =
  `background:${T.card};border:1px solid ${T.line};border-radius:${T.radiusCard}px;overflow:hidden`;

// Header and rows must share one column string or the columns drift.
const GRID = "display:grid;grid-template-columns:64px 1fr 1fr 130px 2fr;gap:14px";

// 12.5px metadata uses `faint`, not `dim`: dim is 4.49:1 on white and the
// house rule caps it at >= 13px.
const TIME_CELL = `font-family:${V2_FONT_FAMILY_MONO};font-size:12.5px;color:${T.faint}`;
const ELLIPSIS = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
const EMBLEM_CELL = `display:flex;align-items:center;gap:9px;overflow:hidden`;

const HEADERS = ["Time", "From", "To", "Kind", "What it was about"] as const;

/** `HH:MM` for today, `DD Mon HH:MM` for anything older. `now` is injected:
 *  the page and its refreshed fragment have to agree on what "today" is. */
function fmtDayHM(iso: string, now: number): string {
  const d = new Date(iso);
  const today = new Date(now);
  if (d.toDateString() === today.toDateString()) return d.toTimeString().slice(0, 5);
  return (
    d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" }) +
    " " +
    d.toTimeString().slice(0, 5)
  );
}

const KindCell: FC<{ type: string; priority: string }> = ({ type, priority }) => {
  const [ink, ground] = kindColors(type);
  return (
    <div style="display:flex;align-items:center;gap:7px;min-width:0">
      <span
        style={`font-size:12.5px;color:${ink};background:${ground};padding:3px 10px;` +
          `border-radius:${T.radiusPill}px;width:fit-content;white-space:nowrap`}
      >
        {kindLabel(type)}
      </span>
      {/* The old Prio column read "normal" on nearly every row. Only the
          exception is worth ink. */}
      {priority === "high" && (
        <span
          title="High priority"
          style={`width:6px;height:6px;border-radius:50%;background:${T.red};flex-shrink:0`}
        />
      )}
    </div>
  );
};

const ToCell: FC<{ to: string; role?: string | null }> = ({ to, role }) =>
  to === BROADCAST_RECIPIENT ? (
    <span
      style={`display:inline-flex;align-items:center;gap:7px;font-size:13.5px;color:${T.amberInk};` +
        `background:${T.amberSoft};padding:3px 11px;border-radius:${T.radiusPill}px;width:fit-content`}
    >
      everyone
    </span>
  ) : (
    <div style={EMBLEM_CELL}>
      <V2Avatar name={to} role={role} size={24} bordered />
      <span style={`font-size:13.5px;${ELLIPSIS}`}>{to}</span>
    </div>
  );

export interface MessagesTableProps {
  /** Rows as the table shows them: no payloads, the table never shows one. */
  result: PaginatedResult<MessageListItem>;
  /** Role drives the emblem's stripe colour; the emblem itself is keyed on the name. */
  agentRoles: Record<string, string | null>;
  /** Pagination row, built by the page so both tabs share one footer. */
  footer?: Child;
  /** Render clock; defaults to now. */
  now?: number;
  /** The URL this card refreshes itself from. Without it the card is static. */
  liveSrc?: string;
}

/**
 * Everything inside the messages card: the scrolling table, the empty line,
 * the pager. One component for the page and for GET /fragments/log/messages.
 * The entrance animation belongs to the card around it, never to this: it
 * would replay on every refresh.
 */
export const MessagesTableBody: FC<Omit<MessagesTableProps, "liveSrc">> = ({ result, agentRoles, footer, now }) => {
  const rows = result.data;
  const clock = now ?? Date.now();
  return (
    <>
      <div data-live-scroll="log-x" style="overflow-x:auto">
        {/* Fixed-width table: it scrolls inside the card rather than squeezing. */}
        <div style="min-width:840px">
          <div
            style={`${GRID};padding:13px 20px;font-size:12.5px;color:${T.faint};` +
              `border-bottom:1px solid ${T.lineSoft};background:${T.sunk}`}
          >
            {HEADERS.map((h) => <span key={h}>{h}</span>)}
          </div>
          {rows.map((m) => (
            <div
              key={m.id}
              class="d-row"
              data-id={m.id}
              style={`${GRID};padding:11px 20px;align-items:center;border-bottom:1px solid ${T.lineRow}`}
            >
              <span style={TIME_CELL}>{fmtDayHM(m.created_at, clock)}</span>
              <div style={EMBLEM_CELL}>
                <V2Avatar name={m.from} role={agentRoles[m.from]} size={24} bordered />
                <span style={`font-size:13.5px;font-weight:600;${ELLIPSIS}`}>{m.from}</span>
              </div>
              <ToCell to={m.to} role={agentRoles[m.to]} />
              <KindCell type={m.type} priority={m.priority} />
              <span style={`font-size:13.5px;color:${T.body};${ELLIPSIS}`} title={m.context}>
                {m.context}
              </span>
            </div>
          ))}
        </div>
      </div>
      {/* The empty line sits outside the 840px scroll box: centred inside
          it, a phone would have to scroll sideways to read it. */}
      {rows.length === 0 && <LogEmptyBlock />}
      {footer}
    </>
  );
};

/** The card. With `liveSrc` it is a live container: the script swaps its
 *  children for what the fragment returns, which is MessagesTableBody. */
export const MessagesTable: FC<MessagesTableProps> = ({ liveSrc, ...body }) => (
  <div
    class="m-rise"
    data-live={liveSrc ? "log-messages" : undefined}
    data-live-src={liveSrc}
    // On a later page every new message shifts all rows by one: marking
    // "new" rows there would mark the whole page.
    data-live-mark={liveSrc && body.result.offset === 0 ? "rows" : undefined}
    data-live-noun={liveSrc && body.result.offset === 0 ? "message" : undefined}
    style={LOG_CARD_STYLE}
  >
    <MessagesTableBody {...body} />
  </div>
);
