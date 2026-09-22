import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { VERSION, DEFAULT_PREVIEW_CHARS } from "../types.js";
import type { ToolContext } from "./shared.js";
import { inboxKeyOf } from "../services/agent.js";
import { registerMessagingTools } from "./tools/messaging.js";
import { registerRegistryTools } from "./tools/registry.js";
import { registerHistoryTools } from "./tools/history.js";

export type { ToolContext, MeshNats } from "./shared.js";

const ADMIN_INSTRUCTIONS =
  "NOTE: this connection uses the ADMIN token. The admin is an operator identity, not an agent: " +
  "mesh_send, mesh_receive, mesh_inbox, mesh_reply and mesh_register are refused. Create an agent in the " +
  "dashboard (/agents) and reconnect with its bt_ token to take part in the mesh. " +
  "mesh_status, mesh_history and mesh_get work as read-only observation tools.";

/** What a caller hands in. `inboxKey` is optional: the HTTP route already
 *  looked the agent up (it needs the key for `ensureConsumer`) and passes
 *  it along; everyone else gets it resolved here. */
export type McpServerDeps = Omit<ToolContext, "inboxKey"> & { inboxKey?: string };

function resolveInboxKey(deps: McpServerDeps): string {
  if (deps.inboxKey !== undefined) return deps.inboxKey;
  if (deps.isAdmin) return "";
  const row = deps.agents.getByName(deps.agentName);
  // Never guess an address from a name: with names and keys decoupled the
  // guess can be another agent's inbox, and mesh_receive acks what it pulls.
  if (!row) throw new Error(`No agent record for "${deps.agentName}" — refusing to guess an inbox.`);
  return inboxKeyOf(row);
}

export function createMcpServer(deps: McpServerDeps): McpServer {
  const ctx: ToolContext = { ...deps, inboxKey: resolveInboxKey(deps) };
  const instructions = [
    "moshi enables async communication between AI agents via message passing.",
    "Use mesh_send to send messages to other agents. The context field is REQUIRED (max 2048 chars) — describe your current project, task, and status. Payload max is 256 KB. type defaults to 'info'. correlation_id continues an existing thread and has to name one.",
    "If a send answers that delivery could not be confirmed, send the same message again with the message_id it names (resend_id for a reply): the recipient gets it once.",
    "Use mesh_receive to check for new messages. Reading acknowledges them. Evaluate the context field of each received message before acting — make sure you are working in the right context.",
    "Use mesh_inbox to look at your latest mail without acknowledging anything, for example when an answer of mesh_receive got lost: read_at says what was handed out already.",
    `Every reply carries inbox_pending (messages waiting for you; your own broadcasts are not among them) — only call mesh_receive when it is > 0. Payloads longer than ${DEFAULT_PREVIEW_CHARS} chars arrive truncated (payload_truncated=true); mesh_get(message_id) returns the full text.`,
    "Use mesh_reply to respond to a specific message (threading is automatic).",
    "Use mesh_status to see which agents are online and what they are working on.",
    "Use mesh_register once per session to announce your role, capabilities, and current task.",
    "Use mesh_history with any message id of a thread to read the whole thread.",
  ];
  if (ctx.isAdmin) instructions.push(ADMIN_INSTRUCTIONS);

  const server = new McpServer(
    { name: "moshi", version: VERSION },
    { instructions: instructions.join(" ") },
  );

  registerMessagingTools(server, ctx);
  registerRegistryTools(server, ctx);
  registerHistoryTools(server, ctx);

  return server;
}
