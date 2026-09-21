// Sessions, sign-out and form tokens through the real app.
//
// What this pins, each against the real middleware:
// - a session belongs to the token it was made from (reset, revoke, delete,
//   admin rotation end it; a rename does not),
// - it lasts seven days without use, is renewed by real page views only, and
//   ends thirty days after the sign-in,
// - /mcp takes a Bearer token and nothing else,
// - signing out is a POST with the session's own form token,
// - a form token from one session is worthless in another.

import { describe, it, expect, afterEach, vi } from "vitest";
import crypto from "node:crypto";
import { createTestApp, signIn, csrfFor, csrfInPage, cookieFrom, formPost, ADMIN_TOKEN, TEST_CONFIG, MCP_HEADERS, rpc } from "./harness";
import { SESSION_COOKIE, LOGIN_COOKIE } from "../../src/auth";

const DAY = 24 * 60 * 60 * 1000;
const HTML = { Accept: "text/html" };
const T0 = Date.UTC(2026, 8, 20, 12, 0, 0);

afterEach(() => {
  vi.useRealTimers();
});

function clock(at: number) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at);
}

describe("a session belongs to the token it was made from", () => {
  it("ends when the agent's token is reset", async () => {
    const t = createTestApp();
    const { agent, plaintextToken } = t.h.agents.create("scout");
    const { cookie } = await signIn(t.app, plaintextToken);
    expect((await t.app.request("/", { headers: { Cookie: cookie, ...HTML } })).status).toBe(200);

    t.h.agents.resetToken(agent.id, "admin");
    const page = await t.app.request("/", { headers: { Cookie: cookie, ...HTML } });
    expect(page.status).toBe(302);
    expect(page.headers.get("location")).toBe("/login?next=%2F");
    expect((await t.app.request("/fragments/home/latest", { headers: { Cookie: cookie } })).status).toBe(401);
  });

  it("ends when the agent is revoked, and does not come back with a reactivation", async () => {
    const t = createTestApp();
    const { agent, plaintextToken } = t.h.agents.create("scout");
    const { cookie } = await signIn(t.app, plaintextToken);
    t.h.agents.revokeById(agent.id, "admin");
    expect((await t.app.request("/", { headers: { Cookie: cookie } })).status).toBe(401);
    t.h.agents.reactivate(agent.id, "admin");
    expect((await t.app.request("/", { headers: { Cookie: cookie } })).status).toBe(401);
  });

  it("is not inherited by a new agent that gets the old one's name", async () => {
    // The cookie used to carry the NAME. Delete "scout", create "scout":
    // the old cookie was the new agent's session.
    const t = createTestApp();
    const first = t.h.agents.create("scout");
    const { cookie } = await signIn(t.app, first.plaintextToken);
    t.h.agents.deleteById(first.agent.id, "admin");
    t.h.agents.create("scout");
    expect((await t.app.request("/", { headers: { Cookie: cookie } })).status).toBe(401);
  });

  it("survives a rename: the agent is the same, its token is the same", async () => {
    const t = createTestApp();
    const { agent, plaintextToken } = t.h.agents.create("scout");
    const { cookie } = await signIn(t.app, plaintextToken);
    t.h.agents.rename(agent.id, "scout-eu", "admin");
    expect((await t.app.request("/", { headers: { Cookie: cookie, ...HTML } })).status).toBe(200);
  });

  it("ends for the operator when the admin token is rotated away", async () => {
    const OLD = ADMIN_TOKEN;
    const NEW = "n".repeat(40);
    const { cookie } = await signIn(createTestApp().app, OLD);
    expect(cookie).not.toBe("");
    // While the old token is still configured as the previous one, its sessions go on.
    const during = createTestApp({ meshAdminToken: NEW, meshAdminTokenPrevious: OLD });
    expect((await during.app.request("/", { headers: { Cookie: cookie, ...HTML } })).status).toBe(200);
    // Once it is gone, so are they.
    const after = createTestApp({ meshAdminToken: NEW });
    expect((await after.app.request("/", { headers: { Cookie: cookie } })).status).toBe(401);
  });

  it("refuses the old cookie format, even with a good signature", async () => {
    const t = createTestApp();
    const payload = `admin:${Date.now()}`;
    const mac = crypto.createHmac("sha256", TEST_CONFIG.meshCookieSecret).update(payload).digest("hex");
    const res = await t.app.request("/", { headers: { Cookie: `${SESSION_COOKIE}=${encodeURIComponent(`${payload}:${mac}`)}` } });
    expect(res.status).toBe(401);
  });
});

