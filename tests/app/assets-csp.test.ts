// Fonts from this origin, a Content-Security-Policy on every answer, HSTS in
// production. Until now every page, the sign-in page included, fetched its
// fonts from Google before anybody had signed in, and there was no CSP at all.

import { describe, it, expect, vi, afterEach } from "vitest";
import crypto from "node:crypto";
import { readFileSync, readdirSync } from "fs";
import { createTestApp, signIn, csrfFor, formPost, ADMIN_TOKEN } from "./harness";
import { FONT_FACE_CSS, FONT_FILES } from "../../src/views/fonts";
import { createCspReportRoute } from "../../src/routes/csp-report";
import { handoffTarget } from "../helpers/handoff";

afterEach(() => { vi.restoreAllMocks(); });

const HTML = { Accept: "text/html" };
const VERIFIER = "v".repeat(64);
const CHALLENGE = crypto.createHash("sha256").update(VERIFIER).digest("base64url");
const CONSENT = `/oauth/authorize?redirect_uri=${encodeURIComponent("http://localhost:9911/callback")}&state=s&code_challenge=${CHALLENGE}&code_challenge_method=S256`;

async function pages() {
  const t = createTestApp();
  const { agent } = t.h.agents.create("scout");
  const { cookie } = await signIn(t.app, ADMIN_TOKEN);
  const paths = ["/login", "/login?error=1", "/login?error=expired", CONSENT, "/", "/agents", `/agents?inspect=${agent.id}`, "/agents/connect", "/conversations", "/log", "/log?tab=audit"];
  const out: { path: string; res: Response; html: string }[] = [];
  for (const path of paths) {
    const res = await t.app.request(path, { headers: { Cookie: cookie, ...HTML } });
    out.push({ path, res, html: await res.text() });
  }
  // The connect flow WITH a session: steps 2 and 4 bring a script of their own
  // (the copy gate, the poll), and only with a session are they rendered.
  const created = await t.app.request("/agents/connect/create", formPost({ csrf: csrfFor(cookie), name: "newcomer" }, { Cookie: cookie }));
  const step2 = created.headers.get("location") ?? "";
  const key = new URL(step2, "http://x").searchParams.get("s") ?? "";
  for (const step of [2, 3, 4]) {
    const path = `/agents/connect?step=${step}&s=${key}`;
    const res = await t.app.request(path, { headers: { Cookie: cookie, ...HTML } });
    out.push({ path: `connect step ${step}`, res, html: await res.text() });
  }
  // Step 1 again, with an error: rendered by another code path.
  const refused = await t.app.request("/agents/connect/create", formPost({ csrf: csrfFor(cookie), name: "admin" }, { Cookie: cookie }));
  out.push({ path: "connect step 1 (400)", res: refused, html: await refused.text() });
  // The "Sign out?" page is a page too.
  const signout = await t.app.request("/logout", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" }, body: "" });
  out.push({ path: "POST /logout (403)", res: signout, html: await signout.text() });
  // And so is what answers the consent form: the page that hands the browser on.
  const handoff = await t.app.request("/oauth/authorize", formPost({ redirect_uri: "http://localhost:9911/callback", state: "s", code_challenge: CHALLENGE, code_challenge_method: "S256", token: t.h.agents.create("connector").plaintextToken }));
  out.push({ path: "POST /oauth/authorize (hand-off)", res: handoff, html: await handoff.text() });
  return { t, out, step2Key: key };
}

describe("fonts", () => {
  it("come from this origin on every page: no request to Google before or after the sign-in", async () => {
    const { out } = await pages();
    for (const { path, res, html } of out) {
      expect([200, 400, 401, 403], path).toContain(res.status);
      expect(html, path).not.toMatch(/fonts\.googleapis\.com|fonts\.gstatic\.com/);
      if (path.includes("hand-off")) continue; // one sentence and a link, in the system font
      expect(html, path).toContain("@font-face");
      expect(html, path).toMatch(/url\(\/fonts\/sora-latin\.[0-9a-f]{10}\.woff2\)/);
    }
  });

  it("are files, not data: no base64 in the stylesheet, and every file named exists", () => {
    expect(FONT_FACE_CSS).not.toMatch(/data:|base64/);
    const named = [...FONT_FACE_CSS.matchAll(/url\(\/fonts\/([^)]+)\)/g)].map((m) => m[1]).sort();
    const onDisk = readdirSync("public/fonts").filter((f) => f.endsWith(".woff2")).sort();
    expect(named).toEqual(onDisk);
    expect([...FONT_FILES].sort()).toEqual(onDisk);
    // Variable fonts: one file per subset carries every weight the pages use.
    expect(FONT_FACE_CSS).toMatch(/font-weight:\s*100 800/);
    expect(FONT_FACE_CSS).toMatch(/font-display:\s*swap/);
  });

  it("are named after their bytes: they are cached immutable for a year, so changed bytes need a new name", () => {
    for (const name of FONT_FILES) {
      const hex = crypto.createHash("sha256").update(readFileSync(`public/fonts/${name}`)).digest("hex").slice(0, 10);
      expect(name).toContain(`.${hex}.woff2`);
    }
  });

  it("carry their licence: both families are OFL, and the text travels with the files", () => {
    for (const f of ["OFL-sora.txt", "OFL-jetbrainsmono.txt"]) expect(readFileSync(`public/fonts/${f}`, "utf-8")).toContain("SIL OPEN FONT LICENSE");
  });

  it("are served to anybody, for a year, as what they are", async () => {
    const { t } = await pages();
    const file = FONT_FILES[0];
    const res = await t.app.request(`/fonts/${file}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("font/woff2");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await res.arrayBuffer()).equals(readFileSync(`public/fonts/${file}`))).toBe(true);
    const licence = await t.app.request("/fonts/OFL-sora.txt");
    expect(licence.status).toBe(200);
    expect(licence.headers.get("content-type")).toMatch(/^text\/plain/);
  });

  it("serve nothing else from that directory, and nothing from outside it", async () => {
    const { t } = await pages();
    for (const bad of ["/fonts/", "/fonts/nope.woff2", "/fonts/..%2f..%2fpackage.json", "/fonts/%2e%2e/package.json", "/fonts/.gitkeep", "/fonts/sora-latin.woff2", "/fonts/constructor"]) {
      const res = await t.app.request(bad);
      // 404 from the font route, or 401 where the router resolved the dots and the path is no font path any more.
      expect([404, 401], bad).toContain(res.status);
      expect(res.headers.get("content-type") ?? "", bad).not.toMatch(/font|octet/);
    }
  });

  it("are not named anywhere in the sources by their old home", () => {
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`]));
    for (const file of walk("src")) expect(readFileSync(file, "utf-8"), file).not.toMatch(/googleapis|gstatic/);
  });
});

