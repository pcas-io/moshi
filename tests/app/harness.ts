// App-level harness: the real Hono app from createApp(), wired to the same
// in-memory SQLite and fake NATS the MCP harness uses. What is under test
// here is the wiring — middleware order, mounts, headers — which no test
// could reach while src/index.tsx ran config loading and start() on import.

import { vi } from "vitest";
import { createApp } from "../../src/app";
import type { AppNats } from "../../src/app";
import type { Config } from "../../src/config";
import { createHarness } from "../mcp/harness";
import type { Harness } from "../mcp/harness";

export const ADMIN_TOKEN = "a".repeat(40);

export const TEST_CONFIG: Config = {
  meshAdminToken: ADMIN_TOKEN,
  meshAdminTokenPrevious: undefined,
  meshCookieSecret: "c".repeat(32),
  oauthSecret: "o".repeat(32),
  natsUrl: "nats://test.invalid:4222",
  databasePath: ":memory:",
  port: 0,
  isProduction: false,
  cookieSecure: false,
};

export interface TestApp {
  app: ReturnType<typeof createApp>;
  h: Harness;
  /** Inbox keys ensureConsumer was called with, in order. */
  ensured: string[];
  natsUp: { value: boolean };
  touch: ReturnType<typeof vi.spyOn>;
}

export function createTestApp(config: Partial<Config> = {}, extra: { now?: () => number } = {}): TestApp {
  const h = createHarness();
  const ensured: string[] = [];
  const natsUp = { value: true };
  const nats: AppNats = Object.assign(h.nats, {
    ping: async () => natsUp.value,
    ensureConsumer: async (inboxKey: string) => { ensured.push(inboxKey); },
  });
  const touch = vi.spyOn(h.presence, "touch");
  const app = createApp({
    config: { ...TEST_CONFIG, ...config },
    db: h.db, nats, agents: h.agents, activity: h.activity, presence: h.presence, rateLimiter: h.rateLimiter,
    now: extra.now,
  });
  return { app, h, ensured, natsUp, touch };
}

export const MCP_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
} as const;

export const rpc = (method: string, params: unknown, id = 1) =>
  JSON.stringify({ jsonrpc: "2.0", id, method, params });
