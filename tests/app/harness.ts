// App-level harness: the real Hono app from createApp(), wired to the same
// in-memory SQLite and fake NATS the MCP harness uses. What is under test
// here is the wiring — middleware order, mounts, headers — which no test
// could reach while src/index.tsx ran config loading and start() on import.

import { vi } from "vitest";
import { createApp } from "../../src/app";
import type { AppNats } from "../../src/app";
import type { Config } from "../../src/config";
import { createHarness } from "../mcp/harness";
import type { Harness } from "../mcp/harness";
import { generateCsrfToken, readSessionCookie, csrfBindingOf, SESSION_COOKIE, LOGIN_COOKIE } from "../../src/auth";

export const ADMIN_TOKEN = "a".repeat(40);

export const TEST_CONFIG: Config = {
  meshAdminToken: ADMIN_TOKEN,
  meshAdminTokenPrevious: undefined,
  meshCookieSecret: "c".repeat(32),
  oauthSecret: "o".repeat(32),
  natsUrl: "nats://test.invalid:4222",
  databasePath: ":memory:",
  port: 0,
  isProduction: false,
  cookieSecure: false,
  // Like production: a proxy in front that appends its peer to X-Forwarded-For.
  behindProxy: true,
  commit: "unknown",
  cspMode: "report",
  // Empty on purpose: the app then takes the origin from the request, which
  // is the path the header validation guards.
  publicUrl: "",
  backupDir: null,
  backupKeep: 0,
};

export interface TestApp {
  app: ReturnType<typeof createApp>;
  h: Harness;
  /** Inbox keys ensureConsumer was called with, in order. */
  ensured: string[];
  /** The `since` that came with each of those calls. */
  ensuredSince: (string | null | undefined)[];
  /** Whether each call asked to replace a durable older than the agent. */
  ensuredReplace: (boolean | undefined)[];
  natsUp: { value: boolean };
  touch: ReturnType<typeof vi.spyOn>;
}

export function createTestApp(config: Partial<Config> = {}, extra: { now?: () => number } = {}): TestApp {
  const h = createHarness();
  const ensured: string[] = [];
  const ensuredSince: (string | null | undefined)[] = [];
  const ensuredReplace: (boolean | undefined)[] = [];
  const natsUp = { value: true };
  const nats: AppNats = Object.assign(h.nats, {
    ping: async () => natsUp.value,
    ensureConsumer: async (inboxKey: string, since?: string | null, opts?: { replaceLeftBehind?: boolean }) => {
      ensured.push(inboxKey); ensuredSince.push(since); ensuredReplace.push(opts?.replaceLeftBehind);
    },
  });
  const touch = vi.spyOn(h.presence, "touch");
  const app = createApp({
    config: { ...TEST_CONFIG, ...config },
    db: h.db, nats, agents: h.agents, activity: h.activity, presence: h.presence, rateLimiter: h.rateLimiter,
    now: extra.now,
  });
  return { app, h, ensured, ensuredSince, ensuredReplace, natsUp, touch };
}

export const MCP_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
} as const;

export const rpc = (method: string, params: unknown, id = 1) =>
  JSON.stringify({ jsonrpc: "2.0", id, method, params });

// --- Signing in the way a browser does ---
// The sign-in form is protected by a token bound to a pre-session cookie, and
// every later form by one bound to the session. Tests go through the same
// door: they fetch the page, keep the cookie, post the form.


type App = ReturnType<typeof createApp>;

/** `name=value` of one cookie a response set, or null. */
export function cookieFrom(res: Response, name: string): string | null {
  for (const line of res.headers.getSetCookie()) {
    const pair = line.split(";")[0];
    if (pair.startsWith(`${name}=`)) return pair;
  }
  return null;
}

export const csrfInPage = (html: string): string => /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";

export const formPost = (fields: Record<string, string>, headers: Record<string, string> = {}): RequestInit => ({
  method: "POST",
  body: new URLSearchParams(fields),
  headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
});

/** GET /login, then POST it. Returns the POST response and the session cookie (`mesh_session=…`), if one was set. */
export async function signIn(
  app: App, token: string, fields: Record<string, string> = {}, headers: Record<string, string> = {},
): Promise<{ res: Response; cookie: string }> {
  const page = await app.request("/login", { headers });
  const pre = cookieFrom(page, LOGIN_COOKIE) ?? "";
  const res = await app.request("/login", formPost({ csrf: csrfInPage(await page.text()), token, ...fields }, { Cookie: pre, ...headers }));
  return { res, cookie: cookieFrom(res, SESSION_COOKIE) ?? "" };
}

/** A form token for the session in `cookie` (`mesh_session=…`), as a page of that session would carry it. */
export function csrfFor(cookie: string, secret: string = TEST_CONFIG.meshCookieSecret): string {
  const claims = readSessionCookie(decodeURIComponent(cookie.slice(cookie.indexOf("=") + 1)), secret);
  if (!claims) throw new Error("csrfFor: not a valid session cookie");
  return generateCsrfToken(secret, csrfBindingOf(claims));
}
