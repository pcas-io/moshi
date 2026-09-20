// The dashboard pages behind the auth middleware: Home, the thread SSE
// stream, Agents (with the connect flow and the admin actions), Log and
// Conversations. Extracted from src/index.tsx; the order of the routes is
// unchanged.

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type Database from "better-sqlite3";
import type { Env, AppVariables } from "../types.js";
import { LIMITS } from "../types.js";
import type { AgentService } from "../services/agent.js";
import type { ActivityService } from "../services/activity.js";
import type { PresenceService } from "../services/presence.js";
import type { NatsPingable } from "../services/health.js";
import { generateCsrfToken, getCookieSecret } from "../auth.js";
import { createAgentAdminRoutes } from "./agent-admin.js";
import { createAgentConnectRoutes } from "./agent-connect.js";
import { loadConversationList, loadLogMessages, loadOpenThread, readConversationsQuery } from "../services/section-loaders.js";
import { getFlash } from "../services/flash.js";
import { loadV2HomeData } from "../services/v2-home-data.js";
import { loadV2AgentsData } from "../services/v2-agents-data.js";
import { subscribeMessageEvents } from "../services/message-events.js";
import { parseActivityRange, startOfDayIso } from "../services/activity.js";
import { V2HomePage } from "../views/v2/home.js";
import { V2AgentsPage } from "../views/v2/agents.js";
import {
  V2LogPage,
  messageRoutingOf,
  parseLogRouting,
  parseLogTab,
} from "../views/v2/log.js";
import { V2ConversationsPage } from "../views/v2/conversations.js";
import { roleIndex } from "../views/v2/role-index.js";

type HonoEnv = { Bindings: Env; Variables: AppVariables };

export interface DashboardDeps {
  db: Database.Database;
  /** Only for the health check behind Home's needs-attention band. */
  nats: NatsPingable;
  agents: AgentService;
  activity: ActivityService;
  presence: PresenceService;
  /** Render clock. Injected by tests so page and fragment agree exactly. */
  now?: () => number;
}

function cookieSecretFor(env: Env): string {
  return getCookieSecret(env as unknown as Record<string, string | undefined>);
}

