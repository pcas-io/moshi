import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type Database from "better-sqlite3";
import type { NatsService } from "../../services/nats.ts";
import type { AgentService } from "../../services/agent.ts";
import type { ActivityService } from "../../services/activity.ts";
import type { RateLimiter } from "../../services/ratelimit.ts";
import type { Message } from "../../types.ts";
import { MESSAGE_PRIORITIES } from "../../types.ts";
import {
  createMessage,
  isMessageExpired,
  deserializeMessage,
  sendAndPersistMessage,
} from "../../services/message.ts";
import { log } from "../../services/logger.ts";

function ok(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function error(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true as const,
  };
}

export function registerMessagingTools(
  server: McpServer,
  nats: NatsService,
  agents: AgentService,
  activity: ActivityService,
  rateLimiter: RateLimiter,
  agentName: string,
  db: Database.Database,
): void {
  // ── mesh_send ─────────────────────────────────────────────────
  server.tool(
    "mesh_send",
    "Send a message to another agent or broadcast to all agents. The context field is REQUIRED — describe your current project, task, and status so the recipient understands your situation.",
    {
      to: z.string().describe("Target agent name, or 'broadcast' for all agents"),
      type: z.string().describe("Message type (e.g. deploy_request, question, info, task_update)"),
      payload: z.string().max(262144).describe("Message content (max 256 KB)"),
      context: z.string().max(2048).describe("Your current project, task, and status (max 2048 chars) — REQUIRED for recipient to understand your situation"),
      correlation_id: z.string().optional().describe("Thread ID to continue an existing conversation"),
      priority: z.enum(MESSAGE_PRIORITIES).optional().describe("Message priority (low, normal, high)"),
      ttl_seconds: z.number().optional().describe("Delivery deadline in seconds (default: 86400 = 24h). After expiry, mesh_receive silently drops the message — but it remains in history until the 30-day DB rotation."),
    },
    async (params) => {
      // Rate limit check
      const rateCheck = rateLimiter.check(agentName);
      if (!rateCheck.allowed) {
        return error(
          `Rate limit exceeded. Wait ${rateCheck.retryAfterSeconds} seconds before retrying.`,
        );
      }

      // Validate target agent (unless broadcast)
      if (params.to !== "broadcast") {
        const targetAgent = agents.getByName(params.to);
        if (!targetAgent || !targetAgent.is_active) {
          return error(
            `Agent "${params.to}" not found. Use mesh_status to see available agents.`,
          );
        }
      }

      // Create message
      const msg = createMessage({
        from: agentName,
        to: params.to,
        type: params.type,
        payload: params.payload,
        context: params.context,
        correlation_id: params.correlation_id,
        priority: params.priority,
        ttl_seconds: params.ttl_seconds,
      });

      // Dual-write: NATS first (delivery), DB second (history).
      // See Mesh-ADR-006. If NATS publish fails nothing is written to the
      // DB — no phantom-send. If the DB insert fails after NATS succeeds
      // the message is still delivered and we loud-log the history gap.
      const subject =
        params.to === "broadcast"
          ? "mesh.broadcast"
          : `mesh.agents.${params.to.toLowerCase()}.inbox`;
      const result = await sendAndPersistMessage(nats, db, msg, subject);
      if (!result.delivered) {
        return error(
          `nats_unavailable: message not delivered. Retry in a few seconds.`,
        );
      }

      // Presence is already refreshed by authMiddleware on this request
      // via PresenceService.touch — no need to touch NATS KV again here.

      // Log activity
      activity.logAsync({
        action: "message_sent",
        entity_type: "message",
        entity_id: msg.id,
        summary: `${agentName} → ${params.to} [${params.type}]`,
        agent_name: agentName,
      });

      return ok({
        id: msg.id,
        to: msg.to,
        type: msg.type,
        created_at: msg.created_at,
      });
    },
  );

  // ── mesh_receive ──────────────────────────────────────────────
  server.tool(
    "mesh_receive",
    "Check for new messages in your inbox. Returns unread messages from other agents and broadcasts.",
    {
      limit: z.number().min(1).max(50).optional().describe("Max messages to fetch (default: 10, max: 50)"),
      type: z.string().optional().describe("Filter by message type (e.g. 'question', 'deploy_request')"),
    },
    async (params) => {
      const limit = params.limit ?? 10;

      // Pull from NATS. C4: NATS unavailability degrades gracefully —
      // return an empty inbox with a hint so the caller knows to retry.
      let pulled: Awaited<ReturnType<typeof nats.pullMessages>>;
      try {
        pulled = await nats.pullMessages(agentName, limit);
      } catch (err) {
        log("warn", "nats pull failed in mesh_receive", {
          agent: agentName,
          err: String(err),
        });
        return ok({ messages: [], hint: "nats_unavailable, retry shortly" });
      }

      const messages: Message[] = [];

      for (const pm of pulled) {
        let msg: Message;
        try {
          msg = deserializeMessage(pm.data);
        } catch {
          // Unparseable message — ack and skip
          pm.ack();
          continue;
        }

        // Check TTL — expired messages are silently acked
        if (isMessageExpired(msg)) {
          pm.ack();
          continue;
        }

        // Type filter — non-matching messages are NOT acked (remain in queue)
        if (params.type && msg.type !== params.type) {
          continue;
        }

        // Valid message — ack and collect
        pm.ack();
        messages.push(msg);
      }

      // Presence is already refreshed by authMiddleware for this request.

      if (messages.length === 0) {
        return ok({ messages: [], hint: "No new messages." });
      }

      return ok({ messages, count: messages.length });
    },
  );

  // ── mesh_reply ────────────────────────────────────────────────
  server.tool(
    "mesh_reply",
    "Reply to a specific message. Threading is automatic — the reply is linked to the original conversation thread.",
    {
      message_id: z.string().describe("ID of the message to reply to"),
      payload: z.string().max(262144).describe("Reply content (max 256 KB)"),
      context: z.string().max(2048).describe("Your current project, task, and status (max 2048 chars)"),
    },
    async (params) => {
      // Rate limit check
      const rateCheck = rateLimiter.check(agentName);
      if (!rateCheck.allowed) {
        return error(
          `Rate limit exceeded. Wait ${rateCheck.retryAfterSeconds} seconds before retrying.`,
        );
      }

      // Look up original message
      const original = db
        .prepare("SELECT * FROM messages WHERE id = ?")
        .get(params.message_id) as
        | {
            id: string;
            from_agent: string;
            to_agent: string;
            type: string;
            correlation_id: string | null;
          }
        | undefined;

      if (!original) {
        return error(`Message not found: ${params.message_id}`);
      }

      // Determine thread root
      const threadRoot = original.correlation_id ?? original.id;

      // Create reply message
      const msg = createMessage({
        from: agentName,
        to: original.from_agent,
        type: "reply",
        payload: params.payload,
        context: params.context,
        correlation_id: threadRoot,
        reply_to: params.message_id,
      });

      // Dual-write: NATS first (delivery), DB second (history).
      // Same reliability semantics as mesh_send — see Mesh-ADR-006.
      const subject = `mesh.agents.${original.from_agent.toLowerCase()}.inbox`;
      const result = await sendAndPersistMessage(nats, db, msg, subject);
      if (!result.delivered) {
        return error(
          `nats_unavailable: reply not delivered. Retry in a few seconds.`,
        );
      }

      // Presence is already refreshed by authMiddleware for this request.

      // Log activity
      activity.logAsync({
        action: "message_sent",
        entity_type: "message",
        entity_id: msg.id,
        summary: `${agentName} → ${original.from_agent} [reply to ${params.message_id}]`,
        agent_name: agentName,
      });

      return ok({
        id: msg.id,
        to: msg.to,
        type: msg.type,
        correlation_id: msg.correlation_id,
        reply_to: msg.reply_to,
        created_at: msg.created_at,
      });
    },
  );
}
