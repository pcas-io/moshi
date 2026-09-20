// GET /sse/messages through the real app: the signal that tells an open
// dashboard tab "something was just sent, ask for your fragments now".
//
// It carries ids, never content. What a tab may show is decided by the
// fragment endpoints; this stream only says when to ask.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestApp, ADMIN_TOKEN, TEST_CONFIG, MCP_HEADERS, rpc } from "./harness";
import type { TestApp } from "./harness";
import { generateCsrfToken } from "../../src/auth";
import {
  listenerCount,
  subscribeMessageEvents,
  _resetMessageEventsForTest,
} from "../../src/services/message-events";
import { Hono } from "hono";
import { SSE_HEARTBEAT_MS, SSE_MAX_CONNECTIONS, SSE_MAX_LIFETIME_MS, SSE_MAX_QUEUED, createSseRoutes } from "../../src/routes/sse";
import { publishMessageEvent } from "../../src/services/message-events";
import { createMessage } from "../../src/services/message";

const STREAM = { Accept: "text/event-stream" };

let t: TestApp;
let cookie: string;
let agentToken: string;
const open: ReadableStreamDefaultReader<Uint8Array>[] = [];

async function signIn(app: TestApp["app"], token: string): Promise<string> {
  const res = await app.request("/login", {
    method: "POST",
    body: new URLSearchParams({ csrf: generateCsrfToken(TEST_CONFIG.meshCookieSecret), token }),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
}

/** Reads until `wanted` shows up in what the stream has sent so far. */
async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, wanted: RegExp, ms = 1000): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + ms;
  while (!wanted.test(text)) {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error(`stream did not send ${wanted} within ${ms} ms, got: ${JSON.stringify(text)}`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const chunk = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`stream silent for ${left} ms, got: ${JSON.stringify(text)}`)), left); }),
    ]).finally(() => clearTimeout(timer)); // or this helper's own timer shows up in the timer count below
    if (chunk.done) throw new Error(`stream ended, got: ${JSON.stringify(text)}`);
    text += decoder.decode(chunk.value, { stream: true });
  }
  return text;
}

async function connect(headers: Record<string, string> = {}) {
  const res = await t.app.request("/sse/messages", { headers: { Cookie: cookie, ...STREAM, ...headers } });
  const reader = res.body!.getReader();
  open.push(reader);
  return { res, reader };
}

const send = (payload: string, extra: Record<string, unknown> = {}) =>
  t.app.request("/mcp", {
    method: "POST",
    headers: { ...MCP_HEADERS, Authorization: `Bearer ${agentToken}` },
    body: rpc("tools/call", { name: "mesh_send", arguments: { to: "beta", payload, context: "secret context", ...extra } }),
  });

beforeEach(async () => {
  _resetMessageEventsForTest();
  t = createTestApp();
  agentToken = t.h.agents.create("alpha").plaintextToken;
  t.h.agents.create("beta");
  cookie = await signIn(t.app, ADMIN_TOKEN);
});

afterEach(async () => {
  for (const r of open.splice(0)) await r.cancel().catch(() => {});
  _resetMessageEventsForTest();
});