export function createDashboardRoutes({ db, nats, agents, activity, presence, now = Date.now }: DashboardDeps): Hono<HonoEnv> {
  const dash = new Hono<HonoEnv>();

  // --- Dashboard: Home (v2) ---
  dash.get("/", async (c) => {
    const agent = c.get("agent");
    const csrfToken = generateCsrfToken(cookieSecretFor(c.env));
    const data = await loadV2HomeData({ db, presence, nats });
    return c.html(
      <V2HomePage
        {...data}
        now={new Date(now())}
        userRole={agent?.role ?? undefined}
        userName={agent?.name ?? undefined}
        csrfToken={csrfToken}
      />,
    );
  });

  // --- SSE: live thread updates ---
  // Subscribes to in-process message events and forwards messages with the
  // matching correlation_id to the connected dashboard. EventSource auto-
  // reconnects on network drops; auth piggy-backs on the session cookie.
  dash.get("/sse/threads/:correlation_id", (c) => {
    const correlationId = c.req.param("correlation_id");
    return streamSSE(c, async (stream) => {
      const unsubscribe = subscribeMessageEvents((msg) => {
        const tid = msg.correlation_id ?? msg.id;
        if (tid !== correlationId) return;
        stream.writeSSE({
          data: JSON.stringify({
            id: msg.id, from: msg.from, payload: msg.payload, created_at: msg.created_at,
          }),
        }).catch(() => { /* connection closed */ });
      });
      stream.onAbort(() => unsubscribe());
      // Heartbeat every 25s keeps proxies from killing idle SSE connections.
      while (!stream.aborted) {
        await stream.sleep(25_000);
        await stream.writeSSE({ event: "ping", data: "" }).catch(() => {});
      }
      unsubscribe();
    });
  });

  // --- Dashboard: Agents (admin only) ---
  dash.get("/agents", async (c) => {
    const agent = c.get("agent");
    if (agent?.role !== "admin") return c.redirect("/");

    // Creating an agent is the connect flow's job now. The old deep link
    // still works so bookmarks and the palette entry land somewhere useful.
    if (c.req.query("new") === "1") return c.redirect("/agents/connect");

    const csrfToken = generateCsrfToken(cookieSecretFor(c.env));
    const flash = getFlash(c.req.query("flash"));
    const agentsData = await loadV2AgentsData(db, presence);

    return c.html(
      <V2AgentsPage
        agents={agentsData}
        csrfToken={csrfToken}
        newToken={flash?.newToken}
        error={flash?.error}
        inspectId={c.req.query("inspect")}
        presenceFilter={c.req.query("presence")}
        userRole={agent.role}
        userName={agent.name}
      />,
    );
  });

  // --- The guided connect flow (/agents/connect, admin only) ---
  // Mounted before the admin actions so its own POST target is unambiguous.
  dash.route("/agents", createAgentConnectRoutes({ agents, presence, cookieSecretFor }));

  // --- Agent admin actions (create/revoke/reactivate/rename/reset-token/delete) ---
  dash.route("/agents", createAgentAdminRoutes({ agents, cookieSecretFor }));

  // --- Dashboard: Log (Messages + Audit trail) ---
  // One route, two tabs. Both tabs filter in SQL, so the counts on screen and
  // the `total` behind the pager describe the same set.
  dash.get("/log", (c) => {
    const agent = c.get("agent");
    const offsetParam = parseInt(c.req.query("offset") ?? "0", 10);
    const offset = isNaN(offsetParam) || offsetParam < 0 ? 0 : offsetParam;
    const query = c.req.query("q")?.trim() || undefined;
    const filterAgent = c.req.query("agent")?.trim() || undefined;
    const tab = parseLogTab(c.req.query("tab"));
    const routing = parseLogRouting(c.req.query("routing"));
    const filterEntity = c.req.query("entity")?.trim() || undefined;
    const range = parseActivityRange(c.req.query("range"));

    const allAgents = agents.list();
    const shared = {
      tab,
      query,
      routing,
      filterAgent,
      filterEntity,
      filterRange: range,
      agentRoles: roleIndex(allAgents),
      userRole: agent?.role ?? undefined,
      userName: agent?.name ?? undefined,
      csrfToken: generateCsrfToken(cookieSecretFor(c.env)),
      now: now(),
    };

    if (tab === "audit") {
      const filter = { agent_name: filterAgent, entity_type: filterEntity, q: query, range };
      return c.html(
        <V2LogPage
          {...shared}
          events={activity.list({ ...filter, limit: LIMITS.PAGINATION_DEFAULT, offset })}
          // "Busiest today" means today, not "the 50 rows we happened to fetch".
          topActors={activity.topActors({ ...filter, since: startOfDayIso(), limit: 5 })}
        />,
      );
    }

    return c.html(
      <V2LogPage
        {...shared}
        messages={loadLogMessages(db, { offset, agent: filterAgent, q: query, routing: messageRoutingOf(routing) })}
      />,
    );
  });

  // --- Permanent redirects for the two routes Log replaced ---
  // The query string has to survive: ?agent= ?q= ?routing= ?offset= ?entity=
  // ?range= are all in use, and /conversations and the palette link to them.
  function logRedirect(c: { req: { url: string } }, extra?: Record<string, string>): string {
    const incoming = new URL(c.req.url).searchParams;
    const params = new URLSearchParams(extra);
    for (const [key, value] of incoming) params.set(key, value);
    const qs = params.toString();
    return qs ? `/log?${qs}` : "/log";
  }

  dash.get("/messages", (c) => c.redirect(logRedirect(c), 301));
  dash.get("/activity", (c) => c.redirect(logRedirect(c, { tab: "audit" }), 301));

  // --- Dashboard: Conversations ---
  dash.get("/conversations", (c) => {
    const agent = c.get("agent");
    const csrfToken = generateCsrfToken(cookieSecretFor(c.env));

    const query = readConversationsQuery((key) => c.req.query(key));
    const result = loadConversationList(db, query);
    const { opened, unknownId } = loadOpenThread(db, query, result);
    return c.html(
      <V2ConversationsPage
        result={result}
        opened={opened}
        unknownId={unknownId}
        now={now()}
        query={query.q}
        filterAgent={query.agent}
        agentRoles={roleIndex(agents.list())}
        userRole={agent?.role ?? undefined}
        userName={agent?.name ?? undefined}
        csrfToken={csrfToken}
      />,
    );
  });

  return dash;
}
