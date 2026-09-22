// A broker that stops answering — the whole app against a real NATS that the
// test freezes with `docker pause`. That is the worst case: the TCP
// connection stays open, so the client does not know, and every JetStream
// call runs into its timeout.
//
// Measured before this fix, per request: mesh_history 15 s (pure SQLite!),
// mesh_send 20 s, mesh_status 25 s, GET / 10 s.
//
// Needs MOSHI_TEST_NATS_URL and MOSHI_TEST_NATS_CONTAINER, both set by
// `npm run test:integration`.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { connect as natsConnect } from "nats";
import { initDatabase } from "../../src/services/db";
import { NatsService } from "../../src/services/nats";
import { AgentService } from "../../src/services/agent";
import { ActivityService } from "../../src/services/activity";
import { PresenceService } from "../../src/services/presence";
import { RateLimiter } from "../../src/services/ratelimit";
import { createApp } from "../../src/app";
import { TEST_CONFIG, ADMIN_TOKEN, MCP_HEADERS, rpc, signIn } from "../app/harness";

const URL = process.env.MOSHI_TEST_NATS_URL;
const CONTAINER = process.env.MOSHI_TEST_NATS_CONTAINER;

// Under the script (and so in CI) a missing value is a failure, not a skip:
// a suite that skips itself reports green.
if (process.env.MOSHI_TEST_NATS_REQUIRED === "1" && (!URL || !CONTAINER)) {
  throw new Error("MOSHI_TEST_NATS_REQUIRED is set but MOSHI_TEST_NATS_URL or MOSHI_TEST_NATS_CONTAINER is empty");
}
const LOOPBACK = /^nats:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+$/;

const docker = (...args: string[]) => execFileSync("docker", args, { stdio: "ignore" });

