// Human-readable reference of the MCP tools moshi exposes. Single source
// of truth for the dashboard ⌘K palette and for `tests/mcp/catalog.test.ts`,
// which asserts that every registered tool is listed here (and nothing
// else) so the on-screen signatures can no longer drift from the code.

import { DEFAULT_PREVIEW_CHARS, RECOMMENDED_MESSAGE_TYPES } from "../types.js";

export interface McpToolRef {
  name: string;
  /** Compact signature line — parameters (defaults) → result. */
  signature: string;
  /** One-line purpose. */
  desc: string;
}

export const MCP_TOOL_CATALOG: readonly McpToolRef[] = [
  {
    name: "mesh_register",
    signature: "(role?, capabilities?, working_on?) → {registered, inbox_pending}",
    desc: "Announce role, capabilities and current task so others can find you",
  },
  {
    name: "mesh_send",
    signature:
      "(to, payload, context, type?='info', priority?, ttl_seconds?, correlation_id?, message_id?) → {id, expires_at, inbox_pending}",
    desc: `Send to an agent or 'broadcast' — context required; types: ${RECOMMENDED_MESSAGE_TYPES.join(", ")}`,
  },
  {
    name: "mesh_receive",
    signature: `(limit?=10, preview_chars?=${DEFAULT_PREVIEW_CHARS}) → {messages[], inbox_pending, expired_dropped?}`,
    desc: "Pull its own inbox — reading acks, long payloads arrive previewed, own broadcasts and expired messages never show up",
  },
  {
    name: "mesh_inbox",
    signature: `(limit?=10, unread_only?=false, preview_chars?=${DEFAULT_PREVIEW_CHARS}) → {messages[] {read_at, expires_at, expired?}, unread, never_handed_out, inbox_pending}`,
    desc: "Look without taking: the latest mail from the history, with when mesh_receive handed it out — for an answer that got lost; unread is what can still be handed out",
  },
  {
    name: "mesh_get",
    signature: "(message_id) → message",
    desc: "Full payload of one message, e.g. after a truncated preview — and whether it was read (read_at, read_by)",
  },
  {
    name: "mesh_reply",
    signature: "(message_id, payload, context, type?='reply', resend_id?) → {id, correlation_id, expires_at, inbox_pending}",
    desc: "Reply on the existing thread — correlation_id is automatic, a reply to your own message goes to whoever it was for",
  },
  {
    name: "mesh_status",
    signature: "() → {agents[] {presence, role, working_on}, inbox_pending}",
    desc: "Who is around: online, quiet, asleep, never seen",
  },
  {
    name: "mesh_history",
    signature: "(correlation_id = any message id of the thread, limit?=50) → messages[]",
    desc: "Whole thread in chronological order",
  },
];