describe("seven days, sliding", () => {
  it("sets the cookie for seven days", async () => {
    const { res } = await signIn(createTestApp().app, ADMIN_TOKEN);
    expect(res.headers.getSetCookie().find((l) => l.startsWith(`${SESSION_COOKIE}=`))).toMatch(/Max-Age=604800/);
  });

  it("is renewed by a page view once it is a day old, with the same attributes", async () => {
    clock(T0);
    const t = createTestApp({ cookieSecure: true });
    const { cookie } = await signIn(t.app, ADMIN_TOKEN);

    clock(T0 + DAY - 60_000);
    expect(cookieFrom(await t.app.request("/", { headers: { Cookie: cookie, ...HTML } }), SESSION_COOKIE)).toBeNull();

    clock(T0 + 6 * DAY);
    const viewed = await t.app.request("/", { headers: { Cookie: cookie, ...HTML } });
    expect(viewed.status).toBe(200);
    const line = viewed.headers.getSetCookie().find((l) => l.startsWith(`${SESSION_COOKIE}=`)) ?? "";
    expect(line).toMatch(/Max-Age=604800/);
    expect(line).toMatch(/HttpOnly/i);
    expect(line).toMatch(/SameSite=Lax/i);
    expect(line).toMatch(/;\s*Secure/i);
    const renewed = cookieFrom(viewed, SESSION_COOKIE)!;

    // Day 12: the first cookie is over, the renewed one is not.
    clock(T0 + 12 * DAY);
    expect((await t.app.request("/", { headers: { Cookie: cookie } })).status).toBe(401);
    expect((await t.app.request("/", { headers: { Cookie: renewed, ...HTML } })).status).toBe(200);
  });

  it("is not renewed by what a tab does on its own", async () => {
    clock(T0);
    const t = createTestApp();
    const { cookie } = await signIn(t.app, ADMIN_TOKEN);
    clock(T0 + 6 * DAY);
    for (const path of ["/fragments/home/latest", "/fragments/log/messages"]) {
      const res = await t.app.request(path, { headers: { Cookie: cookie, Accept: "text/x-moshi-fragment" } });
      expect(res.status, path).toBe(200);
      expect(cookieFrom(res, SESSION_COOKIE), path).toBeNull();
    }
    // A tab left open does not keep its session alive.
    clock(T0 + 7 * DAY + 1);
    expect((await t.app.request("/fragments/home/latest", { headers: { Cookie: cookie } })).status).toBe(401);
  });

  it("ends thirty days after the sign-in, however regularly it was used", async () => {
    clock(T0);
    const t = createTestApp();
    let { cookie } = await signIn(t.app, ADMIN_TOKEN);
    for (let day = 5; day <= 30; day += 5) {
      clock(T0 + day * DAY);
      const res = await t.app.request("/", { headers: { Cookie: cookie, ...HTML } });
      expect(res.status, `day ${day}`).toBe(200);
      cookie = cookieFrom(res, SESSION_COOKIE) ?? cookie;
    }
    clock(T0 + 30 * DAY + 1);
    expect((await t.app.request("/", { headers: { Cookie: cookie } })).status).toBe(401);
  });
});

describe("/mcp takes a Bearer token and nothing else", () => {
  it("answers a session cookie with 401 and the discovery header", async () => {
    const t = createTestApp();
    const { plaintextToken } = t.h.agents.create("scout");
    const { cookie } = await signIn(t.app, plaintextToken);
    const body = rpc("tools/list", {});
    const withCookie = await t.app.request("/mcp", { method: "POST", headers: { ...MCP_HEADERS, Cookie: cookie }, body });
    expect(withCookie.status).toBe(401);
    expect(withCookie.headers.get("www-authenticate")).toContain("oauth-protected-resource");
    expect(t.ensured).toEqual([]);
    const withBearer = await t.app.request("/mcp", { method: "POST", headers: { ...MCP_HEADERS, Authorization: `Bearer ${plaintextToken}` }, body });
    expect(withBearer.status).toBe(200);
  });
});

