// Renders every Daylight screen to a static HTML file with sample data, so a
// human (or a browser) can look at the real components without a server, a
// database or NATS. Output lands in the directory given as the first argument.
//
//   npx tsx scripts/render-preview.tsx /tmp/preview
//
// Not part of the build or the test run — a reviewer's tool, nothing imports it.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { LoginPage } from "../src/views/login.js";
import { V2HomePage, type V2HomeAgent, type V2HomeProps } from "../src/views/v2/home.js";
import { V2AgentsPage } from "../src/views/v2/agents.js";
import type { V2AgentsAgent } from "../src/views/v2/agents-detail.js";
import { V2ConversationsPage } from "../src/views/v2/conversations.js";
import { V2LogPage } from "../src/views/v2/log.js";
import { renderConnectPage } from "../src/views/v2/connect.js";
import type { ConversationThread, MessageView } from "../src/services/message-queries.js";
import type { Activity, PaginatedResult } from "../src/types.js";

const OUT = process.argv[2] ?? "/tmp/moshi-preview";
mkdirSync(OUT, { recursive: true });

const NOW = new Date("2026-09-12T14:16:00");
const iso = (minutesAgo: number): string =>
  new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();

const ROLES: Record<string, string | null> = {
  "triage-1": "triage-agent", "ops-kai": "dev-ops", "dex-eu": "dev-assistant",
  "sec-warden": "security", "pm-mira": "product-manager", scout: "dev-assistant",
  "qa-bot": "qa", "cortex-local": "cortex-local",
};

const HOME_AGENTS: V2HomeAgent[] = [
  { id: "1", name: "triage-1", role: "triage-agent", presence: "live", msg24: 34, working_on: "watching the error rate on api-gw", last_seen_at: iso(1) },
  { id: "2", name: "ops-kai", role: "dev-ops", presence: "live", msg24: 28, working_on: "rolling out 2026.9.3 to staging", last_seen_at: iso(2) },
  { id: "3", name: "dex-eu", role: "dev-assistant", presence: "live", msg24: 19, working_on: "porting the importer to the new schema", last_seen_at: iso(4) },
  { id: "4", name: "sec-warden", role: "security", presence: "live", msg24: 12, working_on: "auditing pre-rotation tokens", last_seen_at: iso(6) },
  { id: "5", name: "pm-mira", role: "product-manager", presence: "stale", msg24: 6, working_on: "writing up the Q4 scope", last_seen_at: iso(40) },
  { id: "6", name: "qa-bot", role: "qa", presence: "stale", msg24: 4, working_on: null, last_seen_at: iso(55) },
  { id: "7", name: "scout", role: "dev-assistant", presence: "offline", msg24: 0, working_on: "indexing the docs", last_seen_at: iso(4320) },
  { id: "8", name: "cortex-local", role: "cortex-local", presence: "never", msg24: 0, working_on: null, last_seen_at: null },
];

const homeProps: V2HomeProps = {
  stats: { agentsTotal: 8, agentsLive: 4, agentsStale: 2, msg24h: 103, threads: 14, incidents24h: 1 },
  agents: HOME_AGENTS,
  attention: [
    { kind: "stale_agent", agent: "scout", text: "hasn't checked in for 3 days", href: "/agents?presence=off" },
    { kind: "open_incident", agent: "sec-warden", text: "reports 2 agents still on pre-rotation tokens, still unanswered", href: "/conversations" },
  ],
  latestIncident: { openedAt: iso(120), closedBy: "ops-kai", minutesToClose: 12 },
  liveThread: {
    correlation_id: "01J0THREAD",
    context: "api-gw error rate",
    participants: ["triage-1", "ops-kai"],
    messageCount: 9,
    messages: [
      { id: "01J0M1", from: "triage-1", type: "incident", payload: "Error rate on api-gw crossed 2% for five minutes running.", created_at: iso(48) },
      { id: "01J0M2", from: "ops-kai", type: "answer", payload: "Seen it. Rolling back the 2026.9.2 gateway config now.", created_at: iso(44) },
      { id: "01J0M3", from: "triage-1", type: "info", payload: "Rate is back under 0.3%. Closing this out.", created_at: iso(36) },
      { id: "01J0M4", from: "ops-kai", type: "task_update", payload: "Config pinned to 2026.9.1 until the fix lands.", created_at: iso(32) },
    ],
  },
  now: NOW,
  userRole: "admin",
  userName: "admin",
  csrfToken: "preview-csrf",
};

const AGENT_ROWS: V2AgentsAgent[] = HOME_AGENTS.map((a, i) => ({
  id: a.id,
  name: a.name,
  inbox_key: a.name,
  role: a.role,
  capabilities: i % 2 === 0 ? ["typescript", "sql"] : [],
  is_active: a.name !== "scout",
  presence: a.presence,
  msg24: a.msg24,
  heat: Array.from({ length: 24 }, (_, h) => (h % 5 === 0 ? 0 : ((h * (i + 3)) % 7))),
  working_on: a.working_on,
  last_seen_at: a.last_seen_at,
  created_at: iso(60 * 24 * 30),
}));

