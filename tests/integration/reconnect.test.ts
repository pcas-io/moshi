// A broker that really goes away and comes back.
//
// outage.test.ts freezes the broker: the TCP connection stays open, so no
// connection event ever fires there. This one stops the container. The
// client sees a disconnect, then a reconnect, and everything that hangs on
// those two events gets exercised against the real thing: the breaker held
// open without probes, closed at once on reconnect, and the remembered
// consumers thrown away because the broker may be a fresh one.
//
// Needs MOSHI_TEST_NATS_URL and MOSHI_TEST_NATS_CONTAINER, both set by
// `npm run test:integration` (which starts the broker on a fixed port and
// without --rm, so it survives the stop).

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
import { TEST_CONFIG, MCP_HEADERS, rpc } from "../app/harness";

const URL = process.env.MOSHI_TEST_NATS_URL;
const CONTAINER = process.env.MOSHI_TEST_NATS_CONTAINER;

// Under the script (and so in CI) a missing value is a failure, not a skip:
// a suite that skips itself reports green.
if (process.env.MOSHI_TEST_NATS_REQUIRED === "1" && (!URL || !CONTAINER)) {
  throw new Error("MOSHI_TEST_NATS_REQUIRED is set but MOSHI_TEST_NATS_URL or MOSHI_TEST_NATS_CONTAINER is empty");
}
const LOOPBACK = /^nats:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+$/;
const docker = (...args: string[]) => execFileSync("docker", args, { stdio: "ignore" });

describe.skipIf(!URL || !CONTAINER)("a broker that goes away and comes back", () => {
  let nats: NatsService;
  let app: ReturnType<typeof createApp>;
  let alphaToken: string;
  let betaToken: string;
  let stopped = false;

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
    alphaToken = agents.create("alpha").plaintextToken;
    betaToken = agents.create("beta").plaintextToken;
    app = createApp({
      config: TEST_CONFIG, db, nats, agents, activity,
      presence: new PresenceService(db, nats), rateLimiter: new RateLimiter(60),
    });
  });

  afterEach(async () => {
    if (stopped) { docker("start", CONTAINER!); stopped = false; }
    await nats.close();
  });

  async function tool(as: string, name: string, args: Record<string, unknown> = {}) {
    const t0 = performance.now();
    const res = await app.request("/mcp", {
      method: "POST", headers: { ...MCP_HEADERS, Authorization: `Bearer ${as}` },
      body: rpc("tools/call", { name, arguments: args }),
    });
    const body = await res.json() as { result?: { content: { text: string }[]; isError?: boolean } };
    return { ms: performance.now() - t0, text: body.result?.content?.[0]?.text ?? "", isError: Boolean(body.result?.isError) };
  }
  const until = async (fn: () => Promise<boolean>, ms: number) => {
    const end = performance.now() + ms;
    while (performance.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 250)); }
    return false;
  };

  it("fails fast while the connection is down, and delivers again after the reconnect, without a restart", async () => {
    // Both agents have been around: their consumers exist and are remembered.
    expect((await tool(alphaToken, "mesh_send", { to: "beta", payload: "before", context: "reconnect test" })).isError).toBe(false);
    expect((await tool(betaToken, "mesh_receive")).text).toContain("before");

    docker("stop", "-t", "1", CONTAINER!);
    stopped = true;

    // The client notices the disconnect by itself: no timeout has to run out.
    expect(await until(async () => !(await nats.ping()), 5000)).toBe(true);
    const down = await tool(alphaToken, "mesh_send", { to: "beta", payload: "while down", context: "reconnect test" });
    expect(down.isError).toBe(true);
    expect(down.text).toContain("not delivered"); // known down: definitely not sent
    expect(down.ms).toBeLessThan(500);
    expect((await app.request("/health")).status).toBe(503);
    expect((await app.request("/livez")).status).toBe(200);

    docker("start", CONTAINER!);
    stopped = false;

    // nats.js reconnects by itself (every 2 s). No restart of the app.
    expect(await until(async () => (await app.request("/health")).status === 200, 20_000)).toBe(true);
    const after = await tool(alphaToken, "mesh_send", { to: "beta", payload: "after the reconnect", context: "reconnect test" });
    expect(after.isError, after.text).toBe(false);
    const got = await tool(betaToken, "mesh_receive");
    expect(got.text).toContain("after the reconnect");
    expect(got.text).not.toContain("while down");
  }, 60_000);
});
