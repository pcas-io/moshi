// The admin's way to set or remove any agent's webhook, from the agent aside
// on /agents. Agents do the same for themselves with mesh_webhook_set; the
// rules (URL, DNS, secret formats) are the same, in WebhookService.
// Mounted with `app.route("/agents", …)` next to src/routes/agent-admin.ts.

import { Hono } from "hono";
import type { Env, AppVariables } from "../types.js";
import type { MessagePriority } from "../types.js";
import type { AgentService } from "../services/agent.js";
import { inboxKeyOf } from "../services/agent.js";
import { WebhookError } from "../services/webhooks.js";
import type { WebhookService, AuthMode } from "../services/webhooks.js";
import { csrfOk } from "../auth.js";
import { setFlash } from "../services/flash.js";
import { formString } from "./form.js";

type HonoEnv = { Bindings: Env; Variables: AppVariables };

export interface AgentWebhookDeps {
  agents: AgentService;
  webhooks: WebhookService;
}

/** Empty: the default of the hook's kind. Anything else must be a whole
 *  number; `set` checks the bounds and names them. */
function intervalField(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  return /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
}

export function createAgentWebhookRoutes({ agents, webhooks }: AgentWebhookDeps): Hono<HonoEnv> {
  const routes = new Hono<HonoEnv>();

  routes.post("/webhook", async (c) => {
    const actor = c.get("agent");
    if (actor?.role !== "admin") return c.json({ error: "Forbidden" }, 403);

    const body = (await c.req.parseBody()) as Record<string, unknown>;
    const id = formString(body, "id") ?? "";
    const detail = `/agents?inspect=${encodeURIComponent(id)}`;
    const refuse = (message: string) => c.redirect(`${detail}&flash=${setFlash({ error: message })}`);

    if (!csrfOk(c, body["csrf"])) return refuse("That form expired. Reload the page and try again.");
    const agent = agents.getById(id);
    if (!agent) return c.redirect(`/agents?flash=${setFlash({ error: "That agent no longer exists. Reload the page." })}`);

    const url = formString(body, "url") ?? "";
    const target = await webhooks.checkTarget(url);
    if (!target.ok) return refuse(`Webhook not set: ${target.reason}.`);

    let generated: string | undefined;
    try {
      generated = webhooks.set(
        inboxKeyOf(agent),
        {
          url,
          // Empty: automatic, told by the key.
          authMode: (formString(body, "auth_mode") || undefined) as AuthMode | undefined,
          includeBroadcasts: formString(body, "include_broadcasts") === "1",
          types: (formString(body, "types") ?? "").split(","),
          minPriority: (formString(body, "min_priority") ?? "low") as MessagePriority,
          minIntervalSeconds: intervalField(formString(body, "min_interval_seconds")),
        },
        formString(body, "secret"),
        actor.name,
      ).generatedSecret;
    } catch (err) {
      if (err instanceof WebhookError) return refuse(`Webhook not set: ${err.message}.`);
      throw err;
    }
    return c.redirect(generated ? `${detail}&flash=${setFlash({ webhookSecret: generated })}` : detail);
  });

  routes.post("/webhook/delete", async (c) => {
    const actor = c.get("agent");
    if (actor?.role !== "admin") return c.json({ error: "Forbidden" }, 403);

    const body = (await c.req.parseBody()) as Record<string, unknown>;
    const id = formString(body, "id") ?? "";
    const detail = `/agents?inspect=${encodeURIComponent(id)}`;
    if (!csrfOk(c, body["csrf"])) {
      return c.redirect(`${detail}&flash=${setFlash({ error: "That form expired. Reload the page and try again." })}`);
    }
    const agent = agents.getById(id);
    if (agent) webhooks.delete(inboxKeyOf(agent), actor.name);
    return c.redirect(detail);
  });

  return routes;
}
