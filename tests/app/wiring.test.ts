// The order things are mounted in is behaviour. Two defects of exactly this
// kind reached review in September 2026 with a green suite, because nothing
// could import the app: a 405 guard that has to sit in front of auth, and a
// body limit that has to sit behind it.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestApp, ADMIN_TOKEN, MCP_HEADERS, rpc } from "./harness";
import type { TestApp } from "./harness";
import { generateCsrfToken } from "../../src/auth";
import { TEST_CONFIG } from "./harness";

let t: TestApp;
let agentToken: string;
beforeEach(() => {
  t = createTestApp();
  agentToken = t.h.agents.create("alpha").plaintextToken;
  t.h.agents.create("beta");
});

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

describe("/mcp — guard, auth, limit, in that order", () => {
  it("answers 405 to an anonymous GET without touching presence or NATS", async () => {
    const res = await t.app.request("/mcp", { headers: { Accept: "text/event-stream" } });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
    expect(t.touch).not.toHaveBeenCalled();
    expect(t.ensured).toEqual([]);
  });

  it("answers 405 to a GET that carries a valid token, still without a presence write", async () => {
    const res = await t.app.request("/mcp", { headers: { Accept: "text/event-stream", ...bearer(agentToken) } });
    expect(res.status).toBe(405);
    expect(t.touch).not.toHaveBeenCalled();
  });

  it("answers 401 with the OAuth discovery pointer to an anonymous POST", async () => {
    const res = await t.app.request("/mcp", { method: "POST", headers: MCP_HEADERS, body: rpc("tools/list", {}) });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate") ?? "").toContain("resource_metadata");
  });

  it("turns an anonymous upload away before reading it: a body that never ends still gets its 401", async () => {
    // Since hono 4.13 bodyLimit drains a body of unknown length before it
    // calls next(). In front of auth that parks the request forever.
    const never = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"jsonrpc"')); /* and then silence */ },
    });
    const req = new Request("http://localhost/mcp", {
      method: "POST", headers: MCP_HEADERS, body: never, duplex: "half",
    } as RequestInit & { duplex: "half" });
    const outcome = await Promise.race([
      Promise.resolve(t.app.request(req)).then((res) => res.status),
      new Promise<string>((resolve) => setTimeout(() => resolve("no answer within 1 s"), 1000)),
    ]);
    expect(outcome).toBe(401);
  });

  it("still refuses an authenticated 600 KB body, in JSON-RPC shape", async () => {
    const res = await t.app.request("/mcp", {
      method: "POST", headers: { ...MCP_HEADERS, ...bearer(agentToken) },
      body: rpc("tools/call", { name: "mesh_status", arguments: { pad: "x".repeat(600 * 1024) } }),
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ jsonrpc: "2.0", error: { code: -32600 }, id: null });
  });

  it("serves a bare tools/call without initialize — what the Go CLI sends", async () => {
    const res = await t.app.request("/mcp", {
      method: "POST", headers: { ...MCP_HEADERS, ...bearer(agentToken) },
      body: rpc("tools/call", { name: "mesh_status", arguments: {} }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { result: { content: { text: string }[] } };
    const status = JSON.parse(body.result.content[0]!.text) as { agents: { name: string }[]; inbox_pending: number };
    expect(status.agents.map((a) => a.name).sort()).toEqual(["alpha", "beta"]);
    expect(status.inbox_pending).toBe(0);
  });

  it("ensures the consumer under the agent's inbox KEY, not its name, and none for the admin identity", async () => {
    // Renamed first: until then key and name are the same word, and a route
    // that addressed NATS by name would pass unnoticed.
    const alphaId = t.h.agents.getByName("alpha")!.id;
    expect(t.h.agents.rename(alphaId, "gamma", "admin")).toBe(true);
    const call = (token: string) => t.app.request("/mcp", {
      method: "POST", headers: { ...MCP_HEADERS, ...bearer(token) },
      body: rpc("tools/call", { name: "mesh_status", arguments: {} }),
    });
    expect((await call(agentToken)).status).toBe(200);
    expect(t.ensured).toEqual(["alpha"]);
    expect((await call(ADMIN_TOKEN)).status).toBe(200);
    expect(t.ensured).toEqual(["alpha"]);
  });

  it("reads a renamed agent's mail over HTTP from the inbox it has always had", async () => {
    const alphaId = t.h.agents.getByName("alpha")!.id;
    t.h.agents.rename(alphaId, "gamma", "admin");
    const betaToken = t.h.agents.resetToken(t.h.agents.getByName("beta")!.id, "admin")!.plaintextToken;
    const tool = async (token: string, name: string, args: Record<string, unknown>) => {
      const res = await t.app.request("/mcp", {
        method: "POST", headers: { ...MCP_HEADERS, ...bearer(token) },
        body: rpc("tools/call", { name, arguments: args }),
      });
      const body = await res.json() as { result: { content: { text: string }[]; isError?: boolean } };
      return { isError: Boolean(body.result.isError), json: JSON.parse(body.result.content[0]!.text) as Record<string, any> };
    };
    const sent = await tool(betaToken, "mesh_send", { to: "gamma", payload: "for the renamed one", context: "wiring test" });
    expect(sent.isError).toBe(false);
    expect(t.h.nats.published.map((p) => p.subject)).toEqual(["mesh.agents.alpha.inbox"]);
    const got = await tool(agentToken, "mesh_receive", {});
    expect((got.json.messages as { payload: string }[]).map((m) => m.payload)).toEqual(["for the renamed one"]);
  });

  it("lets the largest legal payload through: the limit refuses 600 KB, not 256 KB", async () => {
    const res = await t.app.request("/mcp", {
      method: "POST", headers: { ...MCP_HEADERS, ...bearer(agentToken) },
      body: rpc("tools/call", { name: "mesh_send", arguments: { to: "beta", payload: "x".repeat(256 * 1024), context: "wiring test" } }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { result: { isError?: boolean; content: { text: string }[] } };
    expect(body.result.isError, body.result.content[0]?.text).toBeFalsy();
  });

  it("accepts the previous admin token while a rotation is under way", async () => {
    const previous = "p".repeat(40);
    const rotating = createTestApp({ meshAdminTokenPrevious: previous });
    const res = await rotating.app.request("/mcp", {
      method: "POST", headers: { ...MCP_HEADERS, ...bearer(previous) },
      body: rpc("tools/call", { name: "mesh_status", arguments: {} }),
    });
    expect(res.status).toBe(200);
    // And not without the setting.
    const plain = await t.app.request("/mcp", {
      method: "POST", headers: { ...MCP_HEADERS, ...bearer(previous) },
      body: rpc("tools/call", { name: "mesh_status", arguments: {} }),
    });
    expect(plain.status).toBe(401);
  });

  it("answers 406 when the client does not accept both response types", async () => {
    const res = await t.app.request("/mcp", {
      method: "POST", headers: { "Content-Type": "application/json", ...bearer(agentToken) },
      body: rpc("tools/list", {}),
    });
    expect(res.status).toBe(406);
  });

  it("delivers a message end to end through the HTTP route", async () => {
    const send = await t.app.request("/mcp", {
      method: "POST", headers: { ...MCP_HEADERS, ...bearer(agentToken) },
      body: rpc("tools/call", { name: "mesh_send", arguments: { to: "beta", payload: "over http", context: "wiring test" } }),
    });
    expect(send.status).toBe(200);
    expect(t.h.nats.published.map((p) => p.subject)).toEqual(["mesh.agents.beta.inbox"]);
  });
});

describe("public routes and headers", () => {
  it("reports health without auth, and 503 when NATS is down", async () => {
    const up = await t.app.request("/health");
    expect(up.status).toBe(200);
    expect(await up.json()).toEqual({ status: "ok", nats: "connected", db: "ok", sse_connections: 0 });
    t.natsUp.value = false;
    const down = await t.app.request("/health");
    expect(down.status).toBe(503);
    expect(await down.json()).toMatchObject({ status: "degraded", nats: "disconnected" });
  });

  it("answers /livez without asking anyone: the process is up, whatever NATS does", async () => {
    // Liveness is what the container healthcheck polls. If it depended on
    // NATS, a broker outage would take the dashboard off the proxy as well.
    t.natsUp.value = false;
    const ping = vi.spyOn(t.h.nats as unknown as { ping: () => Promise<boolean> }, "ping");
    const prepare = vi.spyOn(t.h.db, "prepare");
    const res = await t.app.request("/livez");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "alive" });
    expect(t.touch).not.toHaveBeenCalled();
    // "Asks nobody" literally: a liveness probe that grows a NATS or a
    // database check brings back the outage this route exists to survive.
    expect(ping).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
  });

  it("sends a browser without a session to the login page, and an API client a 401", async () => {
    const browser = await t.app.request("/log?tab=audit", { headers: { Accept: "text/html" } });
    expect(browser.status).toBe(302);
    expect(browser.headers.get("location")).toBe("/login?next=%2Flog%3Ftab%3Daudit");
    const api = await t.app.request("/log", { headers: { Accept: "application/json" } });
    expect(api.status).toBe(401);
  });

  it("serves the login page with a csrf token, no-store and the security headers", async () => {
    const res = await t.app.request("/login");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toContain('name="csrf"');
  });

  it("signs in through the mounted session routes and never follows a dot-segment next", async () => {
    const res = await t.app.request("/login", {
      method: "POST",
      body: new URLSearchParams({ csrf: generateCsrfToken(TEST_CONFIG.meshCookieSecret), token: ADMIN_TOKEN, next: "/.//evil.example" }),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    expect(res.headers.get("set-cookie") ?? "").toContain("mesh_session=");
  });

  it("sets Secure on the session cookie exactly when the config says so", async () => {
    const login = (app: TestApp["app"]) => app.request("/login", {
      method: "POST",
      body: new URLSearchParams({ csrf: generateCsrfToken(TEST_CONFIG.meshCookieSecret), token: ADMIN_TOKEN }),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    expect((await login(t.app)).headers.get("set-cookie") ?? "").not.toMatch(/;\s*Secure/i);
    const secure = createTestApp({ cookieSecure: true });
    expect((await login(secure.app)).headers.get("set-cookie") ?? "").toMatch(/;\s*Secure/i);
  });

  it("logs out without a session instead of bouncing through auth", async () => {
    const res = await t.app.request("/logout", { method: "POST" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });

  it("serves the CLI distribution without a session", async () => {
    const res = await t.app.request("/cli/version");
    expect([401, 404]).not.toContain(res.status);
    const script = await t.app.request("/install.sh");
    expect(script.status).toBe(200);
  });

  it("refuses an oversized body on the public OAuth endpoints", async () => {
    const res = await t.app.request("/oauth/register", {
      method: "POST", body: JSON.stringify({ pad: "x".repeat(20 * 1024) }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(413);
  });

  it("refuses an oversized login form before parsing it", async () => {
    const res = await t.app.request("/login", {
      method: "POST", body: "token=" + "x".repeat(8 * 1024),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    expect(res.status).toBe(413);
  });
});

describe("dashboard behind a session", () => {
  async function sessionCookie(): Promise<string> {
    const res = await t.app.request("/login", {
      method: "POST",
      body: new URLSearchParams({ csrf: generateCsrfToken(TEST_CONFIG.meshCookieSecret), token: ADMIN_TOKEN }),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  }

  it("renders every page for the operator, each of them no-store", async () => {
    const cookie = await sessionCookie();
    for (const path of ["/", "/agents", "/agents/connect", "/log", "/log?tab=audit", "/conversations"]) {
      const res = await t.app.request(path, { headers: { Cookie: cookie, Accept: "text/html" } });
      expect(res.status, path).toBe(200);
      expect(res.headers.get("cache-control"), path).toBe("no-store");
      expect(await res.text(), path).toContain("<html");
    }
  });

  it("reads presence once per Home render, not twice", async () => {
    // Each read is one KV get per agent. Two of them also meant two chances
    // to see different states within one page.
    const cookie = await sessionCookie();
    const list = vi.spyOn(t.h.presence, "list");
    const res = await t.app.request("/", { headers: { Cookie: cookie, Accept: "text/html" } });
    expect(res.status).toBe(200);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("keeps the two retired routes as permanent redirects with their query string", async () => {
    const cookie = await sessionCookie();
    const messages = await t.app.request("/messages?agent=alpha&q=x", { headers: { Cookie: cookie } });
    expect(messages.status).toBe(301);
    expect(messages.headers.get("location")).toBe("/log?agent=alpha&q=x");
    const activity = await t.app.request("/activity?range=24h", { headers: { Cookie: cookie } });
    expect(activity.status).toBe(301);
    expect(activity.headers.get("location")).toBe("/log?tab=audit&range=24h");
  });

  it("runs the admin actions: the operator creates an agent through the mounted route", async () => {
    // The oversized-form test gets its 413 before routing, so it would pass
    // with the admin routes gone. This one needs them.
    const cookie = await sessionCookie();
    const res = await t.app.request("/agents/create", {
      method: "POST",
      body: new URLSearchParams({ csrf: generateCsrfToken(TEST_CONFIG.meshCookieSecret), name: "delta" }),
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location") ?? "").toContain("/agents?flash=");
    expect(t.h.agents.list().map((a) => a.name).sort()).toEqual(["alpha", "beta", "delta"]);
  });

  it("serves the guided connect flow ahead of the admin actions", async () => {
    const cookie = await sessionCookie();
    const res = await t.app.request("/agents/connect", { headers: { Cookie: cookie, Accept: "text/html" } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<html");
  });

  it("keeps the agents page for the operator only", async () => {
    // An agent session: sign in with the agent's own token.
    const res = await t.app.request("/login", {
      method: "POST",
      body: new URLSearchParams({ csrf: generateCsrfToken(TEST_CONFIG.meshCookieSecret), token: agentToken }),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
    const page = await t.app.request("/agents", { headers: { Cookie: cookie, Accept: "text/html" } });
    expect(page.status).toBe(302);
    expect(page.headers.get("location")).toBe("/");
  });

  it("answers a thrown error with a generic 500, never a stack trace", async () => {
    const cookie = await sessionCookie();
    t.h.db.exec("DROP TABLE messages");
    const res = await t.app.request("/conversations", { headers: { Cookie: cookie, Accept: "text/html" } });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "internal server error" });
  });
});

describe("/agents/* — the form limit sits behind auth as well", () => {
  it("turns an anonymous upload to an admin action away before reading it", async () => {
    const never = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode("id=x&name=")); /* and then silence */ },
    });
    const req = new Request("http://localhost/agents/rename", {
      method: "POST", body: never, duplex: "half",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    } as RequestInit & { duplex: "half" });
    const outcome = await Promise.race([
      Promise.resolve(t.app.request(req)).then((res) => res.status),
      new Promise<string>((resolve) => setTimeout(() => resolve("no answer within 1 s"), 1000)),
    ]);
    expect(outcome).toBe(401);
  });

  it("still refuses an oversized form from the signed-in operator", async () => {
    const login = await t.app.request("/login", {
      method: "POST",
      body: new URLSearchParams({ csrf: generateCsrfToken(TEST_CONFIG.meshCookieSecret), token: ADMIN_TOKEN }),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
    const res = await t.app.request("/agents/create", {
      method: "POST", body: "name=" + "x".repeat(8 * 1024),
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
    });
    expect(res.status).toBe(413);
    expect(t.h.agents.list().map((a) => a.name).sort()).toEqual(["alpha", "beta"]);
  });
});

describe("OAuth discovery is mounted and public", () => {
  it("serves the protected-resource metadata without a token", async () => {
    const res = await t.app.request("/.well-known/oauth-protected-resource");
    expect(res.status).toBe(200);
  });
});
