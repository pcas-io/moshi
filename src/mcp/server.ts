import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import { VERSION } from "../types.ts";
import type { NatsService } from "../services/nats.ts";
import type { AgentService } from "../services/agent.ts";
import type { ActivityService } from "../services/activity.ts";
import type { RateLimiter } from "../services/ratelimit.ts";
import type { PresenceService } from "../services/presence.ts";
import { registerMessagingTools } from "./tools/messaging.ts";
import { registerRegistryTools } from "./tools/registry.ts";
import { registerHistoryTools } from "./tools/history.ts";

export function createMcpServer(
  nats: NatsService,
  agents: AgentService,
  activity: ActivityService,
  rateLimiter: RateLimiter,
  presence: PresenceService,
  agentName: string,
  db: Database.Database,
): McpServer {
  const server = new McpServer(
    {
      name: "moshi",
      version: VERSION,
    },
    {
      instructions: [
        "moshi enables async communication between AI agents via message passing.",
        "Use mesh_send to send messages to other agents. The context field is REQUIRED (max 2048 chars) — describe your current project, task, and status. Payload max is 256 KB.",
        "Use mesh_receive to check for new messages. Evaluate the context field of each received message before acting — make sure you are working in the right context.",
        "Use mesh_reply to respond to a specific message (threading is automatic).",
        "Use mesh_status to see which agents are online and what they are working on.",
        "Use mesh_register to announce your role, capabilities, and current task.",
        "Use mesh_history to view the full conversation thread for a correlation_id.",
      ].join(" "),
    },
  );

  registerMessagingTools(server, nats, agents, activity, rateLimiter, agentName, db);
  registerRegistryTools(server, nats, agents, presence, agentName);
  registerHistoryTools(server, db);

  return server;
}
