// Shutting down in order (src/services/shutdown.ts).
//
// It used to be: server.close() without waiting, nats.close(), db.close(),
// exit. A request that was being answered when the deploy came was cut off,
// and an open event stream held nothing up only because nothing waited.

import { describe, it, expect, vi, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createShutdown, closeHttpServer, beginDraining, isDraining, _resetDrainingForTest, SHUTDOWN_STEP_TIMEOUTS_MS, SHUTDOWN_BUDGET_MS, HTTP_GRACE_MS } from "../../src/services/shutdown";
import { createTestApp } from "../app/harness";
import net from "node:net";

afterEach(() => { vi.useRealTimers(); _resetDrainingForTest(); });

const quiet = () => {};

describe("createShutdown", () => {
  it("runs the steps in the order given, waits for each, then exits 0", async () => {
    const order: string[] = [];
    const exit = vi.fn();
    const step = (name: string, ms = 0) => ({
      name, timeoutMs: 1000,
      run: async () => { order.push(`${name}:start`); await new Promise((r) => setTimeout(r, ms)); order.push(`${name}:end`); },
    });
    await createShutdown({ steps: [step("http", 20), step("nats", 5), step("db")], log: quiet, exit })("SIGTERM");
    expect(order).toEqual(["http:start", "http:end", "nats:start", "nats:end", "db:start", "db:end"]);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("does it once, however many signals arrive", async () => {
    const run = vi.fn();
    const exit = vi.fn();
    const shutdown = createShutdown({ steps: [{ name: "only", timeoutMs: 1000, run }], log: quiet, exit });
    await Promise.all([shutdown("SIGTERM"), shutdown("SIGINT"), shutdown("SIGTERM")]);
    expect(run).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("goes on after a step that throws, and says which one", async () => {
    const lines: string[] = [];
    const ran: string[] = [];
    const exit = vi.fn();
    await createShutdown({
      steps: [
        { name: "nats", timeoutMs: 1000, run: () => { throw new Error("already closed"); } },
        { name: "db", timeoutMs: 1000, run: () => { ran.push("db"); } },
      ],
      log: (level, msg, extra) => lines.push(`${level} ${msg} ${JSON.stringify(extra)}`),
      exit,
    })("SIGTERM");
    expect(ran).toEqual(["db"]);
    expect(lines.join("\n")).toMatch(/error shutdown step failed .*"step":"nats".*already closed/);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("does not wait for ever for a step that hangs: the database still gets closed", async () => {
    vi.useFakeTimers();
    const ran: string[] = [];
    const lines: string[] = [];
    const exit = vi.fn();
    const done = createShutdown({
      steps: [
        { name: "http", timeoutMs: 10_000, run: () => new Promise<void>(() => {}) },
        { name: "db", timeoutMs: 1000, run: () => { ran.push("db"); } },
      ],
      log: (level, msg, extra) => lines.push(`${level} ${msg} ${JSON.stringify(extra)}`),
      exit,
    })("SIGTERM");
    await vi.advanceTimersByTimeAsync(9_999);
    expect(ran).toEqual([]);
    await vi.advanceTimersByTimeAsync(2);
    await done;
    expect(ran).toEqual(["db"]);
    expect(lines.join("\n")).toMatch(/"step":"http".*timed out/);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("exits even when the logger itself throws", async () => {
    const exit = vi.fn();
    await createShutdown({ steps: [{ name: "x", timeoutMs: 10, run: quiet }], log: () => { throw new Error("stdout gone"); }, exit })("SIGTERM");
    expect(exit).toHaveBeenCalledTimes(1);
  });
});

describe("closeHttpServer", () => {
  async function listen(handler: http.RequestListener) {
    const server = http.createServer(handler);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return { server, port: (server.address() as AddressInfo).port };
  }
  const get = (port: number, agent?: http.Agent) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      http.get({ host: "127.0.0.1", port, path: "/", agent }, (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        res.on("error", reject);
      }).on("error", reject);
    });

  it("lets a request that is being answered finish, and takes no new ones", async () => {
    const { server, port } = await listen((_req, res) => setTimeout(() => res.end("done"), 150));
    const inFlight = get(port);
    await new Promise((r) => setTimeout(r, 30));
    const closed = closeHttpServer(server, 2000);
    await expect(get(port)).rejects.toThrow(); // ECONNREFUSED
    expect(await inFlight).toEqual({ status: 200, body: "done" });
    await closed;
    expect(server.listening).toBe(false);
  });

  it("does not wait for an idle keep-alive connection", async () => {
    const { server, port } = await listen((_req, res) => res.end("ok"));
    const agent = new http.Agent({ keepAlive: true });
    await get(port, agent);
    const started = Date.now();
    await closeHttpServer(server, 5000);
    expect(Date.now() - started).toBeLessThan(1000);
    agent.destroy();
  });

  it("cuts what is still open when the grace period is over", async () => {
    const { server, port } = await listen(() => { /* never answers */ });
    const hanging = get(port).catch((err: Error) => err.message);
    await new Promise((r) => setTimeout(r, 30));
    const started = Date.now();
    await closeHttpServer(server, 100);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(await hanging).toMatch(/hang up|ECONNRESET|aborted/i);
  });
});

// From the review: during the grace period the server kept answering NEW
// requests on kept-alive connections (and took new event streams), and a
// connection that fell idle after close() held the step for seconds.
describe("while the service is draining", () => {
  it("says Connection: close on every answer, so a kept-alive client goes elsewhere", async () => {
    const t = createTestApp();
    expect((await t.app.request("/livez")).headers.get("connection")).toBeNull();
    beginDraining();
    expect(isDraining()).toBe(true);
    expect((await t.app.request("/livez")).headers.get("connection")).toBe("close");
    expect((await t.app.request("/nope")).headers.get("connection")).toBe("close");
  });

  it("lets go of a kept-alive connection as soon as its answer is out, not seconds later", async () => {
    const t = createTestApp();
    const { serve } = await import("@hono/node-server");
    const server = serve({ fetch: t.app.fetch, port: 0, hostname: "127.0.0.1" }) as http.Server;
    await new Promise((r) => server.once("listening", r));
    const port = (server.address() as AddressInfo).port;
    const socket = net.connect(port, "127.0.0.1");
    await new Promise((r) => socket.once("connect", r));
    const answers: string[] = [];
    socket.on("data", (d) => answers.push(String(d)));
    const get = () => socket.write("GET /livez HTTP/1.1\r\nHost: x\r\nConnection: keep-alive\r\n\r\n");
    get();
    await new Promise((r) => setTimeout(r, 100));
    expect(answers.join("")).toMatch(/200 OK/);

    const started = Date.now();
    beginDraining();
    const closed = closeHttpServer(server, 5000);
    await closed;
    expect(Date.now() - started).toBeLessThan(1500); // an idle kept-alive socket is swept, not waited for
    socket.destroy();
  });

  it("adds up to less than the container is given to stop", () => {
    expect(HTTP_GRACE_MS).toBe(10_000);
    expect(SHUTDOWN_BUDGET_MS).toBe(Object.values(SHUTDOWN_STEP_TIMEOUTS_MS).reduce((a, b) => a + b, 0));
    expect(SHUTDOWN_STEP_TIMEOUTS_MS.http).toBeGreaterThan(HTTP_GRACE_MS);
  });
});
