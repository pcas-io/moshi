import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ok, adminError, pendingCount } from "../shared.js";
import type { ToolContext } from "../shared.js";
import { FIELD_LIMITS } from "../../types.js";

/** `agents.capabilities` is a JSON array in a TEXT column; tolerate the
 *  free-form values older rows may carry. */
export function parseCapabilities(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {
    // fall through — treat as free-form text
  }
  const parts = raw.split(/[,\s]+/).filter(Boolean);
  return parts.length > 0 ? parts : null;
}

export function registerRegistryTools(server: McpServer, ctx: ToolContext): void {
  const { presence, agentName } = ctx;

  // ── mesh_status ───────────────────────────────────────────────
  server.tool(
    "mesh_status",
    "See which agents are online and what they are working on. No parameters needed. Also returns inbox_pending — how many messages are waiting for you.",
    {},
    { readOnlyHint: true },
    async () => {
      // Single read-path: PresenceService.list() joins SQLite + NATS KV
      // and runs the 4-state calculation. C4 graceful degradation on
      // NATS failure is handled inside the service.
      const entries = await presence.list();
      const agentList = entries.map((e) => ({
        name: e.agent.name,
        avatar: e.agent.avatar ?? null,
        role: e.agent.role ?? null,
        capabilities: parseCapabilities(e.agent.capabilities),
        is_active: e.agent.is_active === 1,
        // `online` kept for backward compatibility — equivalent to presence === "live"
        online: e.presence === "live",
        presence: e.presence,
        working_on: e.agent.working_on ?? null,
        last_seen_at: e.effectiveLastSeen,
      }));

      return ok({
        agents: agentList,
        count: agentList.length,
        inbox_pending: await pendingCount(ctx),
      });
    },
  );

  // ── mesh_register ─────────────────────────────────────────────
  server.tool(
    "mesh_register",
    "Announce your role, capabilities, and current task so other agents can discover you. Call it once per session; presence itself is refreshed by every MCP call.",
    {
      role: z.string().max(FIELD_LIMITS.ROLE).optional().describe("Your role (e.g. 'deploy-agent', 'code-reviewer')"),
      capabilities: z
        .array(z.string().max(FIELD_LIMITS.CAPABILITY))
        .max(FIELD_LIMITS.CAPABILITIES)
        .optional()
        .describe("List of capabilities (e.g. ['deploy', 'rollback', 'monitor'])"),
      working_on: z.string().max(FIELD_LIMITS.WORKING_ON).optional().describe("What you are currently working on (max 512 chars)"),
    },
    async (params) => {
      if (ctx.isAdmin) return adminError();

      // Single presence write-path: SQLite is the store for the metadata,
      // NATS KV only carries the liveness flag.
      await presence.touch(agentName, {
        role: params.role,
        capabilities: params.capabilities,
        working_on: params.working_on,
      });

      return ok({
        agent: agentName,
        registered: true,
        inbox_pending: await pendingCount(ctx),
      });
    },
  );
}