describe("signing out", () => {
  it("is not something a GET can do", async () => {
    const t = createTestApp();
    const { cookie } = await signIn(t.app, ADMIN_TOKEN);
    const res = await t.app.request("/logout", { headers: { Cookie: cookie, ...HTML } });
    expect(res.status).toBe(404);
    expect(cookieFrom(res, SESSION_COOKIE)).toBeNull();
    expect((await t.app.request("/", { headers: { Cookie: cookie, ...HTML } })).status).toBe(200);
  });

  it("works with the token of the page it was clicked on, on every page", async () => {
    const t = createTestApp();
    const { agent } = t.h.agents.create("scout");
    for (const path of ["/", "/agents", `/agents?inspect=${agent.id}`, "/agents/connect", "/conversations", "/log", "/log?tab=audit"]) {
      const { cookie } = await signIn(t.app, ADMIN_TOKEN);
      const page = await t.app.request(path, { headers: { Cookie: cookie, ...HTML } });
      expect(page.status, path).toBe(200);
      const html = await page.text();
      const form = /<form method="post" action="\/logout"[^>]*>(.*?)<\/form>/s.exec(html)?.[1] ?? "";
      const res = await t.app.request("/logout", formPost({ csrf: csrfInPage(form) }, { Cookie: cookie }));
      expect(res.status, path).toBe(302);
      expect(res.headers.get("location"), path).toBe("/login");
      expect(res.headers.getSetCookie().join("\n"), path).toMatch(/mesh_session=;/);
    }
  });

  it("asks instead of acting when the form token is missing, stale or somebody else's", async () => {
    clock(T0);
    const t = createTestApp();
    const { plaintextToken } = t.h.agents.create("scout");
    const mine = (await signIn(t.app, ADMIN_TOKEN)).cookie;
    const theirs = (await signIn(t.app, plaintextToken)).cookie;
    const stale = csrfFor(mine);
    clock(T0 + 9 * 60 * 60_000);
    for (const csrf of [undefined, "", stale, csrfFor(theirs)]) {
      const res = await t.app.request("/logout", formPost(csrf === undefined ? {} : { csrf }, { Cookie: mine }));
      expect(res.status).toBe(403);
      expect(cookieFrom(res, SESSION_COOKIE)).toBeNull();
      // The answer is a page with a button that does work.
      const again = await t.app.request("/logout", formPost({ csrf: csrfInPage(await res.text()) }, { Cookie: mine }));
      expect(again.status).toBe(302);
      expect(again.headers.getSetCookie().join("\n")).toMatch(/mesh_session=;/);
    }
  });

  it("needs no token when there is no session left to protect", async () => {
    const t = createTestApp();
    const res = await t.app.request("/logout", formPost({}, { Cookie: `${SESSION_COOKIE}=garbage` }));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });
});

describe("form tokens belong to a session", () => {
  it("refuses an admin action with a token from another session or from the sign-in page", async () => {
    const t = createTestApp();
    const { plaintextToken } = t.h.agents.create("scout");
    const admin = (await signIn(t.app, ADMIN_TOKEN)).cookie;
    const scout = (await signIn(t.app, plaintextToken)).cookie;
    const loginPage = csrfInPage(await (await t.app.request("/login")).text());

    for (const csrf of [csrfFor(scout), loginPage]) {
      const res = await t.app.request("/agents/create", formPost({ csrf, name: "delta" }, { Cookie: admin }));
      // The admin actions answer with the "that form expired" flash.
      expect(res.status).toBe(302);
      expect(res.headers.get("location") ?? "").toContain("/agents?flash=");
    }
    expect(t.h.agents.getByName("delta")).toBeNull();

    const ok = await t.app.request("/agents/create", formPost({ csrf: csrfFor(admin), name: "delta" }, { Cookie: admin }));
    expect(ok.status).toBe(302);
    expect(t.h.agents.getByName("delta")).not.toBeNull();
  });

  it("keeps a page's token good after the cookie was renewed under it", async () => {
    clock(T0);
    const t = createTestApp();
    const { cookie } = await signIn(t.app, ADMIN_TOKEN);
    clock(T0 + 2 * DAY);
    const page = await t.app.request("/agents", { headers: { Cookie: cookie, ...HTML } });
    const renewed = cookieFrom(page, SESSION_COOKIE)!;
    expect(renewed).not.toBe(cookie);
    const csrf = csrfInPage(await page.text());
    expect(csrf).not.toBe("");
    const res = await t.app.request("/agents/create", formPost({ csrf, name: "delta" }, { Cookie: renewed }));
    expect(res.status).toBe(302);
  });
});

