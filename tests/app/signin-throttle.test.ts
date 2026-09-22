// Failed sign-ins through the real app: a line in the log, and a 429 after
// ten. Until now a wrong token left no trace at all, anywhere.

import { describe, it, expect, vi, afterEach } from "vitest";
import crypto from "node:crypto";
import { createTestApp, signIn, formPost, cookieFrom, csrfInPage, ADMIN_TOKEN, MCP_HEADERS, rpc } from "./harness";
import { LOGIN_COOKIE, SESSION_COOKIE } from "../../src/auth";

afterEach(() => { vi.restoreAllMocks(); });

const WRONG = "bt_" + "w".repeat(40);
const from = (ip: string) => ({ "X-Forwarded-For": ip });

function capture() {
  const lines: Record<string, unknown>[] = [];
  const take = (line: unknown) => { try { lines.push(JSON.parse(String(line))); } catch { /* not ours */ } };
  vi.spyOn(console, "log").mockImplementation(take);
  vi.spyOn(console, "error").mockImplementation(take);
  vi.spyOn(console, "warn").mockImplementation(take);
  return lines;
}

function setup() {
  let now = Date.UTC(2026, 8, 20, 12, 0, 0);
  const t = createTestApp({}, { now: () => now });
  return { ...t, advance: (ms: number) => { now += ms; } };
}

async function wrongLogin(app: ReturnType<typeof setup>["app"], ip: string, token = WRONG) {
  const page = await app.request("/login", { headers: from(ip) });
  return app.request("/login", formPost({ csrf: csrfInPage(await page.text()), token }, { Cookie: cookieFrom(page, LOGIN_COOKIE)!, ...from(ip) }));
}
const mcp = (app: ReturnType<typeof setup>["app"], ip: string, token: string) =>
  app.request("/mcp", { method: "POST", headers: { ...MCP_HEADERS, Authorization: `Bearer ${token}`, ...from(ip) }, body: rpc("tools/list", {}) });

describe("a wrong token leaves a trace", () => {
  it("writes one line per failed sign-in: where, why, from which network, and never the token", async () => {
    const lines = capture();
    const t = setup();
    await wrongLogin(t.app, "203.0.113.77");
    await mcp(t.app, "203.0.113.77", WRONG);
    const failed = lines.filter((l) => l.msg === "sign-in failed");
    expect(failed).toHaveLength(2);
    expect(failed[0]).toMatchObject({ lvl: "warn", path: "/login", reason: "wrong_token", ip: "203.0.113.x" });
    expect(failed[1]).toMatchObject({ lvl: "warn", path: "/mcp", reason: "wrong_bearer", ip: "203.0.113.x" });
    const everything = JSON.stringify(lines);
    expect(everything).not.toContain(WRONG);
    expect(everything).not.toContain(WRONG.slice(3, 20));
    expect(everything).not.toContain(crypto.createHash("sha256").update(WRONG).digest("hex"));
    expect(everything).not.toContain("203.0.113.77");
  });

  it("says nothing for a request that presents no credential: an expired tab is not an attack", async () => {
    const lines = capture();
    const t = setup();
    await t.app.request("/", { headers: from("203.0.113.77") });
    await t.app.request("/fragments/home/latest", { headers: { Cookie: `${SESSION_COOKIE}=stale`, ...from("203.0.113.77") } });
    await t.app.request("/login", formPost({ csrf: "nonsense", token: WRONG }, from("203.0.113.77"))); // a rejected FORM: the token was never looked at
    expect(lines.filter((l) => l.msg === "sign-in failed")).toHaveLength(0);
  });
});

