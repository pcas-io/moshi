// JSON API for the operator: the agent lifecycle and the board, for tools such
// as mesh-cockpit (ocellio task 06aef0e1-ed05). Mounted at /api/admin, behind
// the auth middleware and a 4 KB body limit.
//
// The ADMIN TOKEN AS BEARER, and nothing else. A session cookie is never an
// identity here, so no form token is needed and no page can make a browser
// call this cross-site. The middleware alone would not say that: a wrong
// Bearer leaves `who` unset and it falls back to the cookie, so an admin
// session plus any Bearer string would pass a role check. The presented
// Bearer itself is compared with the admin token(s) instead.
//
// A plaintext token appears exactly once, in the answer to create,
// reset-token or reactivate. AgentService logs the action, the agent's name
// and the admin; never the token.

import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import type Database from "better-sqlite3";
import type { Env, AppVariables } from "../types.js";
import type { Agent } from "../types.js";
import { NameTakenError } from "../services/agent.js";
import type { AgentService } from "../services/agent.js";
import type { SignInGuard } from "../services/signin-guard.js";
import type { PresenceService } from "../services/presence.js";
import type { WebhookService } from "../services/webhooks.js";
import { loadBoard } from "../services/board.js";
import type { BoardLinks } from "../services/board.js";
import { hashToken, timingSafeEqual } from "../auth.js";

type HonoEnv = { Bindings: Env; Variables: AppVariables };

export interface AdminApiDeps {
  db: Database.Database;
  agents: AgentService;
  presence: PresenceService;
  webhooks: WebhookService;
  boardLinks?: BoardLinks;
  /** Counts and logs a refused admin Bearer like any other wrong credential. */
  guard?: SignInGuard;
  now?: () => number;
}

/** The actor in the audit log: this API, told apart from the dashboard's "admin". */
const ACTOR = "admin:api";
/** Avatars are ids such as "avatar-21"; nothing longer belongs in the row. */
const MAX_AVATAR = 64;

/** The fields an operator tool needs; never the token hash, never the inbox key. */
function publicAgent(a: Omit<Agent, "token_hash">) {
  return {
    id: a.id,
    name: a.name,
    role: a.role ?? null,
    is_active: a.is_active === 1,
    working_on: a.working_on ?? null,
    last_seen_at: a.last_seen_at ?? null,
    created_at: a.created_at,
  };
}

// A wrong Bearer reaches this point only when the auth middleware let the
// request through on something else: a session cookie (an agent's or the
// admin's) or an agent's own Bearer. The middleware's guard never saw it, so
// it is counted and logged here, as "admin_token_refused".
const adminBearerOnly = (guard?: SignInGuard) => createMiddleware<HonoEnv>(async (c, next) => {
  const header = c.req.header("Authorization") ?? "";
  if (!header.startsWith("Bearer ")) return c.json({ error: "admin_bearer_required" }, 401);
  const presented = hashToken(header.slice(7));
  const tokens = [c.env.MESH_ADMIN_TOKEN, c.env.MESH_ADMIN_TOKEN_PREVIOUS].filter((t): t is string => !!t);
  if (!tokens.some((t) => timingSafeEqual(presented, hashToken(t)))) {
    const wait = guard?.failure(c, "admin_token_refused") ?? 0;
    if (wait > 0) c.header("Retry-After", String(wait));
    return c.json({ error: "forbidden" }, 403);
  }
  return next();
});

export function createAdminApiRoutes({ db, agents, presence, webhooks, boardLinks, guard, now = Date.now }: AdminApiDeps): Hono<HonoEnv> {
  const api = new Hono<HonoEnv>();
  api.use("*", adminBearerOnly(guard));

  /** By id first (ids never pass to another agent), then by name. */
  const resolve = (ref: string): Agent | null => agents.getById(ref) ?? agents.getByName(ref);

  api.get("/agents", (c) => c.json({ agents: agents.list().map(publicAgent) }));

  api.post("/agents", async (c) => {
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
    if (typeof name !== "string" || !name.trim()) return c.json({ error: "name_required" }, 400);
    if (avatar !== undefined && (typeof avatar !== "string" || avatar.length > MAX_AVATAR)) {
      return c.json({ error: "invalid_avatar" }, 400);
    }
    try {
      const { agent, plaintextToken } = agents.create(name.trim(), avatar, ACTOR);
      return c.json({ agent: publicAgent(agent), token: plaintextToken }, 201);
    } catch (err: unknown) {
      if (err instanceof NameTakenError) return c.json({ error: "name_taken", message: err.message }, 409);
      // The service's messages are user-facing (reserved, taken, rule, limit).
      return c.json({ error: err instanceof Error ? err.message : "create_failed" }, 400);
    }
  });

  api.post("/agents/:ref/reset-token", (c) => {
    const agent = resolve(c.req.param("ref"));
    if (!agent) return c.json({ error: "not_found" }, 404);
    const result = agents.resetToken(agent.id, ACTOR);
    if (!result) return c.json({ error: "not_active" }, 409);
    return c.json({ agent: { id: agent.id, name: agent.name }, token: result.plaintextToken });
  });

  api.post("/agents/:ref/revoke", (c) => {
    const agent = resolve(c.req.param("ref"));
    if (!agent) return c.json({ error: "not_found" }, 404);
    agents.revokeById(agent.id, ACTOR);
    return c.json({ agent: { id: agent.id, name: agent.name }, is_active: false });
  });

  api.post("/agents/:ref/reactivate", (c) => {
    const agent = resolve(c.req.param("ref"));
    if (!agent) return c.json({ error: "not_found" }, 404);
    const result = agents.reactivate(agent.id, ACTOR);
    if (!result) return c.json({ error: "already_active" }, 409);
    return c.json({ agent: { id: agent.id, name: agent.name }, token: result.plaintextToken });
  });

  // The board as /board shows it: who has the ball per pair. Types, names and
  // times only; no payload or context ever leaves through here.
  api.get("/board", async (c) => {
    const board = await loadBoard({ db, presence, webhooks, now: now(), links: boardLinks });
    return c.json(board);
  });

  return api;
}
