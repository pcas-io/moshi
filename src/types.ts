// === Environment ===
export interface Env {
  NATS_URL: string;
  MESH_ADMIN_TOKEN: string;
  MESH_ADMIN_TOKEN_PREVIOUS?: string;
  MESH_COOKIE_SECRET?: string;
  OAUTH_SECRET?: string;
  DATABASE_PATH?: string;
}

// === Constants ===
export const VERSION = "1.0.0";

export const MESSAGE_PRIORITIES = ["low", "normal", "high"] as const;
export type MessagePriority = (typeof MESSAGE_PRIORITIES)[number];

export const DEFAULT_TTL_SECONDS = 86400; // 24h
export const MAX_PAYLOAD_BYTES = 262144; // 256 KB
export const MAX_CONTEXT_LENGTH = 2048; // 2048 chars
export const RATE_LIMIT_PER_MINUTE = 60;
export const PRESENCE_TTL_SECONDS = 600; // 10 min
export const MAX_AGENTS = 100;
export const MESSAGE_RETENTION_DAYS = 30;
export const ACTIVITY_RETENTION_DAYS = 90;

export const RECOMMENDED_MESSAGE_TYPES = [
  "info", "question", "incident", "task_update",
  "deploy_request", "deploy_status", "review_request", "review_result", "script",
] as const;
export const DEFAULT_MESSAGE_TYPE = "info";
export const REPLY_MESSAGE_TYPE = "reply";

/** `mesh_receive` returns at most this many payload chars per message
 *  unless the caller asks for more — full text via `mesh_get`. */
export const DEFAULT_PREVIEW_CHARS = 4000;
export const MIN_PREVIEW_CHARS = 100;

// === Message Envelope ===
export interface Message {
  id: string;
  from: string;
  to: string;
  type: string;
  payload: string;
  context: string;
  correlation_id: string | null;
  reply_to: string | null;
  priority: MessagePriority;
  ttl_seconds: number;
  created_at: string;
}

// === Agent ===
export interface Agent {
  id: string;
  /** Display name and the handle other agents address. Can be renamed. */
  name: string;
  /** Immutable NATS address token — subject and durable names derive from
   *  it, never from `name`. See migrations/0005_agent_inbox_key.sql. */
  inbox_key: string;
  /** When the agent took its current `name` (ISO-8601). Bounds the history
   *  rewrite of a rename: earlier rows belong to another holder of the name. */
  name_since: string;
  /** From when on the stream's messages are for this agent (ISO-8601): its
   *  creation, or its last reactivation. New durables start there, and a
   *  durable older than this belongs to a predecessor with the same key.
   *  See migrations/0008_agent_inbox_since.sql. */
  inbox_since: string;
  role: string | null;
  capabilities: string | null; // JSON array stored as string
  token_hash: string;
  is_active: number;
  avatar: string | null;
  working_on: string | null;
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface RequestAgent {
  name: string;
  role: "agent" | "admin";
  /** The agent's immutable NATS address, read from its record at auth time.
   *  Absent for the admin, who has no inbox. Routes must use this and never
   *  derive an address from `name`: a name can change mid-request, and once
   *  names and keys are decoupled a guessed key can be someone else's inbox. */
  inbox_key?: string;
  /** `agents.inbox_since`, read with the key. Where this agent's durables start. */
  inbox_since?: string;
}

// === Activity ===
export interface Activity {
  id: string;
  action: string;
  entity_type: string;
  entity_id: string;
  summary: string | null;
  agent_name: string | null;
  created_at: string;
}

// === Hono App Variables ===
export interface AppVariables {
  agent: RequestAgent | null;
  csrfToken: string;
}

// === Pagination ===
export interface PaginatedResult<T> {
  data: T[];
  has_more: boolean;
  total: number;
  limit: number;
  offset: number;
}

/** Upper bounds for free-text tool fields. Only the 512 KB body limit used
 *  to cap them — a 500 KB `working_on` is echoed to every agent in every
 *  mesh_status reply and rendered on every dashboard load. */
export const FIELD_LIMITS = {
  TYPE: 64,
  ID: 64,
  AGENT_NAME: 64,
  ROLE: 64,
  WORKING_ON: 512,
  CAPABILITIES: 32,
  CAPABILITY: 64,
  /** JetStream keeps a message for seven days; a longer deadline is a lie. */
  TTL_SECONDS_MAX: 7 * 24 * 60 * 60,
} as const;

export const LIMITS = {
  PAGINATION_DEFAULT: 50,
  PAGINATION_MAX: 200,
} as const;
