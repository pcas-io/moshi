import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type Database from "better-sqlite3";
import { ok, error } from "../shared.js";
import type { ToolContext } from "../shared.js";
import { FIELD_LIMITS } from "../../types.js";
import { resolveThreadRoot } from "../../services/message-queries.js";

interface MessageRow {
  id: string;
  from_agent: string;
  to_agent: string;
  type: string;
  payload: string;
  context: string;
  correlation_id: string | null;
  reply_to: string | null;
  priority: string;
  ttl_seconds: number;
  created_at: string;
}

function rowToMessage(row: MessageRow) {
  return {
    id: row.id,
    from: row.from_agent,
    to: row.to_agent,
    type: row.type,
    payload: row.payload,
    context: row.context,
    correlation_id: row.correlation_id,
    reply_to: row.reply_to,
    priority: row.priority,
    ttl_seconds: row.ttl_seconds,
    created_at: row.created_at,
  };
}

export function registerHistoryTools(server: McpServer, ctx: ToolContext): void {
  const { db } = ctx;

  // ── mesh_history ──────────────────────────────────────────────
  server.tool(
    "mesh_history",
    "View the full conversation thread a message belongs to. Accepts any message id of the thread (root or reply). Returns messages in chronological order.",
    {
      correlation_id: z.string().max(FIELD_LIMITS.ID).describe("Any message id of the thread — the root id (= correlation_id) or a reply id"),
      limit: z.number().int().min(1).max(200).optional().describe("Max messages to return (default: 50)"),
    },
    { readOnlyHint: true },
    async (params) => {
      const limit = params.limit ?? 50;
      const root = resolveThreadRoot(db, params.correlation_id);

      const rows = db
        .prepare(
          `SELECT * FROM messages
           WHERE correlation_id = ? OR id = ?
           ORDER BY created_at ASC
           LIMIT ?`,
        )
        .all(root, root, limit) as MessageRow[];

      if (rows.length === 0) {
        return ok({
          messages: [],
          hint: "No messages found for this thread.",
        });
      }

      const messages = rows.map(rowToMessage);
      return ok({ thread_id: root, messages, count: messages.length });
    },
  );

  // ── mesh_get ──────────────────────────────────────────────────
  server.tool(
    "mesh_get",
    "Fetch one message with its complete payload — use it after mesh_receive returned a truncated preview (payload_truncated=true).",
    {
      message_id: z.string().max(FIELD_LIMITS.ID).describe("The message id (msg_…) from mesh_receive or mesh_history"),
    },
    { readOnlyHint: true },
    async (params) => {
      const row = db
        .prepare("SELECT * FROM messages WHERE id = ?")
        .get(params.message_id) as MessageRow | undefined;
      if (!row) {
        return error(
          `Message not found: ${params.message_id} (history is kept for 30 days).`,
        );
      }
      return ok(rowToMessage(row));
    },
  );
}