const thread = (over: Partial<ConversationThread>): ConversationThread => ({
  thread_id: "01J0THREAD",
  participants: ["triage-1", "ops-kai"],
  message_count: 9,
  started_at: iso(48),
  first_payload: "Error rate on api-gw crossed 2% for five minutes running.",
  first_context: "api-gw error rate",
  last_activity: iso(36),
  messages: homeProps.liveThread!.messages.map((m) => ({
    id: m.id, from: m.from, to: m.from === "triage-1" ? "ops-kai" : "triage-1",
    type: m.type, payload: m.payload, context: "api-gw error rate",
    correlation_id: "01J0THREAD", reply_to: null, priority: "normal",
    ttl_seconds: 86400, created_at: m.created_at,
  })) as ConversationThread["messages"],
  ...over,
});

const page = <T,>(data: T[]): PaginatedResult<T> => ({
  data, has_more: false, total: data.length, limit: 50, offset: 0,
});

const MESSAGES: MessageView[] = homeProps.liveThread!.messages.map((m, i) => ({
  id: m.id,
  from: m.from,
  to: i === 3 ? "broadcast" : m.from === "triage-1" ? "ops-kai" : "triage-1",
  type: m.type,
  payload: m.payload,
  context: "api-gw error rate",
  correlation_id: "01J0THREAD",
  reply_to: null,
  priority: i === 0 ? "high" : "normal",
  ttl_seconds: 86400,
  created_at: m.created_at,
})) as MessageView[];

const EVENTS: Activity[] = [
  // Summaries exactly as the services write them — the sentence mapping
  // parses these, and a null summary is the documented raw-action fallback.
  { id: "a1", action: "message_sent", entity_type: "message", entity_id: "01J0M1", summary: "triage-1 → ops-kai [incident]", agent_name: "triage-1", created_at: iso(48) },
  { id: "a2", action: "auth_login", entity_type: "session", entity_id: "admin", summary: "admin authenticated (admin)", agent_name: "admin", created_at: iso(90) },
  { id: "a3", action: "agent_created", entity_type: "agent", entity_id: "8", summary: 'Agent "cortex-local" created', agent_name: "admin", created_at: iso(200) },
  { id: "a4", action: "agent_token_reset", entity_type: "agent", entity_id: "5", summary: 'Token reset for agent "pm-mira"', agent_name: "admin", created_at: iso(260) },
  { id: "a5", action: "auth_login", entity_type: "session", entity_id: "dex-eu", summary: "dex-eu authenticated (agent)", agent_name: "dex-eu", created_at: iso(300) },
  { id: "a6", action: "message_sent", entity_type: "message", entity_id: "01J0M4", summary: "ops-kai → broadcast [task_update]", agent_name: "ops-kai", created_at: iso(320) },
];

async function dump(name: string, node: unknown): Promise<void> {
  const html = String(await Promise.resolve(node));
  writeFileSync(join(OUT, `${name}.html`), html, "utf-8");
  console.log(`${name}.html  ${html.length} bytes`);
}

const shared = { agentRoles: ROLES, userRole: "admin", userName: "admin", csrfToken: "preview-csrf" };

await dump("01-login", LoginPage({ csrfToken: "preview-csrf" }));
await dump("02-login-error", LoginPage({ csrfToken: "preview-csrf", error: true }));
await dump("03-home", V2HomePage(homeProps));
await dump("04-home-empty", V2HomePage({
  ...homeProps, agents: [], attention: [], liveThread: null, latestIncident: null,
  stats: { agentsTotal: 0, agentsLive: 0, agentsStale: 0, msg24h: 0, threads: 0, incidents24h: 0 },
}));
await dump("05-agents", V2AgentsPage({ agents: AGENT_ROWS, csrfToken: "preview-csrf", userRole: "admin", userName: "admin", inspectId: "2" }));
await dump("06-agents-token", V2AgentsPage({ agents: AGENT_ROWS, csrfToken: "preview-csrf", userRole: "admin", userName: "admin", newToken: "bt_7f3c9a1e5d2b8460af12" }));
await dump("07-agents-empty", V2AgentsPage({ agents: [], csrfToken: "preview-csrf", userRole: "admin", userName: "admin" }));
await dump("08-conversations", V2ConversationsPage({ opened: null, result: page([thread({}), thread({ thread_id: "t2", participants: ["pm-mira", "broadcast"], last_activity: iso(3000) })]), ...shared }));
await dump("09-log-messages", V2LogPage({ tab: "messages", messages: page(MESSAGES), routing: "all", ...shared }));
await dump("10-log-audit", V2LogPage({
  tab: "audit", events: page(EVENTS),
  topActors: [{ agent_name: "triage-1", count: 34 }, { agent_name: "admin", count: 12 }, { agent_name: "dex-eu", count: 7 }],
  routing: "all", ...shared,
}));

const connectBase = {
  origin: "https://moshi.enki.run",
  csrfToken: "preview-csrf",
  userRole: "admin",
  userName: "admin",
} as const;
await dump("11-connect-1", await renderConnectPage({ ...connectBase, step: 1, client: "code" }));
await dump("12-connect-2", await renderConnectPage({ ...connectBase, step: 2, client: "code", sessionKey: "k", agentName: "dex-eu", token: "bt_7f3c9a1e5d2b8460af12" }));
await dump("13-connect-3", await renderConnectPage({ ...connectBase, step: 3, client: "desktop", sessionKey: "k", agentName: "dex-eu", token: "bt_7f3c9a1e5d2b8460af12" }));
await dump("14-connect-4", await renderConnectPage({ ...connectBase, step: 4, client: "cli", sessionKey: "k", agentName: "dex-eu", token: "bt_7f3c9a1e5d2b8460af12" }));

console.log(`\nWrote ${OUT}`);
