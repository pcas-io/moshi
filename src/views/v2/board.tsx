// /board: who has the ball in each conversation, and whether it moves.
//
// One live container (`data-live="board"`) around `BoardSection`, which the
// fragment route renders too: page and refresh are the same component. The
// light changes with the clock alone, so the section also refreshes on the
// live script's timer, not only on the message stream.
//
// No message text on this page: who, to whom, which type, when, and the
// holder's own `working_on`. The human who holds a ball is a role, never a
// name.

import type { FC } from "hono/jsx";
import type { Board, BoardRow, Light, Reach } from "../../services/board.js";
import { BOARD_THRESHOLDS } from "../../services/board.js";
import { threadHref } from "../../services/thread-link.js";
import { V2Layout } from "./layout.js";
import { V2_TOKENS, V2_FONT_FAMILY_MONO } from "./tokens.js";
import { CARD_STYLE } from "./components.js";
import { fmtRel } from "./agents-detail.js";

const T = V2_TOKENS;

export const BOARD_SRC = "/fragments/board";

const LIGHT: Record<Light, { color: string; word: string }> = {
  green: { color: T.live, word: "moving" },
  yellow: { color: T.amber, word: "slow" },
  red: { color: T.red, word: "stuck" },
  grey: { color: T.presenceOffline, word: "quiet" },
};

const REACH_WORDS: Record<Reach, string> = {
  online: "online",
  hook: "asleep, wakes by webhook",
  stale: "quiet, no webhook",
  unreachable: "cannot be reached",
};

const CARD = `${CARD_STYLE};overflow:hidden;margin-bottom:18px`;
const CARD_HEAD = `padding:16px 22px 12px;border-bottom:1px solid ${T.lineSoft}`;
const H2 = "margin:0;font-size:16px;font-weight:600";
const SUB = `font-size:13px;color:${T.dim};margin-top:2px`;
const ROW = `display:flex;gap:14px;align-items:flex-start;padding:12px 22px;border-top:1px solid ${T.lineRow}`;
const META = `font-size:12.5px;color:${T.faint}`;
const MONO = `font-family:${V2_FONT_FAMILY_MONO};font-size:12px`;

const Dot: FC<{ light: Light }> = ({ light }) => (
  <span
    role="img"
    aria-label={LIGHT[light].word}
    title={LIGHT[light].word}
    style={`flex-shrink:0;margin-top:5px;width:12px;height:12px;border-radius:999px;background:${LIGHT[light].color}`}
  />
);

/** Where the ball came from, and the link to its thread. */
const Origin: FC<{ row: BoardRow; now: number }> = ({ row, now }) => (
  <div style={META}>
    <span style={MONO}>{row.from}</span>
    {" → "}
    <span style={MONO}>{row.to}</span>
    {` · ${row.type} · ${fmtRel(row.since, now)} · `}
    <a href={threadHref(row.threadId)}>thread</a>
  </div>
);

const HookNote: FC<{ row: BoardRow }> = ({ row }) => {
  if (row.reach === "hook" || row.reach === "online") return null;
  if (row.hook?.state === "disabled") return <div style={META}>Its webhook is switched off after failed calls.</div>;
  if (row.hook?.state === "failing") return <div style={META}>Its webhook failed on the last call.</div>;
  if (!row.hook) return <div style={META}>No webhook: nothing wakes it, it has to look by itself.</div>;
  return null;
};

const InPlayRow: FC<{ row: BoardRow; now: number }> = ({ row, now }) => (
  <div style={ROW} data-row={row.threadId}>
    <Dot light={row.light} />
    <div style="flex:1;min-width:0">
      <div style="display:flex;gap:10px;align-items:baseline;flex-wrap:wrap">
        <span style="font-size:15px;font-weight:600">{row.holder}</span>
        <span style={`font-size:13px;color:${T.dim}`}>
          {`has the ball since ${fmtRel(row.since, now)} · ${row.reach ? REACH_WORDS[row.reach] : ""}`}
        </span>
      </div>
      {row.vagueNext ? (
        <div style={`font-size:13.5px;color:${T.amberInk};margin:3px 0`}>
          {`Delivers next: not said. Its working_on is ${row.deliversNext?.trim() ? `"${row.deliversNext.trim()}"` : "empty"}; ` +
            "it should name the next delivery and who gets it."}
        </div>
      ) : (
        <div style={`font-size:13.5px;color:${T.body};margin:3px 0`}>{`Delivers next: ${row.deliversNext}`}</div>
      )}
      <Origin row={row} now={now} />
      <HookNote row={row} />
    </div>
  </div>
);