describe("the sign-in form", () => {
  it("binds its token to one browser", async () => {
    const t = createTestApp();
    const mine = await t.app.request("/login");
    const theirs = await t.app.request("/login");
    const myCookie = cookieFrom(mine, LOGIN_COOKIE)!;
    const theirToken = csrfInPage(await theirs.text());
    expect(myCookie).toMatch(/^mesh_login=[A-Za-z0-9_-]{20,}$/);

    // Another SITE can fetch a sign-in page, but cannot plant its cookie in the victim's browser.
    // (A sibling host can. That one is stopped by isSameOriginPost, see further down.)
    const forged = await t.app.request("/login", formPost({ csrf: theirToken, token: ADMIN_TOKEN }, { Cookie: myCookie }));
    expect(forged.headers.get("location")).toBe("/login?error=expired");
    expect(cookieFrom(forged, SESSION_COOKIE)).toBeNull();

    const noCookie = await t.app.request("/login", formPost({ csrf: theirToken, token: ADMIN_TOKEN }));
    expect(noCookie.headers.get("location")).toBe("/login?error=expired");

    const real = await t.app.request("/login", formPost({ csrf: csrfInPage(await mine.text()), token: ADMIN_TOKEN }, { Cookie: myCookie }));
    expect(real.headers.get("location")).toBe("/");
    expect(cookieFrom(real, SESSION_COOKIE)).not.toBeNull();
  });

  it("keeps a second tab's form working: the pre-session cookie is reused, not replaced", async () => {
    const t = createTestApp();
    const first = await t.app.request("/login");
    const pre = cookieFrom(first, LOGIN_COOKIE)!;
    const second = await t.app.request("/login", { headers: { Cookie: pre } });
    expect(cookieFrom(second, LOGIN_COOKIE)).toBe(pre);
    const res = await t.app.request("/login", formPost({ csrf: csrfInPage(await first.text()), token: ADMIN_TOKEN }, { Cookie: pre }));
    expect(res.headers.get("location")).toBe("/");
  });

  it("sets the pre-session cookie HttpOnly, SameSite=Lax, for /login only, and Secure when told to", async () => {
    const line = (await createTestApp({ cookieSecure: true }).app.request("/login")).headers.getSetCookie().find((l) => l.startsWith("mesh_login=")) ?? "";
    expect(line).toMatch(/HttpOnly/i);
    expect(line).toMatch(/SameSite=Lax/i);
    expect(line).toMatch(/Path=\/login/);
    expect(line).toMatch(/;\s*Secure/i);
    expect(line).toMatch(/Max-Age=600/);
  });

  it("spends the pre-session cookie with the sign-in", async () => {
    const t = createTestApp();
    const { res } = await signIn(t.app, ADMIN_TOKEN);
    expect(res.headers.getSetCookie().join("\n")).toMatch(/mesh_login=;/);
  });
});

// ---------------------------------------------------------------------------
// From the review of this change. Each of these was a mutant that survived
// the suite, or a behaviour that was wrong.
// ---------------------------------------------------------------------------

const FRAG = { Accept: "text/x-moshi-fragment" };
const sessionLine = (res: Response) => res.headers.getSetCookie().find((l) => l.startsWith(`${SESSION_COOKIE}=`)) ?? "";

