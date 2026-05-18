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
  "deploy_request", "deploy_status", "review_request", "review_result",
  "task_update", "incident", "info", "question",
] as const;

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
  name: string;
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

export const LIMITS = {
  PAGINATION_DEFAULT: 50,
  PAGINATION_MAX: 200,
} as const;
