// POST /api/register/agents — creating an agent with a REGISTRATION token
// (ADR ocellio 06aef68e). Mounted BEFORE the auth middleware: the middleware
// knows only agent tokens, the admin token and session cookies, so a
// registration token presented anywhere else is just a wrong Bearer (401) and
// can never become an agent or the operator. This route checks its token
// itself (src/services/registration.ts) and accepts nothing but that token: no
// cookie, no agent token, not even the admin token (that one has /api/admin).
//
// Answers: 201 {agent, token} (the new agent's token, once), 400 bad body or
// name, 401 invalid / revoked / expired token, 403 name outside the prefix,
// 409 name_taken, 413 body over 4 KB, 429 hourly cap reached or the client is
// throttled for wrong credentials (Retry-After; then no scrypt is spent).
// Every attempt is audited; a refused token also goes through the sign-in
// guard like any wrong credential.

import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Env, AppVariables } from "../types";
import type { RegistrationService } from "../services/registration";
import type { SignInGuard } from "../services/signin-guard";
import { hashIP } from "../auth";
import { clientIp } from "../services/client-ip";

type HonoEnv = { Bindings: Env; Variables: AppVariables };

export interface RegisterApiDeps {
  registration: RegistrationService;
  guard?: SignInGuard;
  behindProxy?: boolean;
}

function publicAgent(a: { id: string; name: string; created_at: string }) {
  return { id: a.id, name: a.name, created_at: a.created_at };
}

export function createRegisterApiRoutes({ registration, guard, behindProxy = true }: RegisterApiDeps): Hono<HonoEnv> {
  const api = new Hono<HonoEnv>();
  api.use("*", bodyLimit({ maxSize: 4 * 1024, onError: (c) => c.json({ error: "body_too_large" }, 413) }));

  api.post("/agents", async (c) => {
    const header = c.req.header("Authorization") ?? "";
    if (!header.startsWith("Bearer rt_")) {
      // Nothing that is not a registration token is accepted here, by design.
      return c.json({ error: "registration_token_required" }, 401);
    }
    // A throttled client whose token cannot be ours (no token shape, unknown id) gets its answer before
    // any work: no scrypt, no audit row, no body read. A token with a known id is always checked: the
    // throttle is shared by every kind of credential from that address (an office behind one NAT),
    // and valid credentials must pass. scrypt is asynchronous, so checking them stalls nothing.
    const wait = guard?.waitFor(c) ?? 0;
    if (wait > 0 && !registration.namesKnownToken(header.slice(7))) {
      c.header("Retry-After", String(wait));
      return c.json({ error: "too_many_attempts" }, 429);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return c.json({ error: "invalid_body" }, 400);
    }
    const name = Object.hasOwn(body, "name") ? (body as { name: unknown }).name : undefined;
    const avatar = Object.hasOwn(body, "avatar") ? (body as { avatar: unknown }).avatar : undefined;
    const ip = clientIp(c.req, (c.get("peerAddress" as never) as string | undefined) ?? undefined, { behindProxy });
    const result = await registration.register(header.slice(7), name, avatar, ip === "unknown" ? null : hashIP(ip));
    if (result.ok) {
      return c.json({ agent: publicAgent(result.agent), token: result.token }, 201);
    }
    if (result.status === 401) {
      const after = guard?.failure(c, "registration_token_refused") ?? 0;
      if (after > 0) c.header("Retry-After", String(after));
    }
    if (result.status === 429 && result.retryAfter) c.header("Retry-After", String(result.retryAfter));
    return c.json({ error: result.error, ...(result.message ? { message: result.message } : {}) }, result.status);
  });

  return api;
}
