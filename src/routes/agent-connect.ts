// The guided connect flow behind /agents/connect: render the four steps,
// create the agent, and answer "has it said hello yet?" for step 4's poll.
//
// Mounted with `app.route("/agents", …)`, so the paths below are relative.
// Same admin guard and CSRF handling as routes/agent-admin.ts; the one
// difference is that a failed create re-renders step 1 with the error
// inline instead of redirecting through a flash — the operator's typed
// name has to survive, and a four-step flow should not bounce.

import { Hono } from "hono";
import type { Env, AppVariables, Agent } from "../types.js";
import type { AgentWithPresence } from "../services/presence.js";
import { issueCsrf, csrfOk } from "../auth.js";
import { isReservedAgentName, isValidAgentName, reservedNameError } from "../services/agent.js";
import { requestOrigin } from "../services/cli-dist.js";
import { createConnectSession, readConnectSession } from "../services/connect-session.js";
import { NAME_RULE_MESSAGE, renderConnectPage, type ConnectStep } from "../views/v2/connect.js";
import { stepHref } from "../views/v2/connect-parts.js";
import { formString } from "./form.js";
import {
  DEFAULT_CONNECT_CLIENT,
  isConnectClientKey,
  type ConnectClientKey,
} from "../views/v2/connect-clients.js";

type HonoEnv = { Bindings: Env; Variables: AppVariables };

/** Only the two agent operations this flow performs. `AgentService`
 *  satisfies it; a test can hand over a four-line stub. */
export interface ConnectAgentService {
  create(
    name: string,
    avatar?: string,
    adminName?: string,
  ): { agent: Agent; plaintextToken: string };
  getByName(name: string): Agent | null;
}

/** The single read path for presence (services/presence.ts owns it —
 *  routes never query the agents table themselves). */
export interface ConnectPresenceService {
  list(now?: number): Promise<AgentWithPresence[]>;
}

export interface AgentConnectDeps {
  agents: ConnectAgentService;
  presence: ConnectPresenceService;
  /** Clock seam. Session expiry and the handshake window are relative to
   *  it, so tests can pin a moment instead of racing the wall clock. */
  now?: () => number;
}

const CSRF_ERROR = "That form expired. Reload the page and try again.";
const EMPTY_NAME_ERROR = "Give the agent a name.";
const CREATE_ERROR = "Something went wrong creating the agent. Check the server log.";

function takenError(name: string): string {
  return (
    `There's already an agent called ${name}. ` +
    "Pick another name, or reactivate the existing one from Agents."
  );
}

function parseStep(raw: string | undefined): ConnectStep {
  const n = Number(raw);
  return n === 2 || n === 3 || n === 4 ? n : 1;
}

function parseClient(raw: string | undefined): ConnectClientKey {
  return isConnectClientKey(raw) ? raw : DEFAULT_CONNECT_CLIENT;
}

/** `capabilities` is a JSON array in a TEXT column; a bad row must not
 *  take the poll down. */
function parseCapabilities(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

export function createAgentConnectRoutes({
  agents,
  presence,
  now = Date.now,
}: AgentConnectDeps): Hono<HonoEnv> {
  const connect = new Hono<HonoEnv>();

  connect.get("/connect", async (c) => {
    const admin = c.get("agent");
    if (admin?.role !== "admin") return c.redirect("/");

    const session = readConnectSession(c.req.query("s"), now());
    return c.html(
      await renderConnectPage({
        step: parseStep(c.req.query("step")),
        client: parseClient(c.req.query("client")),
        origin: requestOrigin(c),
        csrfToken: issueCsrf(c),
        userRole: admin.role,
        userName: admin.name,
        sessionKey: session?.key,
        agentName: session?.agentName,
        token: session?.token,
      }, c.get("cspNonce")),
      200,
      // Step 2 renders the plaintext bearer token into the body.
      { "Cache-Control": "no-store" },
    );
  });

  connect.post("/connect/create", async (c) => {
    const admin = c.get("agent");
    if (admin?.role !== "admin") return c.json({ error: "Forbidden" }, 403);

    const body = await c.req.parseBody();
    const name = formString(body as Record<string, unknown>, "name") ?? "";
    const csrf = (body as Record<string, unknown>)["csrf"];

    // Step 1 again, with the error under the constraint line and whatever
    // the operator typed still in the field.
    const again = async (error: string, status: 400 | 403) =>
      c.html(
        await renderConnectPage({
          step: 1,
          client: parseClient(c.req.query("client")),
          origin: requestOrigin(c),
          csrfToken: issueCsrf(c),
          userRole: admin.role,
          userName: admin.name,
          typedName: name,
          error,
        }, c.get("cspNonce")),
        status,
      );

    if (!csrfOk(c, csrf)) return again(CSRF_ERROR, 403);
    if (!name) return again(EMPTY_NAME_ERROR, 400);
    // `AgentService.create` would reject these too. Checked here first so a
    // bad name re-renders step 1 with its reason instead of falling into the
    // generic creation-error path below.
    if (isReservedAgentName(name)) return again(reservedNameError(name), 400);
    if (!isValidAgentName(name)) return again(NAME_RULE_MESSAGE, 400);
    if (agents.getByName(name)) return again(takenError(name), 400);

    let created: { agent: Agent; plaintextToken: string };
    try {
      created = agents.create(name, undefined, admin.name);
    } catch (err: unknown) {
      return again(err instanceof Error ? err.message : CREATE_ERROR, 400);
    }

    const session = createConnectSession({
      agentId: created.agent.id,
      agentName: created.agent.name,
      token: created.plaintextToken,
    }, now());
    return c.redirect(stepHref(2, session.key, parseClient(c.req.query("client"))));
  });

  // Step 4's poll. Answers one question — has this agent been seen since
  // its token was issued — plus what it announced, if anything.
  connect.get("/connect/handshake", async (c) => {
    const admin = c.get("agent");
    if (admin?.role !== "admin") return c.json({ error: "Forbidden" }, 403);

    const session = readConnectSession(c.req.query("s"), now());
    if (!session) return c.json({ error: "expired" }, 410);

    const entry = (await presence.list(now())).find((e) => e.agent.id === session.agentId);
    if (!entry) return c.json({ error: "unknown_agent" }, 404);

    const lastSeen = entry.effectiveLastSeen;
    // "Since the token was issued", not "ever": a reactivated name must not
    // report a handshake that happened in a previous life.
    const seen = !!lastSeen && Date.parse(lastSeen) >= session.createdAt;
    const role = entry.agent.role;
    return c.json(
      {
        seen,
        last_seen_at: lastSeen,
        role,
        capabilities: parseCapabilities(entry.agent.capabilities),
        // Authenticated once is not the same as having introduced itself;
        // step 4's copy says something different for each.
        registered: seen && !!role,
      },
      200,
      { "Cache-Control": "no-store" },
    );
  });

  return connect;
}
