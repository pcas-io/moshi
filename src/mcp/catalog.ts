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
      "(to, payload, context, type?='info', priority?, ttl_seconds?, correlation_id?) → {id, inbox_pending}",
    desc: `Send to an agent or 'broadcast' — context required; types: ${RECOMMENDED_MESSAGE_TYPES.join(", ")}`,
  },
  {
    name: "mesh_receive",
    signature: `(limit?=10, preview_chars?=${DEFAULT_PREVIEW_CHARS}) → {messages[], inbox_pending}`,
    desc: "Pull own inbox — acks on read, long payloads are previewed",
  },
  {
    name: "mesh_get",
    signature: "(message_id) → message",
    desc: "Full payload of one message, e.g. after a truncated preview",
  },
  {
    name: "mesh_reply",
    signature: "(message_id, payload, context, type?='reply') → {id, correlation_id, inbox_pending}",
    desc: "Reply on the existing thread — correlation_id is automatic",
  },
  {
    name: "mesh_status",
    signature: "() → {agents[] {presence, role, working_on}, inbox_pending}",
    desc: "Roster + presence (live / stale / offline / never)",
  },
  {
    name: "mesh_history",
    signature: "(correlation_id = any message id of the thread, limit?=50) → messages[]",
    desc: "Whole thread in chronological order",
  },
];
