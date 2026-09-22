// Sign-in and sign-out. Extracted from src/index.tsx so the handlers can be
// tested; mounted before the auth middleware, because both are public.

import crypto from "node:crypto";
import { Hono } from "hono";
import type { Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Env, AppVariables } from "../types.js";
import type { AgentService } from "../services/agent.js";
import { hashToken } from "../services/agent.js";
import {
  CSRF_LOGIN_MAX_AGE_MS,
  CSRF_SESSION_MAX_AGE_MS,
  LOGIN_COOKIE,
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  csrfBindingOf,
  generateCsrfToken,
  generateSessionCookie,
  getCookieSecret,
  isSameOriginPost,
  loginCsrfBinding,
  readSessionCookie,
  safeNextPath,
  sessionCookieAttributes,
  timingSafeEqual,
  validateCsrfToken,
} from "../auth.js";
import { formString } from "./form.js";
import { SignOutPage } from "../views/signout.js";
import { throttledResponse } from "../views/throttled.js";
import type { SignInGuard } from "../services/signin-guard.js";

type HonoEnv = { Bindings: Env; Variables: AppVariables };

// --- The sign-in page's own cookie ---
// Nobody is signed in on /login, so its form token cannot be bound to a
// session. It is bound to this cookie instead: a random value the browser got
// with the page. Fetching /login yields a token, but not one that fits the
// cookie in somebody else's browser.
//
// That holds against another SITE. A sibling host (same registrable domain)
// can plant a cookie of this name together with a token that fits it; what
// stops that one is isSameOriginPost(), which asks the browser where the form
// was posted from.
const LOGIN_NONCE = /^[A-Za-z0-9_-]{24}$/;

const loginCookieAttributes = (secure: boolean) =>
  ({ httpOnly: true, sameSite: "Lax", path: "/login", secure } as const);

/** The form fields, or none. A body that cannot be parsed is a form without
 *  fields, not an HTTP 500 with a stack trace in the log. */
async function formOf(c: Context<HonoEnv>): Promise<Record<string, unknown>> {
  try {
    return (await c.req.parseBody()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

const secretOf = (c: Context<HonoEnv>): string =>
  getCookieSecret(c.env as unknown as Record<string, string | undefined>);

/**
 * The form token for GET /login. Sets the pre-session cookie, or keeps the
 * one the browser already has: a second tab must not break the first.
 */
export function issueLoginCsrf(c: Context<HonoEnv>, secureCookie: boolean): string {
  const held = getCookie(c, LOGIN_COOKIE);
  const nonce = held && LOGIN_NONCE.test(held) ? held : crypto.randomBytes(18).toString("base64url");
  setCookie(c, LOGIN_COOKIE, nonce, { ...loginCookieAttributes(secureCookie), maxAge: CSRF_LOGIN_MAX_AGE_MS / 1000 });
  return generateCsrfToken(secretOf(c), loginCsrfBinding(nonce));
}

export interface SessionDeps {
  /** Told about wrong tokens: logs them, and answers 429 after ten. */
  guard?: SignInGuard;
  agents: Pick<AgentService, "getByTokenHash">;
  /** `Secure` on the session cookie — `config.cookieSecure`. Off wherever
   *  the dashboard is served over plain http, or the browser drops it. */
  secureCookie: boolean;
}

export function createSessionRoutes({ agents, secureCookie, guard }: SessionDeps): Hono<HonoEnv> {
  const session = new Hono<HonoEnv>();
  const cookieAttributes = sessionCookieAttributes(secureCookie);

  session.post("/login", async (c) => {
    const cookieSecret = secretOf(c);
    const body = await formOf(c);
    const token = formString(body, "token");
    const next = safeNextPath(formString(body, "next"));
    const backTo = next !== "/" ? `&next=${encodeURIComponent(next)}` : "";
    const loginError = `/login?error=1${backTo}`;

    // The pre-session value comes from the cookie and from nowhere else.
    const held = getCookie(c, LOGIN_COOKIE);
    const nonce = held && LOGIN_NONCE.test(held) ? held : undefined;
    const formIsOurs =
      isSameOriginPost(c.req) &&
      validateCsrfToken(body["csrf"], cookieSecret, loginCsrfBinding(nonce), CSRF_LOGIN_MAX_AGE_MS);
    if (!formIsOurs) {
      // Not "invalid token": the token was never looked at. The usual cause
      // is a second tab. Another tab signed in, which spent the pre-session
      // cookie; this browser is signed in already, so it goes where it wanted.
      const session = getCookie(c, SESSION_COOKIE);
      if (session && isSameOriginPost(c.req) && readSessionCookie(session, cookieSecret)) return c.redirect(next);
      return c.redirect(`/login?error=expired${backTo}`);
    }
    if (!token) return c.redirect(loginError);

    const adminToken = c.env.MESH_ADMIN_TOKEN;
    const adminTokenPrev = c.env.MESH_ADMIN_TOKEN_PREVIOUS;
    const hash = hashToken(token);

    let who: { kind: "admin" | "agent"; id: string } | null = null;
    if (timingSafeEqual(hash, hashToken(adminToken))) {
      who = { kind: "admin", id: "" };
    } else if (adminTokenPrev && timingSafeEqual(hash, hashToken(adminTokenPrev))) {
      who = { kind: "admin", id: "" };
    } else {
      const found = agents.getByTokenHash(hash);
      if (found && found.is_active) who = { kind: "agent", id: found.id };
    }

    if (!who) {
      const wait = guard?.failure(c, "wrong_token") ?? 0;
      if (wait > 0) return throttledResponse(c, wait);
      return c.redirect(loginError);
    }

    // The session is made from THIS token: it names the agent by id and
    // carries a fingerprint of the token's hash. Reset or rotate the token
    // and the session is over.
    setCookie(c, SESSION_COOKIE, generateSessionCookie({ ...who, tokenHash: hash }, cookieSecret), {
      ...cookieAttributes,
      maxAge: SESSION_MAX_AGE_SECONDS,
    });
    // Spent. The next sign-in page brings its own.
    deleteCookie(c, LOGIN_COOKIE, loginCookieAttributes(secureCookie));
    return c.redirect(next);
  });

  // POST only. As a GET, any page could sign the operator out with an <img>.
  session.post("/logout", async (c) => {
    const cookieSecret = secretOf(c);
    const held = getCookie(c, SESSION_COOKIE);
    // No cookie came along: there is nothing to end, and nothing is cleared.
    // SameSite=Lax keeps the cookie off a cross-site POST, so "no cookie" is
    // exactly what a hostile form looks like. Clearing it anyway signed the
    // operator out from any web page.
    if (held === undefined) return c.redirect("/login");
    const claims = readSessionCookie(held, cookieSecret);

    // A live session is ended by its own pages only. Anything else gets
    // asked, on a page whose button does carry the right token.
    if (claims) {
      const body = await formOf(c);
      const binding = csrfBindingOf(claims);
      if (!isSameOriginPost(c.req) || !validateCsrfToken(body["csrf"], cookieSecret, binding, CSRF_SESSION_MAX_AGE_MS)) {
        return c.html(<SignOutPage csrfToken={generateCsrfToken(cookieSecret, binding)} />, 403);
      }
    }

    // Same attributes as when it was set, or browsers keep the cookie.
    deleteCookie(c, SESSION_COOKIE, cookieAttributes);
    return c.redirect("/login");
  });

  return session;
}
