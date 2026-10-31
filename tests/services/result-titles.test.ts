// Titles of result links (src/services/result-titles.ts): asked in the
// background, only the title kept, cached, never waited for, token never
// logged.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ResultTitles, cleanTitle, titleFromAnswer, TITLE_TTL_MS, FAILURE_TTL_MS } from "../../src/services/result-titles";
import type { Fetcher } from "../../src/services/result-titles";
import * as logger from "../../src/services/logger";

const URL_ = "https://results.example.com/mcp";
const TOKEN = "read-only-token-0123456789";
const ID = "06ae5d2b-cf6a-7b57-8000-625378008c57";

let clock: number;
let calls: { url: string; init: RequestInit }[];

const answer = (title: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify({ id: ID, title, body: "SECRET BODY", ...extra }) }] } });

function fetcher(reply: () => Response | Promise<Response>): Fetcher {
  return async (url, init) => {
    calls.push({ url, init });
    return reply();
  };
}

const json = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  clock = Date.parse("2026-10-31T12:00:00Z");
  calls = [];
});

const titles = (f: Fetcher) => new ResultTitles({ mcpUrl: URL_, token: TOKEN, fetch: f, now: () => clock });

describe("ResultTitles", () => {
  it("knows nothing until asked, asks once with the token, and keeps only the title", async () => {
    const t = titles(fetcher(() => json(answer("Handoff 2026-10-31"))));
    expect(t.titleOf(ID)).toBeNull();
    t.want([ID, ID]);
    t.want([ID]);
    await t.settled();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(URL_);
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]!.init.redirect).toBe("error");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_entity", arguments: { id: ID } },
    });
    expect(t.titleOf(ID)).toBe("Handoff 2026-10-31");
  });

  it("reads an answer that comes as one server-sent event", async () => {
    const t = titles(fetcher(() => new Response(`event: message\ndata: ${answer("From SSE")}\n\n`, { headers: { "content-type": "text/event-stream" } })));
    t.want([ID]);
    await t.settled();
    expect(t.titleOf(ID)).toBe("From SSE");
  });

  it("keeps a title for an hour, then asks again", async () => {
    const t = titles(fetcher(() => json(answer("T"))));
    t.want([ID]);
    await t.settled();
    clock += TITLE_TTL_MS - 1;
    t.want([ID]);
    await t.settled();
    expect(calls).toHaveLength(1);
    clock += 1;
    expect(t.titleOf(ID)).toBeNull();
    t.want([ID]);
    await t.settled();
    expect(calls).toHaveLength(2);
  });

  it("remembers a failure for five minutes, logs its kind and never the token", async () => {
    const warn = vi.spyOn(logger, "log");
    const t = titles(fetcher(() => json("{}", 401)));
    t.want([ID]);
    await t.settled();
    expect(t.titleOf(ID)).toBeNull();
    t.want([ID]);
    await t.settled();
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(warn.mock.calls)).toContain("HTTP 401");
    expect(JSON.stringify(warn.mock.calls)).not.toContain(TOKEN);
    clock += FAILURE_TTL_MS;
    t.want([ID]);
    await t.settled();
    expect(calls).toHaveLength(2);
    warn.mockRestore();
  });

  it("treats a timeout, an error answer and a missing title as unknown", async () => {
    const timeout = titles(fetcher(() => { throw Object.assign(new Error("aborted"), { name: "TimeoutError" }); }));
    timeout.want([ID]);
    await timeout.settled();
    expect(timeout.titleOf(ID)).toBeNull();
    const refused = titles(fetcher(() => json(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { isError: true, content: [{ type: "text", text: "not_found" }] } }))));
    refused.want([ID]);
    await refused.settled();
    expect(refused.titleOf(ID)).toBeNull();
    const untitled = titles(fetcher(() => json(answer(42))));
    untitled.want([ID]);
    await untitled.settled();
    expect(untitled.titleOf(ID)).toBeNull();
  });
});

describe("cleanTitle and titleFromAnswer", () => {
  it("makes one bounded line without control or direction characters", () => {
    expect(cleanTitle("  A\n\tB‮C  ")).toBe("A B C");
    expect(cleanTitle("x".repeat(300))).toHaveLength(120);
    expect(cleanTitle("")).toBeNull();
    expect(cleanTitle(null)).toBeNull();
  });

  it("takes only the title out of a tools/call answer", () => {
    expect(titleFromAnswer(JSON.parse(answer("Only this")))).toBe("Only this");
    expect(titleFromAnswer({})).toBeNull();
    expect(titleFromAnswer({ result: { content: [{ type: "text", text: "not json" }] } })).toBeNull();
  });
});
