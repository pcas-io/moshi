import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type Database from "better-sqlite3";

function ok(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

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

export function registerHistoryTools(
  server: McpServer,
  db: Database.Database,
): void {
  // ── mesh_history ──────────────────────────────────────────────
  server.tool(
    "mesh_history",
    "View the full conversation thread for a given correlation_id. Returns messages in chronological order.",
    {
      correlation_id: z.string().describe("The correlation ID (thread root) to look up"),
      limit: z.number().min(1).max(200).optional().describe("Max messages to return (default: 50)"),
    },
    { readOnlyHint: true },
    async (params) => {
      const limit = params.limit ?? 50;

      const rows = db
        .prepare(
          `SELECT * FROM messages
           WHERE correlation_id = ? OR id = ?
           ORDER BY created_at ASC
           LIMIT ?`,
        )
        .all(params.correlation_id, params.correlation_id, limit) as MessageRow[];

      if (rows.length === 0) {
        return ok({
          messages: [],
          hint: "No messages found for this thread.",
        });
      }

      const messages = rows.map((row) => ({
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
      }));

      return ok({ messages, count: messages.length });
    },
  );
}
