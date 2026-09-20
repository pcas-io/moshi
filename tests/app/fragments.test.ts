// The live sections' endpoints, through the real app.
//
// A fragment is the inside of one live container, rendered by the same
// loader and the same component as the page. These tests hold that promise:
// what the page shows inside a container is byte for byte what its fragment
// URL returns.

import { describe, it, expect, beforeEach } from "vitest";
import { createTestApp, signIn as signInThroughTheForm, ADMIN_TOKEN } from "./harness";
import type { TestApp } from "./harness";
import { createMessage, persistMessage } from "../../src/services/message";

const FRAGMENT = { Accept: "text/x-moshi-fragment" };
const NOW = Date.parse("2026-09-19T12:00:00.000Z");

let t: TestApp;
let cookie: string;

const signIn = async (app: TestApp["app"], token: string = ADMIN_TOKEN): Promise<string> => (await signInThroughTheForm(app, token)).cookie;

function say(from: string, to: string, payload: string, minutesAgo: number, correlation_id?: string) {
  const m = createMessage({ from, to, type: "info", payload, context: `about ${payload}`, correlation_id });
  m.created_at = new Date(NOW - minutesAgo * 60_000).toISOString();
  persistMessage(t.h.db, m);
  return m;
}

beforeEach(async () => {
  t = createTestApp({}, { now: () => NOW });
  t.h.agents.create("alpha");
  t.h.agents.create("beta");
  cookie = await signIn(t.app);
});

const get = (path: string, headers: Record<string, string> = {}) =>
  t.app.request(path, { headers: { Cookie: cookie, ...headers } });

/** The inner HTML of the element carrying data-live="name". Live containers
 *  are divs or sections without same-tag children at the top level being
 *  ambiguous: find the matching close by counting. */
function innerOf(html: string, name: string): string {
  const open = new RegExp(`<(div|section)[^>]*data-live="${name}"[^>]*>`).exec(html);
  if (!open) throw new Error(`no live container "${name}"`);
  const tag = open[1]!;
  let depth = 1;
  let i = open.index + open[0].length;
  const start = i;
  const re = new RegExp(`<${tag}\\b|</${tag}>`, "g");
  re.lastIndex = i;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    depth += m[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return html.slice(start, m.index);
    i = re.lastIndex;
  }
  throw new Error(`unclosed live container "${name}"`);
}

const srcOf = (html: string, name: string): string => {
  const m = new RegExp(`data-live="${name}"[^>]*data-live-src="([^"]+)"`).exec(html);
  if (!m) throw new Error(`no data-live-src for "${name}"`);
  return m[1]!.replace(/&amp;/g, "&");
};