describe("signing out cannot be forced from outside", () => {
  it("clears nothing when the request brings no session cookie", async () => {
    // SameSite=Lax keeps the cookie off a cross-site POST. The handler saw no
    // session, skipped the token check, and cleared the cookie all the same:
    // any page could sign the operator out with a form.
    const t = createTestApp();
    const res = await t.app.request("/logout", formPost({}));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
    expect(sessionLine(res)).toBe("");
  });

  it("asks instead of acting when the browser says the form came from elsewhere, even with a good token", async () => {
    const t = createTestApp();
    const { cookie } = await signIn(t.app, ADMIN_TOKEN);
    const fromElsewhere: Record<string, string>[] = [
      { "Sec-Fetch-Site": "cross-site" },
      { "Sec-Fetch-Site": "same-site" },
      { Origin: "https://evil.example", Host: "moshi.example" },
      { Origin: "null", Host: "moshi.example" },
    ];
    for (const headers of fromElsewhere) {
      const res = await t.app.request("/logout", formPost({ csrf: csrfFor(cookie) }, { Cookie: cookie, ...headers }));
      expect(res.status, JSON.stringify(headers)).toBe(403);
      expect(sessionLine(res), JSON.stringify(headers)).toBe("");
    }
    const fromHere: Record<string, string>[] = [
      { "Sec-Fetch-Site": "same-origin" },
      { "Sec-Fetch-Site": "none" },
      { Origin: "https://moshi.example", Host: "moshi.example" },
      { Origin: "http://127.0.0.1:3000", Host: "127.0.0.1:3000" },
      {},
    ];
    for (const headers of fromHere) {
      const { cookie: fresh } = await signIn(t.app, ADMIN_TOKEN);
      const res = await t.app.request("/logout", formPost({ csrf: csrfFor(fresh) }, { Cookie: fresh, ...headers }));
      expect(res.status, JSON.stringify(headers)).toBe(302);
      expect(sessionLine(res), JSON.stringify(headers)).toMatch(/mesh_session=;/);
    }
  });

  it("refuses an admin action and a sign-in posted from another site the same way", async () => {
    const t = createTestApp();
    const { cookie } = await signIn(t.app, ADMIN_TOKEN);
    const create = await t.app.request("/agents/create", formPost({ csrf: csrfFor(cookie), name: "delta" }, { Cookie: cookie, "Sec-Fetch-Site": "same-site" }));
    expect(create.headers.get("location") ?? "").toContain("/agents?flash=");
    expect(t.h.agents.getByName("delta")).toBeNull();

    // A sibling host can plant its own mesh_login cookie and hold a token
    // that fits it. Its POST still says where it comes from.
    const page = await t.app.request("/login");
    const pre = cookieFrom(page, LOGIN_COOKIE)!;
    const planted = await t.app.request("/login", formPost({ csrf: csrfInPage(await page.text()), token: ADMIN_TOKEN }, { Cookie: pre, "Sec-Fetch-Site": "same-site" }));
    expect(planted.headers.get("location")).toBe("/login?error=expired");
    expect(sessionLine(planted)).toBe("");
  });
});

describe("the sign-in form, second tab", () => {
  it("lets a tab through that signs in after another tab already did", async () => {
    const t = createTestApp();
    const first = await t.app.request("/login?next=%2Flog");
    const pre = cookieFrom(first, LOGIN_COOKIE)!;
    const second = await t.app.request("/login?next=%2Flog", { headers: { Cookie: pre } });
    const one = await t.app.request("/login", formPost({ csrf: csrfInPage(await first.text()), token: ADMIN_TOKEN }, { Cookie: pre }));
    const session = cookieFrom(one, SESSION_COOKIE)!;
    // Tab two: its pre-session cookie is spent, but the browser is signed in.
    const two = await t.app.request("/login", formPost({ csrf: csrfInPage(await second.text()), token: ADMIN_TOKEN, next: "/log" }, { Cookie: session }));
    expect(two.headers.get("location")).toBe("/log");
  });

  it("says the page had expired, not that the token is wrong", async () => {
    clock(T0);
    const t = createTestApp();
    const page = await t.app.request("/login?next=%2Flog");
    const pre = cookieFrom(page, LOGIN_COOKIE)!;
    const csrf = csrfInPage(await page.text());
    clock(T0 + 10 * 60_000 + 1000);
    const late = await t.app.request("/login", formPost({ csrf, token: ADMIN_TOKEN, next: "/log" }, { Cookie: pre }));
    expect(late.headers.get("location")).toBe("/login?error=expired&next=%2Flog");
    const shown = await (await t.app.request("/login?error=expired")).text();
    expect(shown).toContain("This sign-in page had expired");
    expect(shown).not.toContain("Invalid token");

    // …and a wrong token is still a wrong token.
    const again = await t.app.request("/login");
    const wrong = await t.app.request("/login", formPost({ csrf: csrfInPage(await again.text()), token: "bt_wrong" }, { Cookie: cookieFrom(again, LOGIN_COOKIE)! }));
    expect(wrong.headers.get("location")).toBe("/login?error=1");
  });

  it("takes the pre-session value from the cookie and from nowhere else", async () => {
    const t = createTestApp();
    const a = await t.app.request("/login");
    const b = await t.app.request("/login");
    const nonceA = cookieFrom(a, LOGIN_COOKIE)!.split("=")[1];
    const res = await t.app.request("/login", formPost(
      { csrf: csrfInPage(await a.text()), token: ADMIN_TOKEN, nonce: nonceA, mesh_login: nonceA },
      { Cookie: cookieFrom(b, LOGIN_COOKIE)! },
    ));
    expect(res.headers.get("location")).toBe("/login?error=expired");
  });

  it("deletes the pre-session cookie where it was set, or the browser keeps it", async () => {
    const { res } = await signIn(createTestApp({ cookieSecure: true }).app, ADMIN_TOKEN);
    const line = res.headers.getSetCookie().find((l) => l.startsWith("mesh_login=;")) ?? "";
    expect(line).toMatch(/Max-Age=0/);
    expect(line).toMatch(/;\s*Path=\/login(;|$)/);
    expect(line).toMatch(/;\s*Secure/i);
  });
});

