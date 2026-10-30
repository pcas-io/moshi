// mesh_webhook_set, mesh_webhook_get, mesh_webhook_delete: an agent's own
// webhook, the push beside the pull. Only for the calling agent; the admin
// sets anybody's in the dashboard (src/routes/agent-webhook.ts), and these
// tools refuse the admin token like every other tool of an agent.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MESSAGE_PRIORITIES } from "../../types.js";
import { AUTH_MODES, WEBHOOK_LIMITS, WebhookError } from "../../services/webhooks.js";
import { MAX_URL_LENGTH } from "../../services/webhook-target.js";
import { ok, error, adminError, pendingCount } from "../shared.js";
import type { ToolContext } from "../shared.js";

const SECRET_MAX = 600;

export function registerWebhookTools(server: McpServer, ctx: ToolContext): void {
  const { webhooks, rateLimiter, inboxKey, agentName } = ctx;

  server.tool(
    "mesh_webhook_set",
    "Have moshi call a URL of yours when mail for you arrives, so you can wake on it instead of polling. " +
      "One call per 30 seconds at most, listing message ids, senders and types, never a payload or a context: fetch those with mesh_receive. " +
      "https on port 443 to a public host only. Signed with Standard Webhooks (webhook-id, webhook-timestamp, webhook-signature); " +
      "give the receiver's whsec_ secret, or leave it out and moshi makes one and shows it ONCE in this answer. " +
      "auth_mode 'bearer' sends the receiver's key as 'Authorization: Bearer <key>' instead. Replaces a webhook you had and switches it on.",
    {
      url: z.string().max(MAX_URL_LENGTH).describe("https:// URL on port 443, e.g. the URL of a webhook trigger"),
      auth_mode: z.enum(AUTH_MODES).optional().describe("standard_webhooks (default): signed; bearer: the key in an Authorization header"),
      secret: z
        .string()
        .max(SECRET_MAX)
        .optional()
        .describe("standard_webhooks: the receiver's whsec_… secret, or leave out to have one made; bearer: the receiver's key (required)"),
      include_broadcasts: z.boolean().optional().describe("Also for broadcasts (default false: direct messages only)"),
      types: z
        .array(z.string().max(WEBHOOK_LIMITS.TYPE))
        .max(WEBHOOK_LIMITS.TYPES)
        .optional()
        .describe("Only for these message types (default: all)"),
      min_priority: z.enum(MESSAGE_PRIORITIES).optional().describe("Only for this priority and above (default low: all)"),
    },
    async (params) => {
      if (ctx.isAdmin) return adminError();
      // DNS is asked on every set: the same bucket as sending.
      const rate = rateLimiter.check(inboxKey);
      if (!rate.allowed) return error(`Rate limit exceeded. Wait ${rate.retryAfterSeconds} seconds before retrying.`);

      const target = await webhooks.checkTarget(params.url);
      if (!target.ok) return error(`url refused: ${target.reason}.`);
      let result;
      try {
        result = webhooks.set(
          inboxKey,
          {
            url: params.url,
            authMode: params.auth_mode ?? "standard_webhooks",
            includeBroadcasts: params.include_broadcasts ?? false,
            types: params.types ?? null,
            minPriority: params.min_priority ?? "low",
          },
          params.secret,
          agentName,
        );
      } catch (err) {
        if (err instanceof WebhookError) return error(`${err.message}.`);
        throw err;
      }
      return ok({
        webhook: result.view,
        ...(result.generatedSecret
          ? {
              secret: result.generatedSecret,
              hint: "This is the only time the secret is shown: store it with the receiver now. mesh_webhook_get never returns it; mesh_webhook_set again makes a new one.",
            }
          : {}),
        inbox_pending: await pendingCount(ctx),
      });
    },
  );

  server.tool(
    "mesh_webhook_get",
    "Your webhook: URL, filters, state (active, failing, disabled), last success and failure, last error, and the call waiting or being retried. Never the secret.",
    {},
    { readOnlyHint: true },
    async () => {
      if (ctx.isAdmin) return adminError();
      return ok({ webhook: webhooks.get(inboxKey), inbox_pending: await pendingCount(ctx) });
    },
  );

  server.tool(
    "mesh_webhook_delete",
    "Remove your webhook, and the call it had waiting. Your mail stays where it is: mesh_receive works as before.",
    {},
    async () => {
      if (ctx.isAdmin) return adminError();
      return ok({ deleted: webhooks.delete(inboxKey, agentName), inbox_pending: await pendingCount(ctx) });
    },
  );
}