describe("fragment endpoints — the contract", () => {
  it("answers 200 with section markup only, no-store and an ETag", async () => {
    say("alpha", "beta", "hello", 3);
    const res = await get("/fragments/log/messages", FRAGMENT);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);
    expect(res.headers.get("cache-control")).toBe("no-store, no-transform");
    expect(res.headers.get("etag")).toMatch(/^"[0-9a-f]{16,}"$/);
    const html = await res.text();
    expect(html).toContain("about hello");
    expect(html).not.toMatch(/<html|<head|<script|<body/i);
  });

  it("forbids a proxy to rewrite the markup or the tag: no-transform next to no-store", async () => {
    // Cloudflare weakens or drops the ETag of HTML it touches, and its email
    // obfuscation rewrites addresses into markup whose decoder script never
    // runs for HTML that arrives through innerHTML.
    say("alpha", "beta", "hello", 3);
    const res = await get("/fragments/log/messages", FRAGMENT);
    expect(res.headers.get("cache-control")).toBe("no-store, no-transform");
    const again = await get("/fragments/log/messages", { ...FRAGMENT, "If-None-Match": res.headers.get("etag")! });
    expect(again.status).toBe(304);
    expect(again.headers.get("cache-control")).toBe("no-store, no-transform");
  });

  it("answers 304 without a body when the client already has this version", async () => {
    say("alpha", "beta", "hello", 3);
    const first = await get("/fragments/log/messages", FRAGMENT);
    const etag = first.headers.get("etag")!;
    const again = await get("/fragments/log/messages", { ...FRAGMENT, "If-None-Match": etag });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe("");
    expect(again.headers.get("etag")).toBe(etag);

    say("beta", "alpha", "something new", 1);
    const changed = await get("/fragments/log/messages", { ...FRAGMENT, "If-None-Match": etag });
    expect(changed.status).toBe(200);
    expect(changed.headers.get("etag")).not.toBe(etag);
  });

  it("compares If-None-Match the way RFC 9110 asks for: weakly, in a list, and past a proxy's -gzip suffix", async () => {
    // A compressing proxy hands the tag back as W/"…" or "…-gzip". An exact
    // string match would never answer 304 behind one, and every tab would
    // replace all of its sections every five seconds.
    say("alpha", "beta", "hello", 3);
    const etag = (await get("/fragments/log/messages", FRAGMENT)).headers.get("etag")!;
    const bare = etag.slice(1, -1);
    for (const sent of [`W/${etag}`, `"${bare}-gzip"`, `W/"${bare}-br"`, `"something-else", ${etag}`, `"x" , W/${etag}`, "*"]) {
      const res = await get("/fragments/log/messages", { ...FRAGMENT, "If-None-Match": sent });
      expect(res.status, sent).toBe(304);
    }
    for (const sent of [`"${bare}x"`, `"x${bare}"`, `"${bare.slice(0, -1)}"`, '""', "W/", bare.slice(0, 8)]) {
      const res = await get("/fragments/log/messages", { ...FRAGMENT, "If-None-Match": sent });
      expect(res.status, sent).toBe(200);
    }
  });

  it("answers 401 JSON without a session — never a redirect the script would follow into the login page", async () => {
    const res = await t.app.request("/fragments/log/messages", { headers: FRAGMENT });
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toMatch(/json/);
  });

  it("answers 406 to a plain navigation, so nobody ever lands on bare fragment HTML", async () => {
    for (const path of ["/fragments/log/messages", "/fragments/conversations/list", "/fragments/conversations/thread?id=x", "/fragments/home/latest"]) {
      const res = await get(path, { Accept: "text/html" });
      expect(res.status, path).toBe(406);
    }
  });

  it("answers 404 for a section that does not exist", async () => {
    expect((await get("/fragments/nope", FRAGMENT)).status).toBe(404);
  });
});