describe("Content-Security-Policy", () => {
  const policyOf = (res: Response) => res.headers.get("content-security-policy") ?? res.headers.get("content-security-policy-report-only") ?? "";
  const nonceOf = (res: Response) => /'nonce-([A-Za-z0-9+/=]+)'/.exec(policyOf(res))?.[1] ?? "";

  // The whole header, not pieces of it: `toContain("connect-src 'self'")` is
  // just as happy with "connect-src 'self' https:".
  const PAGE_POLICY =
    "default-src 'none'; script-src 'nonce-NONCE' 'report-sample'; style-src 'unsafe-inline'; img-src 'self' data:; font-src 'self'; " +
    "connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; report-uri /csp-report";

  it("is on every page, and is exactly this, the consent page and its answer included", async () => {
    const { out } = await pages();
    for (const { path, res } of out) {
      const nonce = nonceOf(res);
      expect(policyOf(res).replace(nonce, "NONCE"), path).toBe(PAGE_POLICY);
    }
  });

  it("gives every inline script of a page THAT response's nonce, and no page an inline handler", async () => {
    const { out } = await pages();
    const nonces = new Set<string>();
    let scripts = 0;
    for (const { path, res, html } of out) {
      const nonce = nonceOf(res);
      expect(nonce.length, path).toBeGreaterThanOrEqual(22);
      nonces.add(nonce);
      for (const tag of html.match(/<script\b[^>]*>/g) ?? []) {
        scripts++;
        expect(tag, path).toBe(`<script nonce="${nonce}">`);
      }
      expect(html, path).not.toMatch(/<[^>]+\son[a-z]+\s*=/i);
      expect(html, path).not.toMatch(/javascript:/i);
    }
    expect(nonces.size).toBe(out.length); // never the same twice
    expect(scripts).toBeGreaterThan(10);  // the layout alone brings three
    // The two scripts that only a connect session renders are among them.
    const html = (name: string) => out.find((p) => p.path === name)!.html;
    expect(html("connect step 2")).toContain("Copy it first");
    expect((html("connect step 2").match(/<script\b/g) ?? []).length).toBeGreaterThan((html("connect step 3").match(/<script\b/g) ?? []).length);
    expect(html("connect step 4")).toContain("/agents/connect/handshake");
  });

  it("never gives a page another response's nonce, however many are rendered at once", async () => {
    // The nonce travels through a render context. If that were one shared slot,
    // two pages rendered at the same moment could swap nonces, and under an
    // enforced policy a page with the wrong nonce is a dead page.
    const t = createTestApp();
    const { agent } = t.h.agents.create("scout");
    const { cookie } = await signIn(t.app, ADMIN_TOKEN);
    const paths = ["/", "/agents", `/agents?inspect=${agent.id}`, "/agents/connect", "/conversations", "/log", "/log?tab=audit", "/login"];
    const answers = await Promise.all(Array.from({ length: 160 }, (_, i) => t.app.request(paths[i % paths.length], { headers: { Cookie: cookie, ...HTML } })));
    const seen = new Set<string>();
    for (const res of answers) {
      const nonce = nonceOf(res);
      expect(seen.has(nonce)).toBe(false);
      seen.add(nonce);
      const tags = (await res.text()).match(/<script\b[^>]*>/g) ?? [];
      for (const tag of tags) expect(tag).toBe(`<script nonce="${nonce}">`);
    }
    expect(seen.size).toBe(160);
  });

  it("reports before it enforces, and enforces when told to", async () => {
    const reporting = await createTestApp().app.request("/login");
    expect(reporting.headers.get("content-security-policy-report-only")).toContain("default-src 'none'");
    expect(reporting.headers.get("content-security-policy")).toBeNull();
    const enforcing = await createTestApp({ cspMode: "enforce" }).app.request("/login");
    expect(enforcing.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(enforcing.headers.get("content-security-policy-report-only")).toBeNull();
    const off = await createTestApp({ cspMode: "off" }).app.request("/login");
    expect(off.headers.get("content-security-policy")).toBeNull();
    expect(off.headers.get("content-security-policy-report-only")).toBeNull();
  });

  it("never writes anything of a request into the policy: a redirect_uri whose host carries ';' used to inject directives", async () => {
    const t = createTestApp();
    const hostile = "http://a;sandbox;b.localhost:9911/cb";
    const consent = await t.app.request(CONSENT.replace(encodeURIComponent("http://localhost:9911/callback"), encodeURIComponent(hostile)));
    expect(consent.status).toBe(200);
    expect(policyOf(consent).replace(nonceOf(consent), "NONCE")).toBe(PAGE_POLICY);
    const hosted = await t.app.request(CONSENT.replace(encodeURIComponent("http://localhost:9911/callback"), encodeURIComponent("https://claude.ai/api/mcp/auth_callback")));
    expect(policyOf(hosted).replace(nonceOf(hosted), "NONCE")).toBe(PAGE_POLICY);
  });

  it("answers the consent form with a page, so that a client that redirects on is nobody's form-action business", async () => {
    const t = createTestApp({ cspMode: "enforce" });
    const { plaintextToken } = t.h.agents.create("scout");
    const res = await t.app.request("/oauth/authorize", formPost({ redirect_uri: "http://[::1]:9911/callback", state: "s", code_challenge: CHALLENGE, code_challenge_method: "S256", token: plaintextToken }));
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-security-policy")).toContain("form-action 'self';");
    expect(new URL(await handoffTarget(res)).host).toBe("[::1]:9911");
  });

  it("locks answers that are not pages down completely", async () => {
    const t = createTestApp();
    for (const path of ["/health", "/livez", "/cli/version", "/nope"]) {
      expect(policyOf(await t.app.request(path)), path).toBe("default-src 'none'; frame-ancestors 'none'");
    }
  });

  it("is on the answers of the body limits too: they sit in front of everything else", async () => {
    const t = createTestApp({ isProduction: true, cookieSecure: true });
    for (const path of ["/login", "/logout", "/oauth/authorize", "/oauth/token"]) {
      const res = await t.app.request(path, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "x=" + "a".repeat(40_000) });
      expect(res.status, path).toBe(413);
      expect(policyOf(res), path).toBe("default-src 'none'; frame-ancestors 'none'");
      expect(res.headers.get("x-content-type-options"), path).toBe("nosniff");
      expect(res.headers.get("strict-transport-security"), path).toBe("max-age=31536000; includeSubDomains");
    }
  });
});

