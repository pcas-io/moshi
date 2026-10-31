// /board: who has the ball between two agents, and whether it moves.
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
import type { Board, BoardRow, Light, Reach, ResultLink } from "../../services/board.js";
import { BOARD_THRESHOLDS } from "../../services/board.js";
import { threadHref } from "../../services/thread-link.js";
import { V2Layout } from "./layout.js";
import { V2_TOKENS, V2_FONT_FAMILY_MONO } from "./tokens.js";
import { CARD_STYLE } from "./components.js";
import { fmtRel } from "./agents-detail.js";

const T = V2_TOKENS;

export const BOARD_SRC = "/fragments/board";

const LIGHT: Record<Light, { color: string; word: string; meaning: string }> = {
  green: { color: T.live, word: "moving", meaning: `the holder can be woken and got the ball in the last ${BOARD_THRESHOLDS.greenMinutes} minutes` },
  yellow: { color: T.amber, word: "slow", meaning: "the ball has lain longer, or the holder is only quiet" },
  red: { color: T.red, word: "stuck", meaning: "nobody can wake the holder: not online, and no webhook that works" },
  human: { color: T.blue, word: "human", meaning: "waits for a human" },
  grey: { color: T.presenceOffline, word: "quiet", meaning: `done, or nothing for ${BOARD_THRESHOLDS.quietHours} hours` },
};

/** When, relatively, with the moment itself for the tooltip and machines. */
const When: FC<{ iso: string; now: number }> = ({ iso, now }) => (
  <time datetime={iso} title={`${iso.slice(0, 16).replace("T", " ")} UTC`}>{fmtRel(iso, now)}</time>
);