describe("how long a form token is good for, route by route", () => {
  it("eight hours on an admin action and on sign-out, to the second", async () => {
    clock(T0);
    const t = createTestApp();
    const { cookie } = await signIn(t.app, ADMIN_TOKEN);
    const token = csrfFor(cookie);
    const EIGHT_HOURS = 8 * 60 * 60_000;

    clock(T0 + EIGHT_HOURS - 1000);
    const inTime = await t.app.request("/agents/create", formPost({ csrf: token, name: "in-time" }, { Cookie: cookie }));
    expect(inTime.status).toBe(302);
    expect(t.h.agents.getByName("in-time")).not.toBeNull();

    clock(T0 + EIGHT_HOURS + 1000);
    await t.app.request("/agents/create", formPost({ csrf: token, name: "too-late" }, { Cookie: cookie }));
    expect(t.h.agents.getByName("too-late")).toBeNull();
    expect((await t.app.request("/logout", formPost({ csrf: token }, { Cookie: cookie }))).status).toBe(403);

    clock(T0 + EIGHT_HOURS - 1000);
    expect((await t.app.request("/logout", formPost({ csrf: token }, { Cookie: cookie }))).status).toBe(302);
  });

  it("ten minutes on the sign-in page, to the second", async () => {
    clock(T0);
    const t = createTestApp();
    const page = await t.app.request("/login");
    const pre = cookieFrom(page, LOGIN_COOKIE)!;
    const csrf = csrfInPage(await page.text());
    clock(T0 + 10 * 60_000 - 1000);
    expect((await t.app.request("/login", formPost({ csrf, token: ADMIN_TOKEN }, { Cookie: pre }))).headers.get("location")).toBe("/");
    clock(T0 + 10 * 60_000 + 1000);
    expect((await t.app.request("/login", formPost({ csrf, token: ADMIN_TOKEN }, { Cookie: pre }))).headers.get("location")).toBe("/login?error=expired");
  });
});

describe("a Bearer call and the session made from the same token share their forms", () => {
  it("accepts a cookie page's token with the Bearer, and the other way round", async () => {
    const t = createTestApp();
    const { cookie } = await signIn(t.app, ADMIN_TOKEN);
    const bearer = { Authorization: `Bearer ${ADMIN_TOKEN}` };
    // Any form of the page will do: every token of a page has the same binding.
    const tokenIn = async (headers: Record<string, string>) =>
      csrfInPage(await (await t.app.request("/agents", { headers: { ...headers, ...HTML } })).text());

    const fromCookiePage = await tokenIn({ Cookie: cookie });
    const fromBearerPage = await tokenIn(bearer);
    expect(fromCookiePage).not.toBe("");
    expect(fromBearerPage).not.toBe("");
    await t.app.request("/agents/create", formPost({ csrf: fromCookiePage, name: "via-bearer" }, bearer));
    await t.app.request("/agents/create", formPost({ csrf: fromBearerPage, name: "via-cookie" }, { Cookie: cookie }));
    expect(t.h.agents.getByName("via-bearer")).not.toBeNull();
    expect(t.h.agents.getByName("via-cookie")).not.toBeNull();
  });

  it("gives an agent's Bearer a binding of its own, which is still not the operator's", async () => {
    const t = createTestApp();
    const { plaintextToken } = t.h.agents.create("scout");
    const { cookie } = await signIn(t.app, plaintextToken);
    const res = await t.app.request("/agents/create", formPost({ csrf: csrfFor(cookie), name: "delta" }, { Authorization: `Bearer ${plaintextToken}` }));
    expect(res.status).toBe(403); // Forbidden: the role check, not the expired-form flash
    expect(t.h.agents.getByName("delta")).toBeNull();
  });
});