describe("GET /sse/messages", () => {
  it("is an event stream that no proxy may buffer or store, and says hello at once", async () => {
    const { res, reader } = await connect();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-accel-buffering")).toBe("no");
    // Something has to travel right away, or a buffering proxy holds the
    // response headers back and EventSource never reports "open".
    const first = await readUntil(reader, /\n\n/);
    expect(first.startsWith(":")).toBe(true); // an SSE comment: no event fires for it
  });

  it("announces a sent message with its id and thread id, and with nothing of its content", async () => {
    const { reader } = await connect();
    await readUntil(reader, /\n\n/);
    expect((await send("the launch code is 0000")).status).toBe(200);

    const text = await readUntil(reader, /data: .*\n\n/);
    const data = JSON.parse(/data: (.*)\n/.exec(text)![1]!) as Record<string, unknown>;
    const stored = t.h.db.prepare("SELECT id, created_at FROM messages").get() as { id: string; created_at: string };
    expect(data).toEqual({ id: stored.id, thread_id: stored.id, created_at: stored.created_at });
    expect(text).not.toContain("launch code");
    expect(text).not.toContain("secret context");
    expect(text).not.toContain("alpha");
    expect(text).not.toContain("beta");
  });

  it("names the thread of a reply, so an open thread knows whether it is meant", async () => {
    const { reader } = await connect();
    await readUntil(reader, /\n\n/);
    await send("first");
    const root = (t.h.db.prepare("SELECT id FROM messages").get() as { id: string }).id;
    await readUntil(reader, /data: .*\n\n/);
    await send("second", { correlation_id: root });
    const text = await readUntil(reader, /data: .*\n\n/);
    const data = JSON.parse(/data: (.*)\n/.exec(text)![1]!) as { id: string; thread_id: string };
    expect(data.thread_id).toBe(root);
    expect(data.id).not.toBe(root);
  });

  it("counts its connections, and gives the place back when the tab goes away", async () => {
    expect(listenerCount()).toBe(0);
    const a = await connect();
    const b = await connect();
    await readUntil(a.reader, /\n\n/);
    await readUntil(b.reader, /\n\n/);
    expect(listenerCount()).toBe(2);
    const health = await (await t.app.request("/health")).json() as { sse_connections: number };
    expect(health.sse_connections).toBe(2);

    await a.reader.cancel();
    expect(listenerCount()).toBe(1);
    await b.reader.cancel();
    expect(listenerCount()).toBe(0);
    expect((await (await t.app.request("/health")).json() as { sse_connections: number }).sse_connections).toBe(0);
  });

  it("refuses connection number fifty-one with 503, and takes it once a place is free", async () => {
    expect(SSE_MAX_CONNECTIONS).toBe(50);
    const release: (() => void)[] = [];
    for (let i = 0; i < SSE_MAX_CONNECTIONS; i++) release.push(subscribeMessageEvents(() => {}));
    const full = await t.app.request("/sse/messages", { headers: { Cookie: cookie, ...STREAM } });
    expect(full.status).toBe(503);
    expect(full.headers.get("content-type")).toContain("application/json");
    expect(listenerCount()).toBe(SSE_MAX_CONNECTIONS); // the refused one took no place
    release.pop()!();
    const { res } = await connect();
    expect(res.status).toBe(200);
  });

  it("gives HEAD no place: hono runs the GET handler for it and then throws the body away, uncancelled", async () => {
    // Found on the real process: 50 x `curl -I` took all 50 places for good,
    // and every real tab got 503 until the restart.
    for (let i = 0; i < 3; i++) {
      const res = await t.app.request("/sse/messages", { method: "HEAD", headers: { Cookie: cookie, ...STREAM } });
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("GET");
    }
    expect(listenerCount()).toBe(0);
  });

  it("answers a missing session with a plain 401, not with a redirect EventSource would follow", async () => {
    const res = await t.app.request("/sse/messages", { headers: STREAM });
    expect(res.status).toBe(401);
    expect(listenerCount()).toBe(0);
  });

  it("does not count as the agent being around", async () => {
    const agentCookie = await signIn(t.app, agentToken);
    t.touch.mockClear();
    const res = await t.app.request("/sse/messages", { headers: { Cookie: agentCookie, ...STREAM } });
    open.push(res.body!.getReader());
    expect(res.status).toBe(200);
    expect(t.touch).not.toHaveBeenCalled();
  });

  it("writes no sign-in audit row for a stream that (re)connects, however long after the last one", async () => {
    const token = t.h.agents.create("streamer").plaintextToken;
    const session = await signIn(t.app, token);
    const rows = () => (t.h.db.prepare("SELECT COUNT(*) AS n FROM activity_log WHERE action = 'auth_login' AND agent_name = 'streamer'").get() as { n: number }).n;
    const res = await t.app.request("/sse/messages", { headers: { Cookie: session, ...STREAM } });
    open.push(res.body!.getReader());
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 20)); // logAsync
    expect(rows()).toBe(0);
  });

  it("no longer serves the per-thread stream that carried payloads", async () => {
    const res = await t.app.request("/sse/threads/01ABC", { headers: { Cookie: cookie, ...STREAM } });
    expect(res.status).toBe(404);
  });
});

// The route on its own, with a short heartbeat: what a test of the whole app
// cannot wait 25 seconds for.
describe("GET /sse/messages — keeping a connection alive, and not for ever", () => {
  const event = () => publishMessageEvent(createMessage({ from: "a", to: "b", type: "info", payload: "p", context: "c" }));
  const timers = () => process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;

  beforeEach(() => { _resetMessageEventsForTest(); });

  it("pings under Cloudflare's hundred seconds, as a comment that fires no event", async () => {
    expect(SSE_HEARTBEAT_MS).toBe(25_000);
    const app = new Hono().route("/", createSseRoutes({ heartbeatMs: 20 }));
    const reader = (await app.request("/sse/messages")).body!.getReader();
    const text = await readUntil(reader, /: ping\n\n[\s\S]*: ping\n\n/, 2000);
    expect(text.startsWith(": open\n\n")).toBe(true);
    expect(text).not.toMatch(/^(event|data):/m);
    await reader.cancel();
    expect(listenerCount()).toBe(0);
  });

  it("leaves no timer behind when the tab goes away between two pings", async () => {
    const before = timers();
    const app = new Hono().route("/", createSseRoutes({ heartbeatMs: 60_000 }));
    const reader = (await app.request("/sse/messages")).body!.getReader();
    await readUntil(reader, /: open\n\n/);
    expect(timers()).toBeGreaterThan(before);
    await reader.cancel();
    await new Promise((r) => setTimeout(r, 10));
    expect(timers()).toBe(before);
  });

  it("ends a connection whose reader does not read, instead of queueing events for it without end", async () => {
    expect(SSE_MAX_QUEUED).toBe(256);
    const app = new Hono().route("/", createSseRoutes({ heartbeatMs: 60_000 }));
    const res = await app.request("/sse/messages");
    res.body!.getReader(); // held, never read
    await new Promise((r) => setTimeout(r, 10));
    expect(listenerCount()).toBe(1);
    for (let i = 0; i < SSE_MAX_QUEUED + 50; i++) event();
    await new Promise((r) => setTimeout(r, 10));
    expect(listenerCount()).toBe(0); // EventSource reconnects, and the script asks for everything when it opens
  });

  it("ends every connection after half an hour: a leaked place, a stalled reader and a revoked session all end there", async () => {
    expect(SSE_MAX_LIFETIME_MS).toBe(30 * 60_000);
    const app = new Hono().route("/", createSseRoutes({ heartbeatMs: 10, maxLifetimeMs: 60 }));
    const reader = (await app.request("/sse/messages")).body!.getReader();
    const chunks: string[] = [];
    const decoder = new TextDecoder();
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      chunks.push(decoder.decode(chunk.value));
    }
    expect(chunks.join("")).toContain(": open");
    expect(listenerCount()).toBe(0);
  });
});