describe("fragment endpoints — the page and its fragments are the same markup", () => {
  it("Log, Messages tab: with filters and on page two", async () => {
    for (let i = 0; i < 60; i++) say("alpha", i % 2 ? "beta" : "broadcast", `m${i}`, i + 1);
    for (const path of ["/log", "/log?routing=direct&q=m1", "/log?offset=50"]) {
      const page = await (await get(path, { Accept: "text/html" })).text();
      const fragment = await (await get(srcOf(page, "log-messages"), FRAGMENT)).text();
      expect(fragment.length, path).toBeGreaterThan(200);
      expect(innerOf(page, "log-messages"), path).toBe(fragment);
    }
  });

  it("Conversations: the list, with the count line handed over out of band", async () => {
    const root = say("alpha", "beta", "question", 5);
    say("beta", "alpha", "answer", 4, root.id);
    say("alpha", "broadcast", "to all", 2);
    const page = await (await get("/conversations?q=a", { Accept: "text/html" })).text();
    const res = await get(srcOf(page, "convos-list"), FRAGMENT);
    // The count line lives next to the search box, outside of the list. It
    // travels in a header, as text, and the body stays exactly the list.
    const oob = new URLSearchParams(res.headers.get("x-moshi-oob") ?? "");
    expect(oob.get("convos-count")).toBe("2 threads · 2 still moving");
    expect(page).toContain(`id="convos-count"`);
    expect(innerOf(page, "convos-list")).toBe(await res.text());

    // A new thread changes the header, and with it the ETag, even if the
    // visible page of the list were to stay the same.
    const etag = res.headers.get("etag")!;
    say("beta", "alpha", "another", 1);
    const next = await get(srcOf(page, "convos-list"), { ...FRAGMENT, "If-None-Match": etag });
    expect(next.status).toBe(200);
    expect(new URLSearchParams(next.headers.get("x-moshi-oob") ?? "").get("convos-count")).toBe("3 threads · 3 still moving");
  });

  it("Conversations: the open thread, pinned by id", async () => {
    const root = say("alpha", "beta", "question", 5);
    say("beta", "alpha", "answer", 4, root.id);
    const page = await (await get("/conversations", { Accept: "text/html" })).text();
    const src = srcOf(page, "convos-thread");
    expect(src).toBe(`/fragments/conversations/thread?id=${root.id}`);
    expect(innerOf(page, "convos-thread")).toBe(await (await get(src, FRAGMENT)).text());

    // A newer thread must not take over the open pane.
    say("alpha", "broadcast", "something newer", 1);
    const refreshed = await (await get(src, FRAGMENT)).text();
    expect(refreshed).toContain("answer");
    expect(refreshed).not.toContain("something newer");
  });

  it("Conversations and Home: a thread whose id is also a reply's id stays itself, on the page and on every refresh", async () => {
    // mesh_send accepts any correlation_id, also the id of someone's reply.
    const root = say("alpha", "beta", "ROOT-QUESTION", 9);
    const reply = say("beta", "alpha", "REPLY-ANSWER", 8, root.id);
    const side = say("alpha", "beta", "SIDE-MESSAGE", 1, reply.id);

    for (const url of ["/conversations", `/conversations?id=${reply.id}`, `/conversations?id=${side.id}`]) {
      const page = await (await get(url, { Accept: "text/html" })).text();
      const pane = innerOf(page, "convos-thread");
      expect(pane, url).toContain("SIDE-MESSAGE");
      expect(pane, url).not.toContain("ROOT-QUESTION");
      expect(await (await get(srcOf(page, "convos-thread"), FRAGMENT)).text(), url).toBe(pane);
    }
    // The other row still opens the other thread.
    const other = await (await get(`/conversations?id=${root.id}`, { Accept: "text/html" })).text();
    expect(innerOf(other, "convos-thread")).toContain("REPLY-ANSWER");
    expect(innerOf(other, "convos-thread")).not.toContain("SIDE-MESSAGE");

    const home = await (await get("/", { Accept: "text/html" })).text();
    expect(innerOf(home, "home-latest")).toContain("SIDE-MESSAGE");
    expect(await (await get(srcOf(home, "home-latest"), FRAGMENT)).text()).toBe(innerOf(home, "home-latest"));
  });

  it("Conversations: a thread sent with spaces around its correlation id opens from its own row, and the list keeps the row marked", async () => {
    say("alpha", "beta", "padded thread", 2, " topic-1 ");
    const page = await (await get("/conversations", { Accept: "text/html" })).text();
    const href = /href="(\/conversations\?[^"]*id=[^"]*)"/.exec(innerOf(page, "convos-list"))![1]!.replace(/&amp;/g, "&");
    const opened = await (await get(href, { Accept: "text/html" })).text();
    expect(innerOf(opened, "convos-thread")).toContain("padded thread");
    expect(innerOf(opened, "convos-thread")).not.toContain("That conversation is not here");
    expect(await (await get(srcOf(opened, "convos-list"), FRAGMENT)).text()).toBe(innerOf(opened, "convos-list"));
    expect(await (await get(srcOf(opened, "convos-thread"), FRAGMENT)).text()).toBe(innerOf(opened, "convos-thread"));
  });

  it("Conversations: a thread that is gone says so in the fragment too", async () => {
    const res = await get("/fragments/conversations/thread?id=msg_GONE", FRAGMENT);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("That conversation is not here");
  });

  it("Home: the latest conversation card", async () => {
    const root = say("alpha", "beta", "question", 5);
    say("beta", "alpha", "answer", 4, root.id);
    const page = await (await get("/", { Accept: "text/html" })).text();
    const fragment = await (await get(srcOf(page, "home-latest"), FRAGMENT)).text();
    expect(fragment).toContain("answer");
    expect(innerOf(page, "home-latest")).toBe(fragment);
  });

  it("Home: an empty mesh has a live card too, so the first conversation can appear", async () => {
    const page = await (await get("/", { Accept: "text/html" })).text();
    const fragment = await (await get(srcOf(page, "home-latest"), FRAGMENT)).text();
    expect(innerOf(page, "home-latest")).toBe(fragment);
    const root = say("alpha", "beta", "the first one", 1);
    const after = await (await get("/fragments/home/latest", FRAGMENT)).text();
    expect(after).toContain("the first one");
    expect(after).toContain(root.id);
  });
});

