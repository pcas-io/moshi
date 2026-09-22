// Route tests for the OAuth endpoints. They are public (no auth in front),
// so every unguarded field is an unauthenticated 500 with a stack trace.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import { Hono } from "hono";
import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "fs";
import type { AppVariables, Env } from "../../src/types";
import { AgentService } from "../../src/services/agent";
import { ActivityService } from "../../src/services/activity";
import { createOAuthRoutes } from "../../src/oauth";
import { handoffTarget, handoffTargetIn } from "../helpers/handoff";

const ADMIN_TOKEN = "a".repeat(40);
const REDIRECT = "http://localhost:9911/callback";
const VERIFIER = "v".repeat(64);
const CHALLENGE = crypto.createHash("sha256").update(VERIFIER).digest("base64url");

let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = { a: process.env.MESH_ADMIN_TOKEN, p: process.env.MESH_ADMIN_TOKEN_PREVIOUS, o: process.env.OAUTH_SECRET };
  process.env.MESH_ADMIN_TOKEN = ADMIN_TOKEN;
  delete process.env.MESH_ADMIN_TOKEN_PREVIOUS;
  process.env.OAUTH_SECRET = "o".repeat(40);
});
afterEach(() => {
  for (const [k, v] of [["MESH_ADMIN_TOKEN", saved.a], ["MESH_ADMIN_TOKEN_PREVIOUS", saved.p], ["OAUTH_SECRET", saved.o]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

function setup() {
  const db = new Database(":memory:");
  for (const f of readdirSync("migrations").filter((x) => x.endsWith(".sql")).sort()) db.exec(readFileSync(`migrations/${f}`, "utf-8"));
  const agents = new AgentService(db, new ActivityService(db));
  const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
  app.route("/", createOAuthRoutes(agents, db));
  return { app, agents, db };
}

const authorize = (fields: Record<string, string>): RequestInit => ({
  method: "POST",
  body: new URLSearchParams({ redirect_uri: REDIRECT, state: "s1", code_challenge: CHALLENGE, code_challenge_method: "S256", ...fields }),
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
});

describe("POST /oauth/authorize", () => {
  it("re-renders the form when the token field is missing, instead of a 500", async () => {
    const { app } = setup();
    const res = await app.request("/oauth/authorize", authorize({}));
    expect(res.status).toBe(401);
    expect(await res.text()).toContain("Invalid token");
  });

  it("refuses the admin token, as its own hint has always claimed", async () => {
    const { app, db } = setup();
    const res = await app.request("/oauth/authorize", authorize({ token: ADMIN_TOKEN }));
    expect(res.status).toBe(401);
    const html = await res.text();
    expect(html).toContain("admin token");
    expect(html).toContain("/agents/connect");
    // Nothing was stored: the operator credential must not reach a connector.
    expect(db.prepare("SELECT COUNT(*) AS n FROM oauth_codes").get()).toEqual({ n: 0 });
  });

  it("echoes state exactly as the client sent it", async () => {
    // state is an opaque protocol value (RFC 6749 allows spaces). The client
    // compares it byte for byte, so it is never trimmed like a typed field.
    const { app, agents } = setup();
    const { plaintextToken } = agents.create("scout");
    const res = await app.request("/oauth/authorize", authorize({ token: plaintextToken, state: "  padded state  " }));
    expect(new URL(await handoffTarget(res)).searchParams.get("state")).toBe("  padded state  ");
  });

  it("still forgives whitespace around a pasted token", async () => {
    const { app, agents } = setup();
    const { plaintextToken } = agents.create("scout");
    const res = await app.request("/oauth/authorize", authorize({ token: `  ${plaintextToken}\n` }));
    expect(await handoffTarget(res)).toContain("code=");
  });

  it("still issues a code for an agent token", async () => {
    const { app, agents } = setup();
    const { plaintextToken } = agents.create("scout");
    const res = await app.request("/oauth/authorize", authorize({ token: plaintextToken }));
    expect(await handoffTarget(res)).toContain("code=");
  });
});

// Chrome applies form-action to EVERY redirect that follows a form post, so a
// client that redirects on from its callback stranded the browser on the
// consent page, and the client's origin had to be written into the policy
// (where ';' in a host name injected directives). The form is answered with a
// page now: what follows is a new navigation and no form's.
describe("POST /oauth/authorize hands the browser on with a page", () => {
  it("answers 200 without a Location, with a refresh and a link to the same place", async () => {
    const { app, agents } = setup();
    const { plaintextToken } = agents.create("scout");
    const res = await app.request("/oauth/authorize", authorize({ token: plaintextToken, state: 'a&b"c<d' }));
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    const target = handoffTargetIn(html);
    const url = new URL(target);
    expect(`${url.origin}${url.pathname}`).toBe(REDIRECT);
    expect(url.searchParams.get("state")).toBe('a&b"c<d');
    expect(url.searchParams.get("code")).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    // The same place for somebody whose browser does not follow a refresh.
    const link = /<a [^>]*href="([^"]*)"[^>]*>Continue<\/a>/.exec(html)?.[1] ?? "";
    expect(link.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&lt;/g, "<")).toBe(target);
    // Nothing of the state gets out of its attribute.
    expect(html).not.toContain('a&b"c<d');
    expect(html).not.toMatch(/<script/i);
  });

  it("keeps a redirect_uri's own query, and works for an IPv6 loopback client", async () => {
    const { app, agents } = setup();
    const { plaintextToken } = agents.create("scout");
    const res = await app.request("/oauth/authorize", authorize({ token: plaintextToken, redirect_uri: "http://[::1]:9911/cb?client=x" }));
    const url = new URL(await handoffTarget(res));
    expect(url.host).toBe("[::1]:9911");
    expect(url.searchParams.get("client")).toBe("x");
    expect(url.searchParams.get("code")).toBeTruthy();
  });
});

describe("POST /oauth/token — malformed bodies", () => {
  const json = (body: string): RequestInit => ({ method: "POST", body, headers: { "Content-Type": "application/json" } });

  it("answers 400 invalid_request for a body that is not JSON", async () => {
    const res = await setup().app.request("/oauth/token", json("{not json"));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_request" });
  });

  it("answers 400 for null, and for fields of the wrong type", async () => {
    const { app } = setup();
    for (const body of ["null", JSON.stringify({ grant_type: "authorization_code", code: 12345, code_verifier: VERIFIER }),
      JSON.stringify({ grant_type: "authorization_code", code: "1.x:y", code_verifier: { a: 1 } })]) {
      const res = await app.request("/oauth/token", json(body));
      expect(res.status, body).toBe(400);
    }
  });

  it("still completes a correct exchange", async () => {
    const { app, agents } = setup();
    const { plaintextToken } = agents.create("scout");
    const auth = await app.request("/oauth/authorize", authorize({ token: plaintextToken }));
    const code = new URL(await handoffTarget(auth)).searchParams.get("code")!;
    const res = await app.request("/oauth/token", json(JSON.stringify({ grant_type: "authorization_code", code, code_verifier: VERIFIER })));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ access_token: plaintextToken, token_type: "Bearer" });
  });

  // What real connectors send: the MCP SDK posts the exchange form-encoded,
  // with client_id, redirect_uri and resource next to the three fields read.
  it("completes the exchange in the shape the MCP SDK sends it", async () => {
    const { app, agents } = setup();
    const { plaintextToken } = agents.create("scout");
    const exchange = async (contentType: string, body: (code: string) => URLSearchParams | string) => {
      const auth = await app.request("/oauth/authorize", authorize({ token: plaintextToken }));
      const code = new URL(await handoffTarget(auth)).searchParams.get("code")!;
      return app.request("/oauth/token", { method: "POST", body: body(code), headers: { "Content-Type": contentType } });
    };
    const fields = (code: string) => ({
      grant_type: "authorization_code", code, code_verifier: VERIFIER,
      client_id: "client-1", redirect_uri: REDIRECT, resource: "https://moshi.example/mcp",
    });

    for (const [contentType, body] of [
      ["application/x-www-form-urlencoded", (code: string) => new URLSearchParams(fields(code))],
      ["application/x-www-form-urlencoded;charset=UTF-8", (code: string) => new URLSearchParams(fields(code))],
      ["application/json; charset=utf-8", (code: string) => JSON.stringify(fields(code))],
    ] as const) {
      const res = await exchange(contentType, body);
      expect(res.status, contentType).toBe(200);
      expect(await res.json(), contentType).toMatchObject({ access_token: plaintextToken, token_type: "Bearer" });
    }
  });
});

