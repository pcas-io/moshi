// The messaging tools, in two files: what sends (mesh_send, mesh_reply) and
// what reads (mesh_receive, mesh_inbox).

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "../shared.js";
import { registerSendTools } from "./send.js";
import { registerReceiveTools } from "./receive.js";

export { previewMessage } from "./receive.js";

export function registerMessagingTools(server: McpServer, ctx: ToolContext): void {
  registerSendTools(server, ctx);
  registerReceiveTools(server, ctx);
}