describe("every sign-out form on every page", () => {
  it("carries a token that works: the button and the palette entry", async () => {
    const t = createTestApp();
    for (const path of ["/", "/agents", "/agents/connect", "/conversations", "/log", "/log?tab=audit"]) {
      const { cookie } = await signIn(t.app, ADMIN_TOKEN);
      const html = await (await t.app.request(path, { headers: { Cookie: cookie, ...HTML } })).text();
      const forms = [...html.matchAll(/<form method="post" action="\/logout"[^>]*>(.*?)<\/form>/gs)].map((m) => m[1]);
      expect(forms.length, path).toBe(2);
      for (const form of forms) {
        const { cookie: fresh } = await signIn(t.app, ADMIN_TOKEN);
        const csrf = csrfInPage(form);
        expect(csrf, path).not.toBe("");
        // Tokens are per session, not per cookie: the page's token fits the fresh cookie of the same operator.
        const res = await t.app.request("/logout", formPost({ csrf }, { Cookie: fresh }));
        expect(res.status, path).toBe(302);
      }
    }
  });
});

describe("what else ends with the token, and what does not renew", () => {
  it("ends the fragments and the event stream too, after a reset, a revoke and a delete", async () => {
    for (const end of ["reset", "revoke", "delete"] as const) {
      const t = createTestApp();
      const { agent, plaintextToken } = t.h.agents.create("scout");
      const { cookie } = await signIn(t.app, plaintextToken);
      if (end === "reset") t.h.agents.resetToken(agent.id, "admin");
      if (end === "revoke") t.h.agents.revokeById(agent.id, "admin");
      if (end === "delete") t.h.agents.deleteById(agent.id, "admin");
      expect((await t.app.request("/fragments/home/latest", { headers: { Cookie: cookie, ...FRAG } })).status, end).toBe(401);
      const sse = await t.app.request("/sse/messages", { headers: { Cookie: cookie, Accept: "text/event-stream" } });
      expect(sse.status, end).toBe(401);
      await sse.body?.cancel();
    }
  });

  it("is not renewed by the event stream", async () => {
    clock(T0);
    const t = createTestApp();
    const { cookie } = await signIn(t.app, ADMIN_TOKEN);
    clock(T0 + 6 * DAY);
    const res = await t.app.request("/sse/messages", { headers: { Cookie: cookie, Accept: "text/event-stream" } });
    expect(res.status).toBe(200);
    expect(sessionLine(res)).toBe("");
    await res.body?.cancel();
  });

  it("renews without Secure on a plain-http host", async () => {
    clock(T0);
    const t = createTestApp({ cookieSecure: false });
    const { cookie } = await signIn(t.app, ADMIN_TOKEN);
    clock(T0 + 2 * DAY);
    const line = sessionLine(await t.app.request("/", { headers: { Cookie: cookie, ...HTML } }));
    expect(line).not.toBe("");
    expect(line).not.toMatch(/;\s*Secure/i);
  });

  it("does not promise a renewed cookie more time than the session has left", async () => {
    clock(T0);
    const t = createTestApp();
    let { cookie } = await signIn(t.app, ADMIN_TOKEN);
    for (const day of [6, 12, 18, 24]) {
      clock(T0 + day * DAY);
      cookie = cookieFrom(await t.app.request("/", { headers: { Cookie: cookie, ...HTML } }), SESSION_COOKIE) ?? cookie;
    }
    clock(T0 + 29.5 * DAY);
    const line = sessionLine(await t.app.request("/", { headers: { Cookie: cookie, ...HTML } }));
    expect(line).toMatch(/Max-Age=43200(;|$)/); // twelve hours, not seven days
  });

  it("keeps a session made WITH the previous admin token tied to that token, renewed or not", async () => {
    clock(T0);
    const OLD = ADMIN_TOKEN;
    const NEW = "n".repeat(40);
    const during = createTestApp({ meshAdminToken: NEW, meshAdminTokenPrevious: OLD });
    const { cookie, res } = await signIn(during.app, OLD);
    expect(res.headers.get("location")).toBe("/");
    clock(T0 + 2 * DAY);
    const renewed = cookieFrom(await during.app.request("/", { headers: { Cookie: cookie, ...HTML } }), SESSION_COOKIE)!;
    expect(renewed).not.toBeNull();
    const after = createTestApp({ meshAdminToken: NEW });
    expect((await after.app.request("/", { headers: { Cookie: cookie } })).status).toBe(401);
    expect((await after.app.request("/", { headers: { Cookie: renewed } })).status).toBe(401);
  });

  it("answers /mcp with 401 when a good cookie comes with a bad Bearer", async () => {
    const t = createTestApp();
    const { plaintextToken } = t.h.agents.create("scout");
    const { cookie } = await signIn(t.app, plaintextToken);
    const res = await t.app.request("/mcp", { method: "POST", headers: { ...MCP_HEADERS, Cookie: cookie, Authorization: "Bearer bt_wrong" }, body: rpc("tools/list", {}) });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("oauth-protected-resource");
  });

  it("writes one sign-in row for an agent, whatever it is called by the time it comes back", async () => {
    const t = createTestApp();
    const { agent, plaintextToken } = t.h.agents.create("walker");
    const { cookie } = await signIn(t.app, plaintextToken);
    const rows = () => (t.h.db.prepare("SELECT COUNT(*) AS n FROM activity_log WHERE action = 'auth_login' AND agent_name IN ('walker', 'walker-eu')").get() as { n: number }).n;
    await t.app.request("/", { headers: { Cookie: cookie, ...HTML } });
    await new Promise((r) => setTimeout(r, 20));
    const before = rows();
    expect(before).toBe(1);
    t.h.agents.rename(agent.id, "walker-eu", "admin");
    await t.app.request("/", { headers: { Cookie: cookie, ...HTML } });
    await new Promise((r) => setTimeout(r, 20));
    expect(rows()).toBe(before);
  });
});