// The code used to be `timestamp.signature:challenge`, and the token endpoint
// verified PKCE against the challenge THE CLIENT sent back. Whoever saw a code
// could put their own challenge behind the colon and redeem it.
describe("the authorization code is bound to its challenge on the server", () => {
  const form = (fields: Record<string, string>): RequestInit => ({
    method: "POST",
    body: new URLSearchParams({ grant_type: "authorization_code", ...fields }),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  const THEIR_VERIFIER = "x".repeat(64);
  const THEIR_CHALLENGE = crypto.createHash("sha256").update(THEIR_VERIFIER).digest("base64url");

  async function authorized() {
    const t = setup();
    const { plaintextToken } = t.agents.create("scout");
    const res = await t.app.request("/oauth/authorize", authorize({ token: plaintextToken }));
    const code = new URL(await handoffTarget(res)).searchParams.get("code")!;
    return { ...t, plaintextToken, code };
  }

  it("redirects with an opaque code: no challenge in it, no timestamp, no token", async () => {
    const { code, plaintextToken } = await authorized();
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(code).not.toContain(CHALLENGE);
    expect(code).not.toContain(plaintextToken);
  });

  it("keeps the token out of the database while the code waits", async () => {
    const { db, plaintextToken, code } = await authorized();
    expect(db.serialize().includes(Buffer.from(plaintextToken))).toBe(false);
    expect(db.serialize().includes(Buffer.from(code))).toBe(false);
    expect(db.prepare("SELECT COUNT(*) AS n FROM oauth_codes").get()).toEqual({ n: 1 });
  });

  it("refuses a stolen code that comes back with somebody else's challenge and verifier", async () => {
    for (const encoding of ["form", "json"] as const) {
      const { app, code } = await authorized();
      const fields = { code: `${code}:${THEIR_CHALLENGE}`, code_verifier: THEIR_VERIFIER };
      const res = await app.request("/oauth/token", encoding === "form" ? form(fields) : {
        method: "POST", body: JSON.stringify({ grant_type: "authorization_code", ...fields }), headers: { "Content-Type": "application/json" },
      });
      expect(res.status, encoding).toBe(400);
      expect(await res.json(), encoding).toMatchObject({ error: "invalid_grant" });
    }
  });

  it("refuses the right code with the wrong verifier, and the code is used up by the attempt", async () => {
    const { app, code } = await authorized();
    const stolen = await app.request("/oauth/token", form({ code, code_verifier: THEIR_VERIFIER }));
    expect(stolen.status).toBe(400);
    expect(await stolen.json()).toMatchObject({ error: "invalid_grant" });
    const late = await app.request("/oauth/token", form({ code, code_verifier: VERIFIER }));
    expect(late.status).toBe(400);
  });

  it("redeems a code once", async () => {
    const { app, code, plaintextToken } = await authorized();
    const first = await app.request("/oauth/token", form({ code, code_verifier: VERIFIER }));
    expect(await first.json()).toMatchObject({ access_token: plaintextToken });
    const replay = await app.request("/oauth/token", form({ code, code_verifier: VERIFIER }));
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("answers a request without a verifier without touching the code", async () => {
    const { app, code, plaintextToken } = await authorized();
    const res = await app.request("/oauth/token", form({ code }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_request" });
    const ok = await app.request("/oauth/token", form({ code, code_verifier: VERIFIER }));
    expect(await ok.json()).toMatchObject({ access_token: plaintextToken });
  });

  it("never lets a token response be cached", async () => {
    const { app, code } = await authorized();
    const res = await app.request("/oauth/token", form({ code, code_verifier: VERIFIER }));
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("pragma")).toBe("no-cache");
  });

  // An S256 challenge is 32 bytes as base64url without padding: 43 characters.
  // It is stored now, so it is bounded like every other stored field.
  it("accepts a well-formed challenge and nothing else", async () => {
    const { app, agents } = setup();
    const { plaintextToken } = agents.create("scout");
    for (const bad of [CHALLENGE.slice(0, 42), CHALLENGE + "A", CHALLENGE + "=", CHALLENGE.slice(0, 42) + "+", "a".repeat(4000)]) {
      const post = await app.request("/oauth/authorize", authorize({ token: plaintextToken, code_challenge: bad }));
      expect(post.status, bad.slice(0, 50)).toBe(400);
      const get = await app.request(`/oauth/authorize?redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${encodeURIComponent(bad)}&code_challenge_method=S256`);
      expect(get.status, bad.slice(0, 50)).toBe(400);
    }
    const ok = await app.request("/oauth/authorize", authorize({ token: plaintextToken, code_challenge: CHALLENGE }));
    expect(ok.status).toBe(200);
    expect(await handoffTarget(ok)).toContain("code=");
  });
});

describe("code_challenge_method", () => {
  it("is S256 or the request is refused, on GET and on POST, and nothing is stored", async () => {
    const { app, agents, db } = setup();
    const { plaintextToken } = agents.create("scout");
    for (const method of ["plain", "", "s256", "S512"]) {
      const post = await app.request("/oauth/authorize", authorize({ token: plaintextToken, code_challenge_method: method }));
      expect(post.status, `POST ${method}`).toBe(400);
      const get = await app.request(`/oauth/authorize?redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${CHALLENGE}&code_challenge_method=${method}`);
      expect(get.status, `GET ${method}`).toBe(400);
    }
    expect(db.prepare("SELECT COUNT(*) AS n FROM oauth_codes").get()).toEqual({ n: 0 });
  });
});

describe("the routes seal with OAUTH_SECRET", () => {
  const exchange = (app: ReturnType<typeof setup>["app"], code: string) =>
    app.request("/oauth/token", { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: VERIFIER }) });

  it("cannot open a code that was sealed under another OAUTH_SECRET", async () => {
    const { app, agents } = setup();
    const { plaintextToken } = agents.create("scout");
    const auth = await app.request("/oauth/authorize", authorize({ token: plaintextToken }));
    const code = new URL(await handoffTarget(auth)).searchParams.get("code")!;
    process.env.OAUTH_SECRET = "p".repeat(40); // rotated between the two requests
    const res = await exchange(app, code);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("falls back to the admin token when there is no OAUTH_SECRET, and to nothing else", async () => {
    delete process.env.OAUTH_SECRET;
    const { app, agents } = setup();
    const { plaintextToken } = agents.create("scout");
    const codeOf = async () => new URL(await handoffTarget(await app.request("/oauth/authorize", authorize({ token: plaintextToken })))).searchParams.get("code")!;
    expect((await exchange(app, await codeOf())).status).toBe(200);
    const waiting = await codeOf();
    process.env.MESH_ADMIN_TOKEN = "z".repeat(40);
    expect((await exchange(app, waiting)).status).toBe(400);
  });
});