describe("the route decides which thread is open", () => {
  it("opens the thread a reply's id belongs to, wherever it is in the history, and pins its root", async () => {
    const old = say("zulu", "alpha", "older question", 50);
    const oldReply = say("alpha", "zulu", "older answer", 49, old.id);
    say("alpha", "beta", "newest thread", 1);
    const page = await (await get(`/conversations?id=${oldReply.id}`, { Accept: "text/html" })).text();
    expect(srcOf(page, "convos-thread")).toBe(`/fragments/conversations/thread?id=${old.id}`);
    expect(innerOf(page, "convos-thread")).toContain("older answer");
    expect(innerOf(page, "convos-thread")).not.toContain("newest thread");
    expect(srcOf(page, "convos-list")).toContain(`id=${old.id}`);
    expect(innerOf(page, "convos-list")).toContain('aria-current="true"');
  });

  it("says on the PAGE that an id is unknown, and opens nothing", async () => {
    say("alpha", "beta", "some thread", 1);
    const page = await (await get("/conversations?id=msg_GONE", { Accept: "text/html" })).text();
    expect(page).toContain("That conversation is not here");
    expect(page).toContain("msg_GONE");
    expect(page).not.toContain('data-live="convos-thread"');
    expect(page).not.toContain('aria-current="true"');
  });
});

describe("fragment endpoints — parity where it is easy to lose", () => {
  it("holds with a filter that excludes something, an agent filter, page two, and agents that have roles", async () => {
    await t.h.presence.touch("alpha", { role: "dev-ops" });
    await t.h.presence.touch("beta", { role: "triage-agent" });
    t.h.agents.create("gamma");
    for (let i = 0; i < 60; i++) say(i % 2 ? "alpha" : "gamma", "beta", i % 3 ? `keep ${i}` : `drop ${i}`, i + 1);
    for (const path of ["/conversations?q=keep", "/conversations?agent=gamma", "/conversations?offset=50", "/conversations?agent=gamma&q=keep"]) {
      const page = await (await get(path, { Accept: "text/html" })).text();
      expect(innerOf(page, "convos-list"), path).toBe(await (await get(srcOf(page, "convos-list"), FRAGMENT)).text());
      expect(innerOf(page, "convos-thread"), path).toBe(await (await get(srcOf(page, "convos-thread"), FRAGMENT)).text());
    }
    // Parity cannot see a filter that BOTH sides drop: count once.
    const filtered = await (await get("/conversations?agent=gamma&q=keep", { Accept: "text/html" })).text();
    expect(filtered).toContain("20 threads");
    for (const path of ["/log?agent=gamma", "/log?routing=direct&agent=alpha&q=keep"]) {
      const log = await (await get(path, { Accept: "text/html" })).text();
      expect(innerOf(log, "log-messages"), path).toBe(await (await get(srcOf(log, "log-messages"), FRAGMENT)).text());
    }
    const byGamma = await (await get("/log?agent=gamma", { Accept: "text/html" })).text();
    expect(innerOf(byGamma, "log-messages")).toContain("gamma");
    expect(innerOf(byGamma, "log-messages")).not.toContain(">alpha<");
    const broadcastOnly = await (await get("/log?routing=broadcast", { Accept: "text/html" })).text();
    expect(innerOf(broadcastOnly, "log-messages")).not.toContain("keep 1");
    const home = await (await get("/", { Accept: "text/html" })).text();
    expect(innerOf(home, "home-latest")).toBe(await (await get(srcOf(home, "home-latest"), FRAGMENT)).text());
    expect(innerOf(home, "home-latest")).toContain("drop 0"); // the newest of the sixty
  });

  it("moves the ETag when ONLY the out-of-band count line changed", async () => {
    for (let i = 0; i < 52; i++) say("alpha", "beta", `t${i}`, i + 1);
    const first = await get("/fragments/conversations/list", FRAGMENT);
    const html = await first.text();
    // Drop the oldest thread: page one and its pager stay the same, the total does not.
    t.h.db.prepare("DELETE FROM messages WHERE id = (SELECT id FROM messages ORDER BY created_at ASC LIMIT 1)").run();
    const second = await get("/fragments/conversations/list", { ...FRAGMENT, "If-None-Match": first.headers.get("etag")! });
    expect(second.status).toBe(200);
    expect(await second.text()).toBe(html);
    expect(second.headers.get("x-moshi-oob")).not.toBe(first.headers.get("x-moshi-oob"));
  });
});