describe("Strict-Transport-Security", () => {
  it("is sent where the deployment is served over TLS, for a year, with subdomains, never with preload", async () => {
    const tls = await createTestApp({ isProduction: true, cookieSecure: true }).app.request("/login");
    expect(tls.headers.get("strict-transport-security")).toBe("max-age=31536000; includeSubDomains");
  });

  it("is not sent in development, nor on a production host that is served over plain http", async () => {
    expect((await createTestApp().app.request("/login")).headers.get("strict-transport-security")).toBeNull();
    const plain = await createTestApp({ isProduction: true, cookieSecure: false }).app.request("/login");
    expect(plain.headers.get("strict-transport-security")).toBeNull();
    // A development host behind a local https proxy: includeSubDomains would
    // pin localhost and everything under it to https for a year.
    const devTls = await createTestApp({ isProduction: false, cookieSecure: true }).app.request("/login");
    expect(devTls.headers.get("strict-transport-security")).toBeNull();
  });
});

describe("POST /csp-report", () => {
  const report = (body: unknown, type = "application/csp-report"): RequestInit => ({ method: "POST", headers: { "Content-Type": type }, body: typeof body === "string" ? body : JSON.stringify(body) });
  function capture() {
    const lines: Record<string, unknown>[] = [];
    vi.spyOn(console, "log").mockImplementation((l) => { try { lines.push(JSON.parse(String(l))); } catch { /* not ours */ } });
    return lines;
  }

  it("takes a browser's report without a session and writes one bounded line", async () => {
    const lines = capture();
    const t = createTestApp();
    const res = await t.app.request("/csp-report", report({ "csp-report": {
      "document-uri": "https://moshi.example/agents?flash=abc&next=%2Flog", "violated-directive": "script-src-elem", "effective-directive": "script-src-elem",
      "blocked-uri": "https://evil.example/x.js?token=bt_" + "s".repeat(40), "line-number": 12, "source-file": "https://moshi.example/agents?flash=abc", "disposition": "report" } }));
    expect(res.status).toBe(204);
    const line = lines.find((l) => l.msg === "csp violation")!;
    expect(line).toMatchObject({ lvl: "warn", document: "/agents", directive: "script-src-elem", blocked: "https://evil.example/x.js", line: 12, disposition: "report" });
    expect(JSON.stringify(lines)).not.toContain("bt_");
    expect(JSON.stringify(lines)).not.toContain("flash=");
  });

  it("understands the Reporting API shape too", async () => {
    const lines = capture();
    const res = await createTestApp().app.request("/csp-report", report([{ type: "csp-violation", url: "https://moshi.example/log", body: { documentURL: "https://moshi.example/log", effectiveDirective: "style-src-elem", blockedURL: "inline", lineNumber: 3, disposition: "enforce" } }], "application/reports+json"));
    expect(res.status).toBe(204);
    expect(lines.find((l) => l.msg === "csp violation")).toMatchObject({ document: "/log", directive: "style-src-elem", blocked: "inline", disposition: "enforce" });
  });

  it("answers 204 to anything else and logs nothing: garbage, huge fields, a flood", async () => {
    const lines = capture();
    const t = createTestApp();
    for (const body of ["{not json", "null", "[]", JSON.stringify({ "csp-report": "x" }), JSON.stringify({ "csp-report": { "violated-directive": 7 } })]) {
      expect((await t.app.request("/csp-report", report(body))).status).toBe(204);
    }
    expect(lines.filter((l) => l.msg === "csp violation")).toHaveLength(0);
    const big = await t.app.request("/csp-report", report({ "csp-report": { "document-uri": "https://x/" + "a".repeat(2000), "violated-directive": "d".repeat(2000), "blocked-uri": "b".repeat(2000) } }));
    expect(big.status).toBe(204);
    const line = lines.find((l) => l.msg === "csp violation")!;
    for (const v of Object.values(line)) expect(String(v).length).toBeLessThanOrEqual(300);
    // A page with one broken rule reports on every load: a minute's worth of lines is enough.
    for (let i = 0; i < 200; i++) await t.app.request("/csp-report", report({ "csp-report": { "document-uri": "https://x/log", "violated-directive": "script-src", "blocked-uri": "inline" } }));
    expect(lines.filter((l) => l.msg === "csp violation").length).toBeLessThanOrEqual(61);
  });

  it("says what it could tell an own script from an injected one by: the first characters of the script, and its file", async () => {
    const lines = capture();
    await createTestApp().app.request("/csp-report", report({ "csp-report": {
      "document-uri": "https://moshi.example/", "effective-directive": "script-src-elem", "blocked-uri": "inline", "line-number": 2,
      "script-sample": "window.__cfRLUnblockHandlers = 1;" + "x".repeat(500), "source-file": "https://moshi.example/cdn-cgi/challenge-platform/scripts/x.js?ray=abc" } }));
    const line = lines.find((l) => l.msg === "csp violation")!;
    expect(line.sample).toBe(("window.__cfRLUnblockHandlers = 1;" + "x".repeat(500)).slice(0, 80));
    expect(line.source).toBe("https://moshi.example/cdn-cgi/challenge-platform/scripts/x.js");
  });

  it("opens again after a minute, and says how many reports it left out: sixty junk posts must not hide the real one in silence", async () => {
    const lines = capture();
    let t = 1_800_000_000_000;
    const route = createCspReportRoute(() => t);
    const post = () => route.request("/csp-report", report({ "csp-report": { "document-uri": "https://x/log", "violated-directive": "img-src", "blocked-uri": "https://x/y.png" } }));
    for (let i = 0; i < 100; i++) await post();
    expect(lines.filter((l) => l.msg === "csp violation")).toHaveLength(60);
    expect(lines.filter((l) => l.msg === "csp violations not logged")).toHaveLength(0);
    t += 60_000;
    await post();
    expect(lines.filter((l) => l.msg === "csp violation")).toHaveLength(61);
    expect(lines.filter((l) => l.msg === "csp violations not logged")).toEqual([expect.objectContaining({ lvl: "warn", count: 40 })]);
    // A clock that steps back does not keep it shut for the length of the step.
    for (let i = 0; i < 100; i++) await post();
    t -= 3_600_000;
    await post();
    expect(lines.filter((l) => l.msg === "csp violation")).toHaveLength(61 + 59 + 1);
  });

  it("refuses a body that is too large before reading it, and every other method", async () => {
    const t = createTestApp();
    expect((await t.app.request("/csp-report", report("x".repeat(20_000)))).status).toBe(413);
    expect((await t.app.request("/csp-report")).status).toBe(405);
  });
});
