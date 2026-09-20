// Admin-only agent lifecycle actions behind the /agents page: create,
// revoke, reactivate, rename, reset-token, delete. Extracted from
// src/index.tsx (which was outgrowing the 600-line budget); mounted with
// `app.route("/agents", …)`, so the paths below are relative.

import { Hono } from "hono";
import type { Env, AppVariables } from "../types.js";
import type { AgentService } from "../services/agent.js";
import { csrfOk } from "../auth.js";
import { setFlash } from "../services/flash.js";
import { formString } from "./form.js";

type HonoEnv = { Bindings: Env; Variables: AppVariables };

export interface AgentAdminDeps {
  agents: AgentService;
}

export function createAgentAdminRoutes({ agents }: AgentAdminDeps): Hono<HonoEnv> {
  const admin = new Hono<HonoEnv>();

  admin.post("/create", async (c) => {
    const agent = c.get("agent");
    if (agent?.role !== "admin") return c.json({ error: "Forbidden" }, 403);

    const body = (await c.req.parseBody()) as Record<string, unknown>;
    const name = formString(body, "name");
    const avatar = formString(body, "avatar");
    const csrf = body["csrf"];

    if (!csrfOk(c, csrf)) {
      const flashKey = setFlash({ error: "That form expired. Reload the page and try again." });
      return c.redirect(`/agents?flash=${flashKey}`);
    }

    if (!name) {
      const flashKey = setFlash({ error: "Give the agent a name." });
      return c.redirect(`/agents?flash=${flashKey}`);
    }

    try {
      const { plaintextToken } = agents.create(name, avatar, agent.name);
      const flashKey = setFlash({ newToken: plaintextToken });
      return c.redirect(`/agents?flash=${flashKey}`);
    } catch (err: unknown) {
      const msg = err instanceof Error
        ? err.message
        : "Something went wrong creating the agent. Check the server log.";
      const flashKey = setFlash({ error: msg });
      return c.redirect(`/agents?flash=${flashKey}`);
    }
  });

  admin.post("/revoke", async (c) => {
    const agent = c.get("agent");
    if (agent?.role !== "admin") return c.json({ error: "Forbidden" }, 403);

    const body = (await c.req.parseBody()) as Record<string, unknown>;
    const id = formString(body, "id") ?? "";
    const csrf = body["csrf"];

    if (!csrfOk(c, csrf)) {
      const flashKey = setFlash({ error: "That form expired. Reload the page and try again." });
      return c.redirect(`/agents?flash=${flashKey}`);
    }

    agents.revokeById(id, agent.name);
    return c.redirect("/agents");
  });

  admin.post("/reactivate", async (c) => {
    const agent = c.get("agent");
    if (agent?.role !== "admin") return c.json({ error: "Forbidden" }, 403);

    const body = (await c.req.parseBody()) as Record<string, unknown>;
    const id = formString(body, "id") ?? "";
    const csrf = body["csrf"];

    if (!csrfOk(c, csrf)) {
      const flashKey = setFlash({ error: "That form expired. Reload the page and try again." });
      return c.redirect(`/agents?flash=${flashKey}`);
    }

    const result = agents.reactivate(id, agent.name);
    if (result) {
      const flashKey = setFlash({ newToken: result.plaintextToken });
      return c.redirect(`/agents?flash=${flashKey}`);
    }
    return c.redirect("/agents");
  });

  admin.post("/rename", async (c) => {
    const agent = c.get("agent");
    if (agent?.role !== "admin") return c.json({ error: "Forbidden" }, 403);

    const body = (await c.req.parseBody()) as Record<string, unknown>;
    const id = formString(body, "id") ?? "";
    const name = formString(body, "name");
    const csrf = body["csrf"];

    // Back to the agent that was being renamed, so the operator sees the
    // result (or the reason) next to the form they just used.
    const detail = `/agents?inspect=${encodeURIComponent(id)}`;
    const refuse = (message: string) =>
      c.redirect(`${detail}&flash=${setFlash({ error: message })}`);

    if (!csrfOk(c, csrf)) {
      return refuse("That form expired. Reload the page and try again.");
    }

    if (!name) return refuse("Give the agent a name.");

    let found: boolean;
    try {
      found = agents.rename(id, name, agent.name);
    } catch (err: unknown) {
      return refuse(
        err instanceof Error
          ? err.message
          : "Something went wrong renaming the agent. Check the server log.",
      );
    }

    // No `inspect` here: the Agents page falls back to the first agent for
    // an unknown id, and the operator would land on someone else's form.
    if (!found) {
      return c.redirect(
        `/agents?flash=${setFlash({ error: "That agent no longer exists. Reload the page." })}`,
      );
    }

    return c.redirect(detail);
  });

  admin.post("/reset-token", async (c) => {
    const agent = c.get("agent");
    if (agent?.role !== "admin") return c.json({ error: "Forbidden" }, 403);

    const body = (await c.req.parseBody()) as Record<string, unknown>;
    const id = formString(body, "id") ?? "";
    const csrf = body["csrf"];

    if (!csrfOk(c, csrf)) {
      const flashKey = setFlash({ error: "That form expired. Reload the page and try again." });
      return c.redirect(`/agents?flash=${flashKey}`);
    }

    const result = agents.resetToken(id, agent.name);
    if (result) {
      const flashKey = setFlash({ newToken: result.plaintextToken });
      return c.redirect(`/agents?flash=${flashKey}`);
    }
    return c.redirect("/agents");
  });

  admin.post("/delete", async (c) => {
    const agent = c.get("agent");
    if (agent?.role !== "admin") return c.json({ error: "Forbidden" }, 403);

    const body = (await c.req.parseBody()) as Record<string, unknown>;
    const id = formString(body, "id") ?? "";
    const csrf = body["csrf"];

    if (!csrfOk(c, csrf)) {
      const flashKey = setFlash({ error: "That form expired. Reload the page and try again." });
      return c.redirect(`/agents?flash=${flashKey}`);
    }

    agents.deleteById(id, agent.name);
    return c.redirect("/agents");
  });

  return admin;
}