describe("ten failures, then 429", () => {
  it("answers the eleventh wrong sign-in with 429 and Retry-After, and says so in the log exactly once", async () => {
    const lines = capture();
    const t = setup();
    for (let i = 0; i < 10; i++) {
      const res = await wrongLogin(t.app, "203.0.113.77");
      expect(res.status, `attempt ${i + 1}`).toBe(302);
      t.advance(1000);
    }
    const eleventh = await wrongLogin(t.app, "203.0.113.77");
    expect(eleventh.status).toBe(429);
    expect(eleventh.headers.get("retry-after")).toBe(String(15 * 60 - 10));
    expect(await eleventh.text()).toContain("Too many failed sign-ins");
    await wrongLogin(t.app, "203.0.113.77");
    expect(lines.filter((l) => l.msg === "sign-in failed")).toHaveLength(10);
    expect(lines.filter((l) => l.msg === "sign-in throttled")).toHaveLength(1);
    expect(lines.find((l) => l.msg === "sign-in throttled")).toMatchObject({ lvl: "warn", ip: "203.0.113.x", failures: 10 });
  });

  it("counts /login, /oauth/authorize and wrong Bearers together, per client", async () => {
    const t = setup();
    const challenge = crypto.createHash("sha256").update("v".repeat(64)).digest("base64url");
    const authorize = () => t.app.request("/oauth/authorize", formPost(
      { redirect_uri: "http://localhost:9911/callback", state: "s", code_challenge: challenge, code_challenge_method: "S256", token: WRONG }, from("203.0.113.77")));
    for (let i = 0; i < 4; i++) expect((await wrongLogin(t.app, "203.0.113.77")).status).toBe(302);
    for (let i = 0; i < 3; i++) expect((await authorize()).status).toBe(401);
    for (let i = 0; i < 3; i++) expect((await mcp(t.app, "203.0.113.77", WRONG)).status).toBe(401);

    // The forms turn a throttled client away, with a page a person can read.
    const consent = await authorize();
    expect(consent.status).toBe(429);
    expect(consent.headers.get("content-type")).toContain("text/html");
    expect(await consent.text()).toContain("Too many failed sign-ins");
    expect((await wrongLogin(t.app, "203.0.113.77")).status).toBe(429);
    // A wrong Bearer keeps its 401: see the next case.
    expect((await mcp(t.app, "203.0.113.77", WRONG)).status).toBe(401);

    // Somebody else is not affected.
    expect((await mcp(t.app, "203.0.113.78", WRONG)).status).toBe(401);
  });

  it("keeps answering a wrong Bearer with the 401 that clients act on, and stops counting and logging it", async () => {
    // A connector whose token was reset starts its OAuth flow on 401 plus
    // WWW-Authenticate, and on nothing else. Behind a throttled address a 429
    // hid that from it for as long as a neighbour kept retrying.
    const lines = capture();
    const t = setup();
    for (let i = 0; i < 10; i++) await mcp(t.app, "203.0.113.77", WRONG);
    const throttled = await mcp(t.app, "203.0.113.77", WRONG);
    expect(throttled.status).toBe(401);
    expect(throttled.headers.get("www-authenticate")).toContain("resource_metadata");
    expect(Number(throttled.headers.get("retry-after"))).toBeGreaterThan(0);
    for (let i = 0; i < 50; i++) await mcp(t.app, "203.0.113.77", WRONG);
    expect(lines.filter((l) => l.msg === "sign-in failed")).toHaveLength(10);
    // Before the limit there is no Retry-After to speak of.
    expect((await mcp(t.app, "203.0.113.78", WRONG)).headers.get("retry-after")).toBeNull();
  });

  it("still lets the right credential through: agents share an address, and one stale connector must not lock the others out", async () => {
    const t = setup();
    const { plaintextToken } = t.h.agents.create("scout");
    for (let i = 0; i < 12; i++) await mcp(t.app, "203.0.113.77", WRONG);
    expect((await wrongLogin(t.app, "203.0.113.77")).status).toBe(429);
    expect((await mcp(t.app, "203.0.113.77", plaintextToken)).status).toBe(200);
    const { res } = await signIn(t.app, ADMIN_TOKEN, {}, from("203.0.113.77"));
    expect(res.headers.get("location")).toBe("/");
  });

  it("lets go again when the failures have aged out", async () => {
    const t = setup();
    for (let i = 0; i < 10; i++) await mcp(t.app, "203.0.113.77", WRONG);
    expect((await wrongLogin(t.app, "203.0.113.77")).status).toBe(429);
    t.advance(15 * 60_000 + 1);
    expect((await wrongLogin(t.app, "203.0.113.77")).status).toBe(302);
  });

  it("does not let a client that keeps hammering extend its own block", async () => {
    const t = setup();
    for (let i = 0; i < 10; i++) await wrongLogin(t.app, "203.0.113.77");
    // One attempt a minute for fourteen minutes: all turned away, none counted.
    for (let minute = 1; minute <= 14; minute++) {
      t.advance(60_000);
      expect((await wrongLogin(t.app, "203.0.113.77")).status, `minute ${minute}`).toBe(429);
    }
    t.advance(60_000 + 1);
    expect((await wrongLogin(t.app, "203.0.113.77")).status).toBe(302);
  });

  it("cannot be dodged with a CF-Connecting-IP of one's own choosing, and cannot be aimed at somebody else with it", async () => {
    const t = setup();
    // Straight to the origin, Cloudflare bypassed: the last hop is the sender, whatever the header says.
    for (let i = 0; i < 10; i++) {
      await t.app.request("/mcp", { method: "POST", headers: { ...MCP_HEADERS, Authorization: `Bearer ${WRONG}`, "X-Forwarded-For": "198.51.100.9", "CF-Connecting-IP": `203.0.113.${i}` }, body: rpc("tools/list", {}) });
    }
    expect((await wrongLogin(t.app, "198.51.100.9")).status).toBe(429);
    expect((await wrongLogin(t.app, "203.0.113.5")).status).toBe(302);
    // Through Cloudflare the header is believed.
    for (let i = 0; i < 10; i++) {
      await t.app.request("/mcp", { method: "POST", headers: { ...MCP_HEADERS, Authorization: `Bearer ${WRONG}`, "X-Forwarded-For": "188.114.97.3", "CF-Connecting-IP": "192.0.2.44" }, body: rpc("tools/list", {}) });
    }
    const viaCloudflare = await t.app.request("/mcp", { method: "POST", headers: { ...MCP_HEADERS, Authorization: `Bearer ${WRONG}`, "X-Forwarded-For": "188.114.96.3", "CF-Connecting-IP": "192.0.2.44" }, body: rpc("tools/list", {}) });
    expect(Number(viaCloudflare.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("counts a whole IPv6 /64 as one client: whoever has one address there has all of them", async () => {
    const lines = capture();
    const t = setup();
    for (let i = 1; i <= 10; i++) expect((await wrongLogin(t.app, `2001:db8:1:1::${i.toString(16)}`)).status).toBe(302);
    expect((await wrongLogin(t.app, "2001:db8:1:1:ffff:ffff:ffff:ffff")).status).toBe(429);
    expect((await wrongLogin(t.app, "2001:db8:1:2::1")).status).toBe(302);
    expect(lines.filter((l) => l.msg === "sign-in throttled")).toHaveLength(1);
  });
});

describe("whose address it is", () => {
  const peer = (remoteAddress: string) => ({ incoming: { socket: { remoteAddress } } });
  const wrongBearer = (t: ReturnType<typeof createTestApp>, headers: Record<string, string>, env: unknown) =>
    t.app.request("/mcp", { method: "POST", headers: { ...MCP_HEADERS, Authorization: `Bearer ${WRONG}`, ...headers }, body: rpc("tools/list", {}) }, env as never);
  const retryAfter = (res: Response) => res.headers.get("retry-after");

  it("falls back to the socket when the proxy named nobody", async () => {
    const t = createTestApp();
    for (let i = 0; i < 10; i++) await wrongBearer(t, {}, peer("::ffff:192.0.2.5"));
    expect(retryAfter(await wrongBearer(t, {}, peer("::ffff:192.0.2.5")))).not.toBeNull();
    expect(retryAfter(await wrongBearer(t, {}, peer("::ffff:192.0.2.6")))).toBeNull();
  });

  it("without a proxy in front, believes the socket and no header: the count can be neither dodged nor aimed", async () => {
    const t = createTestApp({ behindProxy: false });
    // Dodge: a new X-Forwarded-For with every attempt.
    for (let i = 0; i < 10; i++) await wrongBearer(t, { "X-Forwarded-For": `198.51.100.${i}` }, peer("192.0.2.5"));
    expect(retryAfter(await wrongBearer(t, { "X-Forwarded-For": "198.51.100.99" }, peer("192.0.2.5")))).not.toBeNull();
    // Aim: ten failures in a colleague's name.
    expect(retryAfter(await wrongBearer(t, {}, peer("198.51.100.3")))).toBeNull();
    // A forged Cloudflare hop is a header like any other.
    for (let i = 0; i < 10; i++) await wrongBearer(t, { "X-Forwarded-For": "188.114.97.3", "CF-Connecting-IP": "203.0.113.200" }, peer("192.0.2.9"));
    expect(retryAfter(await wrongBearer(t, {}, peer("203.0.113.200")))).toBeNull();
  });
});

describe("what does not count", () => {
  it("a wrong Bearer next to a valid session: the browser is signed in", async () => {
    const lines = capture();
    const t = setup();
    const { cookie } = await signIn(t.app, ADMIN_TOKEN, {}, from("203.0.113.77"));
    for (let i = 0; i < 12; i++) {
      const res = await t.app.request("/agents", { headers: { Cookie: cookie, Authorization: `Bearer ${WRONG}`, ...from("203.0.113.77") } });
      expect(res.status).toBe(200);
    }
    expect(lines.filter((l) => l.msg === "sign-in failed")).toHaveLength(0);
  });

  it("an empty token field on the consent form: a form mistake is not an attempt", async () => {
    const lines = capture();
    const t = setup();
    const challenge = crypto.createHash("sha256").update("v".repeat(64)).digest("base64url");
    for (let i = 0; i < 12; i++) {
      const res = await t.app.request("/oauth/authorize", formPost(
        { redirect_uri: "http://localhost:9911/callback", state: "s", code_challenge: challenge, code_challenge_method: "S256", token: "  " }, from("203.0.113.77")));
      expect(res.status).toBe(401);
    }
    expect(lines.filter((l) => l.msg === "sign-in failed")).toHaveLength(0);
  });

  it("a consent form posted from another site: any page could otherwise spend a visitor's count", async () => {
    const lines = capture();
    const t = setup();
    const challenge = crypto.createHash("sha256").update("v".repeat(64)).digest("base64url");
    const fields = { redirect_uri: "http://localhost:9911/callback", state: "s", code_challenge: challenge, code_challenge_method: "S256", token: WRONG };
    for (let i = 0; i < 12; i++) {
      const res = await t.app.request("/oauth/authorize", formPost(fields, { ...from("203.0.113.77"), Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" }));
      expect(res.status).toBe(403);
      expect(await res.text()).toContain("<form");
    }
    expect(lines.filter((l) => l.msg === "sign-in failed")).toHaveLength(0);
    // The visitor's own typo is still answered as one.
    expect((await wrongLogin(t.app, "203.0.113.77")).status).toBe(302);
    // And a cross-site post never gets as far as a VALID token either.
    const { plaintextToken } = t.h.agents.create("scout");
    const crossSite = await t.app.request("/oauth/authorize", formPost({ ...fields, token: plaintextToken }, { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" }));
    expect(crossSite.status).toBe(403);
    expect(crossSite.headers.get("location")).toBeNull();
  });
});

describe("what a flood can write", () => {
  it("bounds the path in a log line", async () => {
    const lines = capture();
    const t = setup();
    await t.app.request("/" + "a".repeat(10_000), { headers: { Authorization: `Bearer ${WRONG}`, ...from("203.0.113.77") } });
    const [line] = lines.filter((l) => l.msg === "sign-in failed");
    expect(String(line.path).length).toBeLessThanOrEqual(200);
    expect(JSON.stringify(line).length).toBeLessThan(400);
  });

  it("bounds the lines a minute, from however many addresses, and says how many it left out", async () => {
    const lines = capture();
    const t = setup();
    for (let i = 0; i < 400; i++) await mcp(t.app, `198.51.${Math.floor(i / 250)}.${i % 250}`, WRONG);
    expect(lines.filter((l) => l.msg === "sign-in failed")).toHaveLength(300);
    expect(lines.filter((l) => l.msg === "sign-in failures not logged")).toHaveLength(0);
    t.advance(60_000);
    await mcp(t.app, "203.0.113.77", WRONG);
    expect(lines.filter((l) => l.msg === "sign-in failures not logged")).toEqual([expect.objectContaining({ lvl: "warn", count: 100 })]);
    expect(lines.filter((l) => l.msg === "sign-in failed")).toHaveLength(301);
  });
});