describe.skipIf(!URL || !CONTAINER)("a broker that stops answering", () => {
  let nats: NatsService;
  let app: ReturnType<typeof createApp>;
  let token: string;
  let betaToken: string;
  let paused = false;

  const pause = () => { docker("pause", CONTAINER!); paused = true; };
  const unpause = () => { if (paused) { docker("unpause", CONTAINER!); paused = false; } };

  beforeEach(async () => {
    if (!LOOPBACK.test(URL!)) throw new Error(`MOSHI_TEST_NATS_URL must be a loopback broker (got ${URL})`);
    const admin = await natsConnect({ servers: URL });
    const jsm = await admin.jetstreamManager();
    for (const name of ["MESH_MESSAGES", "KV_mesh-presence"]) {
      // Emptied first, then deleted: on NATS 2.12 a stream that is deleted and
      // created again at once can come back with what the old one held.
      try { await jsm.streams.purge(name); } catch { /* not there yet */ }
      try { await jsm.streams.delete(name); } catch { /* not there yet */ }
    }
    await admin.close();

    nats = new NatsService(URL!);
    await nats.connect();
    const db = initDatabase(":memory:");
    const activity = new ActivityService(db);
    const agents = new AgentService(db, activity, nats);
    token = agents.create("alpha").plaintextToken;
    betaToken = agents.create("beta").plaintextToken;
    app = createApp({
      config: TEST_CONFIG, db, nats, agents, activity,
      presence: new PresenceService(db, nats), rateLimiter: new RateLimiter(60),
    });
  });

  afterEach(async () => {
    unpause(); // never leave the broker frozen for the next test
    await nats.close().catch(() => {});
  });

  async function tool(name: string, args: Record<string, unknown> = {}, as: string = token) {
    const t0 = performance.now();
    const res = await app.request("/mcp", {
      method: "POST", headers: { ...MCP_HEADERS, Authorization: `Bearer ${as}` },
      body: rpc("tools/call", { name, arguments: args }),
    });
    const body = await res.json() as { result?: { content: { text: string }[]; isError?: boolean } };
    return { status: res.status, ms: performance.now() - t0, text: body.result?.content?.[0]?.text ?? "", isError: Boolean(body.result?.isError) };
  }

  it("keeps answering: the first request is bounded, every later one is fast", async () => {
    const sent = await tool("mesh_send", { to: "beta", payload: "before the outage", context: "outage test" });
    expect(sent.isError, sent.text).toBe(false);
    const rootId = (JSON.parse(sent.text) as { id: string }).id;

    pause();

    // The request that discovers the outage pays for it once, bounded.
    const first = await tool("mesh_history", { correlation_id: rootId });
    expect(first.status).toBe(200);
    expect(first.text).toContain("before the outage"); // history is SQLite: it still works
    expect(first.ms).toBeLessThan(4000);

    // From then on the breaker answers for the broker.
    const history = await tool("mesh_history", { correlation_id: rootId });
    expect(history.text).toContain("before the outage");
    expect(history.ms).toBeLessThan(1000);

    // The send that is in flight when the outage is discovered: the presence
    // wait (0.3 s) plus the publish timeout (4 s). A publish gets that much
    // room because its outcome is unknown when it times out, and the sender
    // is told exactly that.
    const send = await tool("mesh_send", { to: "beta", payload: "during the outage", context: "outage test" });
    expect(send.isError).toBe(true);
    expect(send.text).toContain("nats_unavailable");
    expect(send.text).toContain("could not be confirmed");
    expect(send.ms).toBeLessThan(5500);

    // From here on the breaker answers for the broker. The limits are ten
    // times what was measured under load, and a hundred times tighter than a
    // single JetStream timeout: take guarded() off one method and this fails.
    const again = await tool("mesh_send", { to: "beta", payload: "during the outage, again", context: "outage test" });
    expect(again.text).toContain("not delivered");
    expect(again.ms).toBeLessThan(500);

    const receive = await tool("mesh_receive");
    expect(receive.text).toContain("nats_unavailable");
    expect(receive.ms).toBeLessThan(500);

    const status = await tool("mesh_status");
    expect(status.isError).toBe(false);
    expect((JSON.parse(status.text) as { inbox_pending: number | null }).inbox_pending).toBeNull();
    expect(status.ms).toBeLessThan(500);

    // An agent the registry has never seen: its consumers cannot be ensured
    // now, and that must not cost a timeout either.
    const unseen = await tool("mesh_status", {}, betaToken);
    expect(unseen.isError).toBe(false);
    expect(unseen.ms).toBeLessThan(500);
  }, 30_000);

  it("reports the outage on /health at once, stays alive on /livez, and still serves the dashboard", async () => {
    pause();
    const timed = async (path: string, headers: Record<string, string> = {}) => {
      const t0 = performance.now();
      const res = await app.request(path, { headers });
      return { res, ms: performance.now() - t0 };
    };

    const health = await timed("/health");
    expect(health.res.status).toBe(503);
    expect(await health.res.json()).toMatchObject({ status: "degraded", nats: "disconnected", db: "ok" });
    expect(health.ms).toBeLessThan(2500);

    const live = await timed("/livez");
    expect(live.res.status).toBe(200);
    expect(live.ms).toBeLessThan(200);

    const { cookie } = await signIn(app, ADMIN_TOKEN);
    for (const path of ["/", "/agents", "/log", "/conversations"]) {
      const page = await timed(path, { Cookie: cookie, Accept: "text/html" });
      expect(page.res.status, path).toBe(200);
      // What this proves is that a page does not WAIT on the broker. One that
      // did would pay JS_TIMEOUT_MS (1500 ms) at least. Measured here: 17 ms
      // for the first page, 1 to 3 ms for the rest; a loaded CI runner took
      // 504 ms for the first one and failed a 500 ms bound that was never
      // about the cost of rendering.
      expect(page.ms, path).toBeLessThan(1200);
    }
  }, 30_000);

  it("recovers on its own once the broker answers again", async () => {
    pause();
    // Trips the breaker. Its outcome is unknown: it may arrive after the thaw.
    await tool("mesh_send", { to: "beta", payload: "sent into the outage", context: "outage test" });
    unpause();

    // No restart, no reconnect event (the connection never dropped): the
    // breaker's probe after the cool-down has to find the way back.
    const deadline = performance.now() + 12_000;
    let last = await tool("mesh_send", { to: "beta", payload: "after the outage", context: "outage test" });
    while (last.isError && performance.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500));
      last = await tool("mesh_send", { to: "beta", payload: "after the outage", context: "outage test" });
    }
    expect(last.isError, last.text).toBe(false);
    expect((await app.request("/health")).status).toBe(200);
  }, 40_000);
});
