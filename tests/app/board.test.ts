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
    expect(html).toMatch(/is on it · since <time datetime="2026-10-31T11:55:00.000Z" title="2026-10-31 11:55 UTC">5 min ago<\/time>/);
    expect(html).not.toContain("SECRET");
  });

  it("lists a ball handed to a human under 'Wait for human'", async () => {
    say("kate", "tech", 5, "input_required");
    const html = await (await get("/board", admin)).text();
    expect(html).toContain("Wait for human");
    expect(html).toContain("kate waits for a human");
    expect(html).toContain("Nothing is moving."); // only a human can move it now
  });

  it("keeps a conversation that goes on in new threads on one line", async () => {
    say("kate", "tech", 30, "review_request");
    say("tech", "kate", 20, "review_result");
    say("kate", "tech", 5, "task_update");
    const html = await (await get("/board", admin)).text();
    expect(html.match(/data-row=/g)).toHaveLength(1);
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

describe("/board stage 2", () => {
  const HOST = "results.example.com";
  const ID = "06ae5d2b-cf6a-7b57-8000-625378008c57";

  beforeEach(async () => {
    t = createTestApp({ resultLinkHosts: [HOST] }, { now: () => NOW });
    t.h.agents.create("kate");
    t.h.agents.create("tech");
    admin = (await signIn(t.app, ADMIN_TOKEN)).cookie;
  });

  function sayText(from: string, to: string, minutesAgo: number, type: string, payload: string) {
    const m = createMessage({ from, to, type, payload, context: "SECRET CONTEXT" });
    m.created_at = new Date(NOW - minutesAgo * 60_000).toISOString();
    persistMessage(t.h.db, m, { fromKey: from, toKey: to });
  }

  it("shows the last action, a delivery waiting for pickup, the result link and a folded history, and no text", async () => {
    sayText("tech", "kate", 30, "review_request", "SECRET please look");
    sayText("kate", "tech", 5, "delivered", `SECRET summary, result: https://${HOST}/entities/${ID}.`);
    const html = await (await get("/board", admin)).text();
    expect(html).toContain("got a delivery from kate");
    expect(html).toContain("Delivered, waiting for tech to pick it up");
    expect(html).toMatch(/Last: <span[^>]*>delivered<\/span> from <span[^>]*>kate<\/span> to <span[^>]*>tech<\/span>/);
    expect(html).toContain(`href="https://${HOST}/entities/${ID}"`);
    expect(html).toContain(`…${ID.slice(-8)}`); // no title service: the end of the id
    expect(html).toContain('data-live-keep="kate~tech"');
    expect(html).toContain("History (last 2)");
    expect(html).not.toContain("SECRET");
  });

  it("ends a done row with its time, and names a webhook that never succeeded", async () => {
    say("kate", "tech", 30);
    const t2 = say("tech", "kate", 10, "done");
    void t2;
    t.h.webhooks.set("tech", { url: "https://hooks.example.com/t", authMode: "standard_webhooks", includeBroadcasts: false, types: null, minPriority: "low" }, undefined, "admin");
    let html = await (await get("/board", admin)).text();
    expect(html).toMatch(/Done, said tech, <time datetime="[^"]+" title="[^"]+">10 min ago<\/time>/);
    say("kate", "tech", 2);
    t.h.presence.list = async () => (await t.h.agents.list()).map((a) => ({ agent: t.h.agents.getByName(a.name)!, presence: "stale" as const, effectiveLastSeen: null }));
    html = await (await get("/board", admin)).text();
    expect(html).toContain("Its webhook has not been called successfully yet.");
    expect(html).not.toContain("No webhook");
  });
});
