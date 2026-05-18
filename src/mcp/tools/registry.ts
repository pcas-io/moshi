import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { NatsService } from "../../services/nats.ts";
import type { AgentService } from "../../services/agent.ts";
import type { PresenceService } from "../../services/presence.ts";

function ok(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

export function registerRegistryTools(
  server: McpServer,
  nats: NatsService,
  agents: AgentService,
  presence: PresenceService,
  agentName: string,
): void {
  // ── mesh_status ───────────────────────────────────────────────
  server.tool(
    "mesh_status",
    "See which agents are online and what they are working on. No parameters needed.",
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
        role: e.liveMeta?.role ?? e.agent.role ?? null,
        capabilities:
          e.liveMeta?.capabilities ??
          (e.agent.capabilities ? JSON.parse(e.agent.capabilities) : null),
        is_active: e.agent.is_active === 1,
        // `online` kept for backward compatibility — equivalent to presence === "live"
        online: e.presence === "live",
        presence: e.presence,
        working_on: e.liveMeta?.working_on ?? e.agent.working_on ?? null,
        last_seen_at: e.effectiveLastSeen,
      }));

      return ok({ agents: agentList, count: agentList.length });
    },
  );

  // ── mesh_register ─────────────────────────────────────────────
  server.tool(
    "mesh_register",
    "Announce your role, capabilities, and current task so other agents can discover you.",
    {
      role: z.string().optional().describe("Your role (e.g. 'deploy-agent', 'code-reviewer')"),
      capabilities: z.array(z.string()).optional().describe("List of capabilities (e.g. ['deploy', 'rollback', 'monitor'])"),
      working_on: z.string().optional().describe("What you are currently working on"),
    },
    async (params) => {
      // Single presence write-path: SQLite + NATS KV updated atomically
      // (from the caller's perspective). NATS KV failures are logged
      // internally by the service and never surface here.
      await presence.touch(agentName, {
        role: params.role,
        capabilities: params.capabilities,
        working_on: params.working_on,
      });

      return ok({
        agent: agentName,
        registered: true,
        role: params.role ?? null,
        capabilities: params.capabilities ?? null,
        working_on: params.working_on ?? null,
      });
    },
  );
}