const REACH_WORDS: Record<Reach, string> = {
  online: "online",
  hook: "asleep, wakes by webhook",
  stale: "quiet",
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

/** A key the DOM can carry: the pair's two inbox keys, joined visibly. */
const domKey = (row: BoardRow): string => row.pairKey.replace("\u001f", "~");

/** A result: its title when known, else the end of its id. Never other text. */
const Result: FC<{ link: ResultLink }> = ({ link }) => (
  <a href={link.url} target="_blank" rel="noopener noreferrer" title={link.url}>
    {link.title ?? `…${link.id.slice(-8)}`}
  </a>
);

/** The last action between the two, and the link to the newest thread. */
const Origin: FC<{ row: BoardRow; now: number }> = ({ row, now }) => (
  <div style={META}>
    {"Last: "}
    <span style={MONO}>{row.type}</span>
    {" from "}
    <span style={MONO}>{row.from}</span>
    {" to "}
    <span style={MONO}>{row.to}</span>
    {" · "}
    <When iso={row.since} now={now} />
    {" · "}
    <a href={threadHref(row.threadId)}>latest thread</a>
  </div>
);

const ResultLine: FC<{ row: BoardRow }> = ({ row }) =>
  row.result ? (
    <div style={`font-size:13.5px;color:${T.body};margin:3px 0`}>
      {"Result: "}
      <Result link={row.result} />
    </div>
  ) : null;

/** The pair's last actions, folded; kept open across a live refresh. */
const History: FC<{ row: BoardRow; now: number }> = ({ row, now }) =>
  row.history.length > 1 ? (
    <details data-live-keep={domKey(row)} style="margin-top:4px">
      <summary style={`${META};cursor:pointer`}>{`History (last ${row.history.length})`}</summary>
      <ol style={`margin:6px 0 0;padding-left:18px;${META}`}>
        {row.history.map((h) => (
          <li style="margin:2px 0">
            <When iso={h.at} now={now} />
            {" · "}
            <span style={MONO}>{h.type}</span>
            {" · "}
            <span style={MONO}>{h.from}</span>
            {" → "}
            <span style={MONO}>{h.to}</span>
            {h.link ? " · " : ""}
            {h.link ? <Result link={h.link} /> : null}
          </li>
        ))}
      </ol>
    </details>
  ) : null;

const HookNote: FC<{ row: BoardRow }> = ({ row }) => {
  if (row.reach === "hook" || row.reach === "online") return null;
  if (!row.hook) return <div style={META}>No webhook: nothing wakes it, it has to look by itself.</div>;
  if (row.hook.state === "disabled") return <div style={META}>Its webhook is switched off after failed calls.</div>;
  if (row.hook.state === "failing") return <div style={META}>Its webhook failed on the last call.</div>;
  return <div style={META}>Its webhook has not been called successfully yet.</div>;
};

const InPlayRow: FC<{ row: BoardRow; now: number }> = ({ row, now }) => (
  <div style={ROW} data-row={domKey(row)}>
    <Dot light={row.light} />
    <div style="flex:1;min-width:0">
      <div style="display:flex;gap:10px;align-items:baseline;flex-wrap:wrap">
        <span style="font-size:15px;font-weight:600">{row.holder}</span>
        <span style={`font-size:13px;color:${T.dim}`}>
          {row.delivered ? `got a delivery from ${row.from} · ` : "is on it · "}
          {"since "}
          <When iso={row.since} now={now} />
          {row.reach ? ` · ${REACH_WORDS[row.reach]}` : ""}
        </span>
      </div>
      {row.delivered && (
        <div style={`font-size:13.5px;color:${T.greenDeep};margin:3px 0`}>{`Delivered, waiting for ${row.holder} to pick it up`}</div>
      )}
      <ResultLine row={row} />
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
      <History row={row} now={now} />
    </div>
  </div>
);

const HumanRow: FC<{ row: BoardRow; now: number }> = ({ row, now }) => (
  <div style={ROW} data-row={domKey(row)}>
    <Dot light="human" />
    <div style="flex:1;min-width:0">
      <div style="font-size:15px;font-weight:600">{`${row.waiting} waits for a human`}</div>
      {row.deliversNext && <div style={`font-size:13.5px;color:${T.body};margin:3px 0`}>{row.deliversNext}</div>}
      <ResultLine row={row} />
      <Origin row={row} now={now} />
      <History row={row} now={now} />
    </div>
  </div>
);

const QuietRow: FC<{ row: BoardRow; now: number }> = ({ row, now }) => (
  <div style={ROW} data-row={domKey(row)}>
    <Dot light="grey" />
    <div style="flex:1;min-width:0">
      <div style={`font-size:13.5px;color:${T.body}`}>
        {row.done ? `Done, said ${row.from}, ` : "Nothing since "}
        <When iso={row.lastActivity} now={now} />
      </div>
      <ResultLine row={row} />
      <Origin row={row} now={now} />
      <History row={row} now={now} />
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
            <div style={SUB}>The fastest agents in the mesh, waiting patiently for the slowest component in it.</div>
          </div>
          {board.waitingForHuman.map((row) => <HumanRow row={row} now={now} />)}
        </section>
      )}

      <section style={CARD}>
        <div style={CARD_HEAD}>
          <h2 style={H2}>In play</h2>
          <div style={SUB}>Stuck first, then slow, then moving; the newest first within each.</div>
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

const Legend: FC = () => (
  <div style={`display:flex;flex-wrap:wrap;gap:6px 16px;margin:0 0 18px;font-size:12.5px;color:${T.faint}`}>
    {(["green", "yellow", "red", "human", "grey"] as const).map((light) => (
      <span style="display:inline-flex;align-items:center;gap:6px">
        <span style={`width:10px;height:10px;border-radius:999px;background:${LIGHT[light].color}`} />
        <span>
          <strong style={`color:${T.body};font-weight:600`}>{LIGHT[light].word}</strong>
          {`: ${LIGHT[light].meaning}`}
        </span>
      </span>
    ))}
  </div>
);

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
        One line per pair of agents. The ball lies with whoever was written to last, in whichever thread; "done" ends it,
        "input_required" hands it to a human.
      </div>
    </div>
    <Legend />
    <div data-live="board" data-live-src={BOARD_SRC}>
      <BoardSection board={board} now={now} />
    </div>
  </V2Layout>
);
