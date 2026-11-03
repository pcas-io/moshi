// The result-title status line on /board: what an operator reads there
// instead of the log, for every state the title endpoint can be in.

import { describe, it, expect } from "vitest";
import { BoardSection } from "../../../src/views/v2/board";
import type { Board, BoardRow, ResultStatus } from "../../../src/services/board";

const NOW = Date.parse("2026-11-03T14:00:00.000Z");
const EMPTY: Board = { waitingForHuman: [], inPlay: [], quiet: [], nothingMoving: false, resultStatus: null };

async function render(resultStatus: ResultStatus | null): Promise<string> {
  return String(await Promise.resolve(BoardSection({ board: { ...EMPTY, resultStatus }, now: NOW })));
}

describe("result status on /board", () => {
  it("says nothing when result links are not set up", async () => {
    expect(await render(null)).not.toContain("data-result-status");
  });

  it("shows a failing endpoint prominently, with since when and why", async () => {
    const html = await render({
      state: "failing",
      since: NOW - 20 * 60_000,
      at: NOW - 60_000,
      reason: "the address redirects (HTTP 307) to https://results.example.com/mcp/; titles never follow a redirect, set MESH_RESULT_TITLE_MCP_URL to that address",
    });
    expect(html).toContain('data-result-status="failing"');
    expect(html).toContain('role="note"');
    expect(html).toContain("Result titles are failing");
    expect(html).toContain("20 min ago");
    expect(html).toContain("redirects (HTTP 307) to https://results.example.com/mcp/");
  });

  it("names the wrong setting when titles are off because of it", async () => {
    const html = await render({ state: "off", reason: "MESH_RESULT_TITLE_TOKEN must be set together with MESH_RESULT_TITLE_MCP_URL; titles are off" });
    expect(html).toContain('data-result-status="off"');
    expect(html).toContain("MESH_RESULT_TITLE_TOKEN must be set together");
  });

  it("says how to switch titles on when they are simply off", async () => {
    expect(await render({ state: "off", reason: null })).toContain("MESH_RESULT_TITLE_MCP_URL and MESH_RESULT_TITLE_TOKEN switch them on");
  });

  it("is quiet but visible when titles work or were not asked yet", async () => {
    const ok = await render({ state: "ok", at: NOW - 2 * 60_000 });
    expect(ok).toContain('data-result-status="ok"');
    expect(ok).toContain("Result titles: working · last answer");
    expect(ok).not.toContain('role="note"');
    expect(await render({ state: "unchecked" })).toContain("not asked yet");
  });
});

describe("result links on /board", () => {
  const ID = "06ae5d2b-cf6a-7b57-8000-625378008c57";
  const URL_ = `https://results.example.com/entities/${ID}`;
  const row = (title: string | null): BoardRow => ({
    pairKey: "kate\u001ftech", delivered: true, result: { url: URL_, id: ID, title }, history: [],
    from: "kate", to: "tech", threadId: "t1", type: "delivered", holder: "tech", waiting: null,
    humanBall: false, done: false, since: new Date(NOW - 60_000).toISOString(), lastActivity: new Date(NOW - 60_000).toISOString(),
    light: "green", reach: "online", deliversNext: "liefert: review to kate", vagueNext: false, hook: null,
  });
  const html = async (r: BoardRow) => String(await Promise.resolve(BoardSection({ board: { ...EMPTY, inPlay: [r] }, now: NOW })));

  it("cuts a long title and keeps the whole one in the tooltip", async () => {
    const long = `Handoff ${"x".repeat(150)} end`;
    const out = await html(row(long));
    expect(out).toContain(`${long.slice(0, 89)}…</a>`);
    expect(out).toContain(`title="${long}\n${URL_}"`);
  });

  it("shows the end of the id without a title, and the delivery without its prefix", async () => {
    const out = await html(row(null));
    expect(out).toContain(`…${ID.slice(-8)}</a>`);
    expect(out).toContain("Delivers next: review to kate");
    expect(out).not.toContain("liefert:");
  });
});