const HumanRow: FC<{ row: BoardRow; now: number }> = ({ row, now }) => (
  <div style={ROW} data-row={row.threadId}>
    <Dot light="red" />
    <div style="flex:1;min-width:0">
      <div style="font-size:15px;font-weight:600">{`${row.from} needs an answer from a human`}</div>
      <Origin row={row} now={now} />
    </div>
  </div>
);

const QuietRow: FC<{ row: BoardRow; now: number }> = ({ row, now }) => (
  <div style={ROW} data-row={row.threadId}>
    <Dot light="grey" />
    <div style="flex:1;min-width:0">
      <div style={`font-size:13.5px;color:${T.body}`}>
        {row.done ? `Done, said ${row.from}` : `Nothing since ${fmtRel(row.lastActivity, now)}`}
      </div>
      <Origin row={row} now={now} />
    </div>
  </div>
);

/** The inside of the live container: the same markup for page and fragment. */
export const BoardSection: FC<{ board: Board; now: number }> = ({ board, now }) => {
  const open = board.inPlay.length + board.waitingForHuman.length;
  return (
    <>
      {board.nothingMoving && (
        <div
          role="note"
          style={`margin-bottom:18px;padding:14px 18px;border-radius:${T.radiusBox}px;background:${T.redSoft};` +
            `border:1px solid ${T.redLine};color:${T.red};font-size:14.5px;font-weight:600`}
        >
          Nothing is moving. Every open strand is slow, stuck or waiting for a human.
        </div>
      )}

      {board.waitingForHuman.length > 0 && (
        <section style={CARD}>
          <div style={CARD_HEAD}>
            <h2 style={H2}>Wait for human</h2>
            <div style={SUB}>The fastest agents in the mesh, waiting on the slowest component.</div>
          </div>
          {board.waitingForHuman.map((row) => <HumanRow row={row} now={now} />)}
        </section>
      )}

      <section style={CARD}>
        <div style={CARD_HEAD}>
          <h2 style={H2}>In play</h2>
          <div style={SUB}>
            {`Moving: a move in the last ${BOARD_THRESHOLDS.greenMinutes} minutes. Slow: up to ${BOARD_THRESHOLDS.redMinutes}. ` +
              "Stuck: longer, or nobody can wake the holder."}
          </div>
        </div>
        {board.inPlay.length > 0 ? (
          board.inPlay.map((row) => <InPlayRow row={row} now={now} />)
        ) : (
          <div style={`${ROW};color:${T.faint};font-size:13.5px`}>
            {open === 0 ? "No ball in play." : "No agent holds a ball."}
          </div>
        )}
      </section>

      {board.quiet.length > 0 && (
        <section style={CARD}>
          <div style={CARD_HEAD}>
            <h2 style={H2}>Done or quiet</h2>
            <div style={SUB}>{`Finished with "done", or nothing for ${BOARD_THRESHOLDS.quietHours} hours.`}</div>
          </div>
          {board.quiet.map((row) => <QuietRow row={row} now={now} />)}
        </section>
      )}
    </>
  );
};

export interface V2BoardProps {
  board: Board;
  now: number;
  userRole?: string;
  userName?: string;
  csrfToken?: string;
}

export const V2BoardPage: FC<V2BoardProps> = ({ board, now, userRole, userName, csrfToken }) => (
  <V2Layout title="Board" active="BOARD" userRole={userRole} userName={userName} csrfToken={csrfToken}>
    <div style="margin:4px 0 18px">
      <h1 style="margin:0;font-size:24px;font-weight:650;letter-spacing:-0.01em">Who has the ball</h1>
      <div style={`font-size:14px;color:${T.dim};margin-top:4px`}>
        One line per conversation. The ball lies with whoever was written to last; "done" ends a conversation,
        "input_required" hands it to a human.
      </div>
    </div>
    <div data-live="board" data-live-src={BOARD_SRC}>
      <BoardSection board={board} now={now} />
    </div>
  </V2Layout>
);
