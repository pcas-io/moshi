// Sign-in and sign-out. Extracted from src/index.tsx so the handlers can be
// tested; mounted before the auth middleware, because both are public.

import { Hono } from "hono";
import type { Context } from "hono";
import { setCookie, deleteCookie } from "hono/cookie";
import type { Env, AppVariables } from "../types.js";
import type { AgentService } from "../services/agent.js";
import { hashToken } from "../services/agent.js";
import {
  generateSessionCookie,
  getCookieSecret,
  safeNextPath,
  timingSafeEqual,
  validateCsrfToken,
} from "../auth.js";
import { formString } from "./form.js";

type HonoEnv = { Bindings: Env; Variables: AppVariables };

const SESSION_COOKIE = "mesh_session";
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

export interface SessionDeps {
  agents: Pick<AgentService, "getByTokenHash">;
  /** `Secure` on the session cookie. Off outside production, where the
   *  dashboard is served over plain http on localhost. */
  isProduction: boolean;
}

export function createSessionRoutes({ agents, isProduction }: SessionDeps): Hono<HonoEnv> {
  const session = new Hono<HonoEnv>();
  const cookieAttributes = { httpOnly: true, sameSite: "Lax", path: "/", secure: isProduction } as const;

  session.post("/login", async (c) => {
    const cookieSecret = getCookieSecret(c.env as unknown as Record<string, string | undefined>);
    const body = (await c.req.parseBody()) as Record<string, unknown>;
    const token = formString(body, "token");
    const next = safeNextPath(formString(body, "next"));
    const loginError = `/login?error=1${next !== "/" ? `&next=${encodeURIComponent(next)}` : ""}`;

    if (!validateCsrfToken(body["csrf"], cookieSecret)) return c.redirect(loginError);
    if (!token) return c.redirect(loginError);

    const adminToken = c.env.MESH_ADMIN_TOKEN;
    const adminTokenPrev = c.env.MESH_ADMIN_TOKEN_PREVIOUS;
    const hash = hashToken(token);

    let resolvedName: string | null = null;
    if (timingSafeEqual(hash, hashToken(adminToken))) {
      resolvedName = "admin";
    } else if (adminTokenPrev && timingSafeEqual(hash, hashToken(adminTokenPrev))) {
      resolvedName = "admin";
    } else {
      const found = agents.getByTokenHash(hash);
      if (found && found.is_active) resolvedName = found.name;
    }

    if (!resolvedName) return c.redirect(loginError);

    setCookie(c, SESSION_COOKIE, generateSessionCookie(resolvedName, cookieSecret), {
      ...cookieAttributes,
      maxAge: SESSION_MAX_AGE_SECONDS,
    });
    return c.redirect(next);
  });

  const signOut = (c: Context<HonoEnv>) => {
    // Same attributes as when it was set, or browsers keep the cookie.
    deleteCookie(c, SESSION_COOKIE, cookieAttributes);
    return c.redirect("/login");
  };
  session.post("/logout", signOut);
  session.get("/logout", signOut);

  return session;
}
