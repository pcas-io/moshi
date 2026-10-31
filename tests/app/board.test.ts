// /board through the real app: who may see it, what it shows, and that its
// fragment is byte for byte what the page shows inside the live container.

import { describe, it, expect, beforeEach } from "vitest";
import { createTestApp, signIn, ADMIN_TOKEN } from "./harness";
import type { TestApp } from "./harness";
import { createMessage, persistMessage } from "../../src/services/message";

const FRAGMENT = { Accept: "text/x-moshi-fragment" };
const NOW = Date.parse("2026-10-31T12:00:00.000Z");

let t: TestApp;
let admin: string;
let agentToken: string;

function say(from: string, to: string, minutesAgo: number, type = "info", thread?: string): string {
  const m = createMessage({ from, to, type, payload: "SECRET PAYLOAD", context: "SECRET CONTEXT", correlation_id: thread });
  m.created_at = new Date(NOW - minutesAgo * 60_000).toISOString();
  persistMessage(t.h.db, m, { toKey: to.toLowerCase() });
  return m.id;
}

beforeEach(async () => {
  t = createTestApp({}, { now: () => NOW });
  agentToken = t.h.agents.create("kate").plaintextToken;
  t.h.agents.create("tech");
  admin = (await signIn(t.app, ADMIN_TOKEN)).cookie;
});

const get = (path: string, cookie: string, headers: Record<string, string> = {}) =>
  t.app.request(path, { headers: { Cookie: cookie, ...headers } });

function innerOf(html: string, name: string): string {
  const open = new RegExp(`<div[^>]*data-live="${name}"[^>]*>`).exec(html);
  if (!open) throw new Error(`no live container "${name}"`);
  let depth = 1;
  const start = open.index + open[0].length;
  const re = /<div\b|<\/div>/g;
  re.lastIndex = start;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    depth += m[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return html.slice(start, m.index);
  }
  throw new Error("unclosed live container");
}

describe("/board", () => {
  it("shows the admin who has the ball, and nothing of what was written", async () => {
    say("kate", "tech", 5, "review_request");
    const res = await get("/board", admin);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Who has the ball");
    expect(html).toContain('href="/board"');
    expect(html).toMatch(/>tech<\/span>/);
    expect(html).toContain("has the ball since 5 min ago");
    expect(html).not.toContain("SECRET");
  });

  it("lists a ball handed to a human under 'Wait for human'", async () => {
    say("kate", "tech", 5, "input_required");
    const html = await (await get("/board", admin)).text();
    expect(html).toContain("Wait for human");
    expect(html).toContain("kate needs an answer from a human");
  });

  it("says when nothing is moving", async () => {
    say("kate", "tech", 60);
    expect(await (await get("/board", admin)).text()).toContain("Nothing is moving.");
  });

  it("sends an agent's session home and a stranger to sign in", async () => {
    const agent = (await signIn(t.app, agentToken)).cookie;
    const asAgent = await get("/board", agent);
    expect(asAgent.status).toBe(302);
    expect(asAgent.headers.get("location")).toBe("/");
    const stranger = await t.app.request("/board", { headers: { Accept: "text/html" } });
    expect(stranger.status).toBe(302);
    expect(stranger.headers.get("location")).toMatch(/^\/login/);
    expect((await get("/fragments/board", agent, FRAGMENT)).status).toBe(403);
  });

  it("refreshes with exactly the markup the page shows", async () => {
    say("kate", "tech", 5);
    const t2 = say("tech", "kate", 20, "review_request");
    say("kate", "tech", 2, "done", t2);
    const page = await (await get("/board", admin)).text();
    expect(page).toContain('data-live-src="/fragments/board"');
    const fragment = await get("/fragments/board", admin, FRAGMENT);
    expect(fragment.status).toBe(200);
    expect(await fragment.text()).toBe(innerOf(page, "board"));
  });
});