describe("fragment endpoints — a poll is not agent activity", () => {
  it("does not refresh an agent's presence, however long its dashboard tab stays open", async () => {
    // Signed in with an AGENT token. A page view still counts as being
    // around; the five-second poll behind it must not, or an open tab would
    // keep its agent "live" for days.
    const agentToken = t.h.agents.resetToken(t.h.agents.getByName("alpha")!.id, "admin")!.plaintextToken;
    const agentCookie = await signIn(t.app, agentToken);
    const asAgent = (path: string, headers: Record<string, string>) =>
      t.app.request(path, { headers: { Cookie: agentCookie, ...headers } });

    t.touch.mockClear();
    expect((await asAgent("/log", { Accept: "text/html" })).status).toBe(200);
    expect(t.touch).toHaveBeenCalledTimes(1);

    t.touch.mockClear();
    for (const path of ["/fragments/log/messages", "/fragments/conversations/list", "/fragments/home/latest"]) {
      expect((await asAgent(path, FRAGMENT)).status, path).toBe(200);
    }
    expect(t.touch).not.toHaveBeenCalled();
  });
});

describe("fragment endpoints — a poll is not a sign-in either", () => {
  it("writes no 'authenticated' audit row for a poll: an open tab would add one every half hour, for ever", async () => {
    // The throttle is per name and per process, so this needs a name nobody
    // has used yet in this file.
    const token = t.h.agents.create("pollster").plaintextToken;
    const session = await signIn(t.app, token);
    const rows = () => (t.h.db.prepare("SELECT COUNT(*) AS n FROM activity_log WHERE action = 'auth_login' AND agent_name = 'pollster'").get() as { n: number }).n;

    for (const path of ["/fragments/log/messages", "/fragments/conversations/list", "/fragments/home/latest"]) {
      expect((await t.app.request(path, { headers: { Cookie: session, ...FRAGMENT } })).status, path).toBe(200);
    }
    await new Promise((r) => setTimeout(r, 20)); // logAsync
    expect(rows()).toBe(0);

    // A page view is somebody at the keyboard, and is logged as before.
    expect((await t.app.request("/log", { headers: { Cookie: session, Accept: "text/html" } })).status).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    expect(rows()).toBe(1);
  });
});

describe("fragment endpoints — cost", () => {
  it("reads presence once per Home card refresh, and not at all for Log and Conversations", async () => {
    say("alpha", "beta", "hello", 3);
    const { vi } = await import("vitest");
    const list = vi.spyOn(t.h.presence, "list");
    await get("/fragments/log/messages", FRAGMENT);
    await get("/fragments/conversations/list", FRAGMENT);
    expect(list).toHaveBeenCalledTimes(0);
    await get("/fragments/home/latest", FRAGMENT);
    expect(list).toHaveBeenCalledTimes(1);
  });
});
