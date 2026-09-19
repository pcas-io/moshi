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
    expect(db.prepare("SELECT COUNT(*) AS n FROM oauth_tokens").get()).toEqual({ n: 0 });
  });

  it("echoes state exactly as the client sent it", async () => {
    // state is an opaque protocol value (RFC 6749 allows spaces). The client
    // compares it byte for byte, so it is never trimmed like a typed field.
    const { app, agents } = setup();
    const { plaintextToken } = agents.create("scout");
    const res = await app.request("/oauth/authorize", authorize({ token: plaintextToken, state: "  padded state  " }));
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get("location")!).searchParams.get("state")).toBe("  padded state  ");
  });

  it("still forgives whitespace around a pasted token", async () => {
    const { app, agents } = setup();
    const { plaintextToken } = agents.create("scout");
    const res = await app.request("/oauth/authorize", authorize({ token: `  ${plaintextToken}\n` }));
    expect(res.status).toBe(302);
  });

  it("still issues a code for an agent token", async () => {
    const { app, agents } = setup();
    const { plaintextToken } = agents.create("scout");
    const res = await app.request("/oauth/authorize", authorize({ token: plaintextToken }));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("code=");
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
    const code = new URL(auth.headers.get("location")!).searchParams.get("code")!;
    const res = await app.request("/oauth/token", json(JSON.stringify({ grant_type: "authorization_code", code, code_verifier: VERIFIER })));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ access_token: plaintextToken, token_type: "Bearer" });
  });

  // What real connectors send: the MCP SDK posts the exchange form-encoded,
  // with client_id, redirect_uri and resource next to the three fields read.
  it("completes the exchange in the shape the MCP SDK sends it", async () => {
    const { app, agents } = setup();
    const { plaintextToken } = agents.create("scout");
    const exchange = async (contentType: string, body: (code: string) => BodyInit) => {
      const auth = await app.request("/oauth/authorize", authorize({ token: plaintextToken }));
      const code = new URL(auth.headers.get("location")!).searchParams.get("code")!;
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