describe("production mode served over plain http", () => {
  // The browser drops a Secure cookie that arrives over http. The session
  // cookie went that way before (sign-in looped without a word); now the
  // pre-session cookie goes first, and every attempt ends on "expired".
  it("says what to do, on the page, when the server can tell that its cookie will not be kept", async () => {
    const t = createTestApp({ cookieSecure: true });
    const page = await t.app.request("/login");
    const posted = await t.app.request("/login", formPost({ csrf: csrfInPage(await page.text()), token: ADMIN_TOKEN })); // no cookie came back
    expect(posted.headers.get("location")).toBe("/login?error=expired");
    const shown = await (await t.app.request("/login?error=expired")).text();
    expect(shown).toContain("This sign-in page had expired");
    expect(shown).toContain("MESH_COOKIE_SECURE=0");
  });

  it("keeps that hint off the page behind TLS, and wherever the cookie is not Secure", async () => {
    const behindTls = await (await createTestApp({ cookieSecure: true }).app.request("/login?error=expired", { headers: { "X-Forwarded-Proto": "https" } })).text();
    expect(behindTls).toContain("This sign-in page had expired");
    expect(behindTls).not.toContain("MESH_COOKIE_SECURE");
    const plain = await (await createTestApp({ cookieSecure: false }).app.request("/login?error=expired")).text();
    expect(plain).not.toContain("MESH_COOKIE_SECURE");
    const noError = await (await createTestApp({ cookieSecure: true }).app.request("/login")).text();
    expect(noError).not.toContain("MESH_COOKIE_SECURE");
  });
});

describe("admin token rotation can be switched on", () => {
  it("reaches the container: docker-compose.yml passes MESH_ADMIN_TOKEN_PREVIOUS, and empty means none", async () => {
    const { readFileSync } = await import("fs");
    expect(readFileSync("docker-compose.yml", "utf-8")).toMatch(/- MESH_ADMIN_TOKEN_PREVIOUS=\$\{MESH_ADMIN_TOKEN_PREVIOUS:-\}/);
    // What the container then sees when the operator has set nothing: "".
    const t = createTestApp({ meshAdminTokenPrevious: "" });
    expect((await t.app.request("/", { headers: { Authorization: "Bearer " } })).status).toBe(401);
    const { cookie } = await signIn(t.app, ADMIN_TOKEN);
    expect((await t.app.request("/", { headers: { Cookie: cookie, ...HTML } })).status).toBe(200);
    const { res } = await signIn(t.app, "");
    expect(res.headers.get("location")).toBe("/login?error=1");
  });
});

describe("a body that cannot be parsed", () => {
  const garbage = (cookie: string): RequestInit => ({
    method: "POST", body: "garbage", headers: { "Content-Type": "multipart/form-data", Cookie: cookie },
  });

  it("is a missing form token on /logout, not an HTTP 500", async () => {
    const t = createTestApp();
    const { cookie } = await signIn(t.app, ADMIN_TOKEN);
    const res = await t.app.request("/logout", garbage(cookie));
    expect(res.status).toBe(403);
    expect(sessionLine(res)).toBe("");
  });

  it("is a rejected form on /login, not an HTTP 500", async () => {
    const t = createTestApp();
    const page = await t.app.request("/login");
    const res = await t.app.request("/login", garbage(cookieFrom(page, LOGIN_COOKIE)!));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login?error=expired");
  });
});
