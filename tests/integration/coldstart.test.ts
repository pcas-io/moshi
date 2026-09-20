// Cold start with a broker that does not answer — the real process, spawned.
//
// src/index.tsx is bootstrap and cannot be unit-tested, but its one promise
// can be checked from outside: the HTTP side is up at once, and the app finds
// NATS on its own when it answers. Before, start() tried ten times and exited
// after about 20 seconds.
//
// The broker is frozen with `docker pause`, so the TCP connection is accepted
// and then nothing happens: the slowest way for a connect to fail.

import { describe, it, expect, afterEach } from "vitest";
import { spawn, execFileSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import net from "node:net";
import path from "node:path";

const URL = process.env.MOSHI_TEST_NATS_URL;
const CONTAINER = process.env.MOSHI_TEST_NATS_CONTAINER;

// Under the script (and so in CI) a missing value is a failure, not a skip:
// a suite that skips itself reports green.
if (process.env.MOSHI_TEST_NATS_REQUIRED === "1" && (!URL || !CONTAINER)) {
  throw new Error("MOSHI_TEST_NATS_REQUIRED is set but MOSHI_TEST_NATS_URL or MOSHI_TEST_NATS_CONTAINER is empty");
}

const freePort = () => new Promise<number>((resolve) => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const { port } = s.address() as net.AddressInfo; s.close(() => resolve(port)); });
});

describe.skipIf(!URL || !CONTAINER)("cold start while the broker does not answer", () => {
  let server: ChildProcess | undefined;
  let dir: string | undefined;
  let paused = false;

  afterEach(async () => {
    if (paused) { execFileSync("docker", ["unpause", CONTAINER!], { stdio: "ignore" }); paused = false; }
    if (server && server.exitCode === null && server.signalCode === null) {
      const gone = new Promise((r) => server!.once("exit", r));
      server.kill("SIGTERM");
      await Promise.race([gone, new Promise((r) => setTimeout(r, 4000))]);
      if (server.exitCode === null && server.signalCode === null) server.kill("SIGKILL");
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("serves at once, stays up, and connects by itself once the broker answers", async () => {
    execFileSync("docker", ["pause", CONTAINER!], { stdio: "ignore" });
    paused = true;

    const port = await freePort();
    dir = mkdtempSync(path.join(tmpdir(), "moshi-coldstart-"));
    let log = "";
    // node directly, not through npx: a kill has to reach the app, not a
    // wrapper that leaves tsx and node behind holding the port.
    server = spawn(process.execPath, ["--import", "tsx", "src/index.tsx"], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env, PORT: String(port), NATS_URL: URL!, NODE_ENV: "development",
        MESH_ADMIN_TOKEN: "t".repeat(40), DATABASE_PATH: path.join(dir, "coldstart.db"),
      },
    });
    server.stdout!.on("data", (d) => { log += d; });
    server.stderr!.on("data", (d) => { log += d; });

    const base = `http://127.0.0.1:${port}`;
    const status = async (p: string) => { try { return (await fetch(base + p)).status; } catch { return 0; } };
    const until = async (fn: () => Promise<boolean>, ms: number) => {
      const end = Date.now() + ms;
      while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 200)); }
      return false;
    };

    // Up at once, although NATS has not answered and will not for a while.
    expect(await until(async () => (await status("/livez")) === 200, 10_000), log).toBe(true);
    expect(await status("/health")).toBe(503);
    expect(await status("/login")).toBe(200);

    // The tools answer instead of hanging: status comes from SQLite.
    const res = await fetch(base + "/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${"t".repeat(40)}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "mesh_status", arguments: {} } }),
    });
    expect(res.status).toBe(200);

    // Stay frozen until the first connect has given up. Thawed earlier, that
    // first attempt simply completes and the retry loop, which is the claim,
    // never runs. (It used to be "ten attempts, then exit".)
    expect(await until(async () => log.includes("nats connect attempt failed"), 20_000), log).toBe(true);
    expect(server.exitCode).toBeNull();

    execFileSync("docker", ["unpause", CONTAINER!], { stdio: "ignore" });
    paused = false;

    // No restart: a LATER attempt of the background loop finds the broker.
    expect(await until(async () => (await status("/health")) === 200, 45_000), log).toBe(true);
    expect(server.exitCode).toBeNull();
    const attempts = Number(/"nats connected".*?"attempts":(\d+)/.exec(log)?.[1] ?? 0);
    expect(attempts, log).toBeGreaterThanOrEqual(2);
  }, 120_000);
});
