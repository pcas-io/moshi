// The admin's webhook form on /agents: set, refuse, show the made-up secret
// once, remove. Real AgentService and WebhookService on in-memory SQLite.

import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import type { AppVariables, Env, RequestAgent } from "../../src/types";
import { generateCsrfToken } from "../../src/auth";
import { initDatabase } from "../../src/services/db";
import { AgentService } from "../../src/services/agent";
import { ActivityService } from "../../src/services/activity";
import { WebhookService } from "../../src/services/webhooks";
import type { Resolved } from "../../src/services/webhook-target";
import { getFlash } from "../../src/services/flash";
import { createAgentWebhookRoutes } from "../../src/routes/agent-webhook";
import { V2AgentsPage, type V2AgentsAgent } from "../../src/views/v2/agents";

const SECRET = "test-cookie-secret";
const BINDING = "session:admin::test";
const ADMIN: RequestAgent = { name: "admin", role: "admin" };
const NON_ADMIN: RequestAgent = { name: "kate", role: "agent" };
const URL_ = "https://hooks.example.com/trigger/kate";

let agents: AgentService;
let webhooks: WebhookService;
let kateId: string;

const resolve = async (host: string): Promise<Resolved> =>
  host === "hooks.example.com"
    ? { ok: true, address: "93.184.215.14", family: 4 }
    : { ok: false, retryable: false, reason: "target_not_public" };

beforeEach(() => {
  const db = initDatabase(":memory:");
  const activity = new ActivityService(db);
  agents = new AgentService(db, activity);
  kateId = agents.create("kate").agent.id;
  webhooks = new WebhookService(db, "route-test-key-material-0123456789", activity, resolve);
});

function post(who: RequestAgent | null, path: string, fields: Record<string, string>) {
  const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
  app.use("*", async (c, next) => {
    c.env = { NATS_URL: "nats://x", MESH_ADMIN_TOKEN: "a".repeat(40), MESH_COOKIE_SECRET: SECRET } as Env;
    c.set("agent", who);
    c.set("csrfBinding", BINDING);
    await next();
  });
  app.route("/agents", createAgentWebhookRoutes({ agents, webhooks }));
  return app.request(path, {
    method: "POST",
    body: new URLSearchParams(fields),
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Sec-Fetch-Site": "same-origin" },
  });
}

const csrf = () => generateCsrfToken(SECRET, BINDING);
const flashOf = (res: Response) =>
  getFlash(new URL(res.headers.get("location") ?? "", "http://x").searchParams.get("flash") ?? undefined);

describe("POST /agents/webhook", () => {
  it("refuses a non-admin", async () => {
    const res = await post(NON_ADMIN, "/agents/webhook", { csrf: csrf(), id: kateId, url: URL_ });
    expect(res.status).toBe(403);
    expect(webhooks.get("kate")).toBeNull();
  });

  it("refuses an expired form", async () => {
    const res = await post(ADMIN, "/agents/webhook", { csrf: "stale", id: kateId, url: URL_ });
    expect(flashOf(res)?.error).toMatch(/expired/);
    expect(webhooks.get("kate")).toBeNull();
  });

  it("sets the hook with its filters and hands the made-up secret over once", async () => {
    const res = await post(ADMIN, "/agents/webhook", {
      csrf: csrf(), id: kateId, url: URL_, auth_mode: "standard_webhooks", secret: "",
      types: "review_request, question", min_priority: "normal", include_broadcasts: "1",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toMatch(new RegExp(`^/agents\\?inspect=${kateId}&flash=`));
    expect(flashOf(res)?.webhookSecret).toMatch(/^whsec_/);
    expect(webhooks.get("kate")).toMatchObject({
      url: URL_, include_broadcasts: true, types: ["review_request", "question"], min_priority: "normal", state: "active",
    });
  });

  it("names the reason when the target or the secret is refused", async () => {
    const privateTarget = await post(ADMIN, "/agents/webhook", { csrf: csrf(), id: kateId, url: "https://inner.example.com/t" });
    expect(flashOf(privateTarget)?.error).toMatch(/^Webhook not set: .*not public/);
    const badSecret = await post(ADMIN, "/agents/webhook", { csrf: csrf(), id: kateId, url: URL_, secret: "hunter2" });
    expect(flashOf(badSecret)?.error).toMatch(/^Webhook not set: secret: /);
    expect(webhooks.get("kate")).toBeNull();
  });

  it("removes the hook", async () => {
    webhooks.set("kate", { url: URL_, authMode: "standard_webhooks", includeBroadcasts: false, types: null, minPriority: "low" }, undefined, "admin");
    const res = await post(ADMIN, "/agents/webhook/delete", { csrf: csrf(), id: kateId });
    expect(res.status).toBe(302);
    expect(webhooks.get("kate")).toBeNull();
  });
});

describe("the webhook panel", () => {
  const agent = (over: Partial<V2AgentsAgent> = {}): V2AgentsAgent => ({
    id: kateId, name: "kate", inbox_key: "kate", role: null, capabilities: [], is_active: true, presence: "live",
    msg24: 0, heat: new Array<number>(24).fill(0), working_on: null, last_seen_at: null, created_at: "2026-10-30T15:00:00Z",
    ...over,
  });
  const render = async (props: Parameters<typeof V2AgentsPage>[0]) => String(await Promise.resolve(V2AgentsPage(props)));

  it("shows the URL and state to the admin, and a made-up secret only when handed one", async () => {
    const { view, generatedSecret } = webhooks.set(
      "kate", { url: URL_, authMode: "standard_webhooks", includeBroadcasts: false, types: null, minPriority: "low" }, undefined, "admin",
    );
    const page = await render({ agents: [agent({ webhook: view })], csrfToken: "t", inspectId: kateId, userRole: "admin" });
    expect(page).toContain(URL_);
    expect(page).toContain("Remove webhook");
    expect(page).not.toContain(generatedSecret!);

    const once = await render({ agents: [agent({ webhook: view })], csrfToken: "t", inspectId: kateId, userRole: "admin", webhookSecret: generatedSecret });
    expect(once).toContain(generatedSecret!);
  });

  it("says how an agent without a hook learns about mail", async () => {
    const page = await render({ agents: [agent({ webhook: null })], csrfToken: "t", inspectId: kateId, userRole: "admin" });
    expect(page).toContain("None. It learns about mail by calling mesh_receive.");
    expect(page).toContain("Set webhook");
    expect(page).not.toContain("Remove webhook");
  });
});
