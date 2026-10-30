// postWebhook against a real HTTPS server: status classes, no redirects, the
// time bound, and the pinned address. The certificate is made per run by
// openssl; nothing secret is kept in the repository.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import https from "node:https";
import type { AddressInfo } from "node:net";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { postWebhook } from "../../src/services/webhook-target";
import type { Resolved } from "../../src/services/webhook-target";

const HOST = "hooks.example.com";
let dir: string;
let cert: Buffer;
let server: https.Server;
let port: number;
const seen: { path: string; headers: Record<string, string | string[] | undefined>; body: string }[] = [];
// What the next request is answered with, per path.
const answers: Record<string, (res: import("node:http").ServerResponse) => void> = {
  "/accepted": (res) => { res.writeHead(202); res.end(); },
  "/moved": (res) => { res.writeHead(302, { location: `https://${HOST}/accepted` }); res.end(); },
  "/busy": (res) => { res.writeHead(503); res.end(); },
  "/limited": (res) => { res.writeHead(429); res.end(); },
  "/refused": (res) => { res.writeHead(401); res.end(); },
  "/slow": () => { /* never answers */ },
};

const toLocal = async (): Promise<Resolved> => ({ ok: true, address: "127.0.0.1", family: 4 });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "moshi-webhook-"));
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"),
    "-subj", `/CN=${HOST}`, "-addext", `subjectAltName=DNS:${HOST}`,
  ], { stdio: "ignore" });
  cert = readFileSync(join(dir, "cert.pem"));
  server = https.createServer({ key: readFileSync(join(dir, "key.pem")), cert }, (req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      seen.push({ path: req.url ?? "", headers: req.headers, body });
      (answers[req.url ?? ""] ?? ((r) => { r.writeHead(404); r.end(); }))(res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dir, { recursive: true, force: true });
});

const post = (path: string, timeoutMs = 2_000) =>
  postWebhook(`https://${HOST}${path}`, { "webhook-id": "wh_1" }, '{"type":"message.created"}', timeoutMs, { resolve: toLocal, port, ca: cert });

describe("postWebhook", () => {
  it("delivers the body with its headers and reports 2xx as success", async () => {
    seen.length = 0;
    expect(await post("/accepted")).toEqual({ ok: true, status: 202 });
    expect(seen).toHaveLength(1);
    expect(seen[0].body).toBe('{"type":"message.created"}');
    expect(seen[0].headers["webhook-id"]).toBe("wh_1");
    expect(seen[0].headers["content-type"]).toBe("application/json");
    expect(seen[0].headers["user-agent"]).toMatch(/^moshi-webhooks\//);
  });

  it("does not follow a redirect and does not try again", async () => {
    seen.length = 0;
    expect(await post("/moved")).toMatchObject({ ok: false, retryable: false, status: 302 });
    expect(seen.map((s) => s.path)).toEqual(["/moved"]);
  });

  it("calls 5xx, 429 and a timeout worth another attempt, a 401 not", async () => {
    expect(await post("/busy")).toMatchObject({ ok: false, retryable: true, status: 503 });
    expect(await post("/limited")).toMatchObject({ ok: false, retryable: true, status: 429 });
    expect(await post("/refused")).toMatchObject({ ok: false, retryable: false, status: 401 });
    const started = Date.now();
    expect(await post("/slow", 200)).toMatchObject({ ok: false, retryable: true, error: "timeout after 200 ms" });
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it("falls back to the next checked address when the first one cannot be reached", async () => {
    seen.length = 0;
    // The server listens on 127.0.0.1 only; ::1 is listed first and refuses.
    const r = await postWebhook(`https://${HOST}/accepted`, {}, "{}", 2_000, {
      resolve: async () => ({
        ok: true, address: "::1", family: 6,
        addresses: [{ address: "::1", family: 6 }, { address: "127.0.0.1", family: 4 }],
      }),
      port, ca: cert,
    });
    expect(r).toEqual({ ok: true, status: 202 });
    expect(seen).toHaveLength(1);
  });

  it("refuses before connecting when the address is not public", async () => {
    seen.length = 0;
    const r = await postWebhook(`https://${HOST}/accepted`, {}, "{}", 2_000, {
      resolve: async () => ({ ok: false, retryable: false, reason: "target_not_public" }),
      port, ca: cert,
    });
    expect(r).toEqual({ ok: false, retryable: false, error: "target_not_public" });
    expect(seen).toHaveLength(0);
  });

  it("refuses a URL that is no longer acceptable, without resolving it", async () => {
    const r = await postWebhook("http://hooks.example.com/accepted", {}, "{}", 2_000, {
      resolve: async () => { throw new Error("resolved"); },
    });
    expect(r).toMatchObject({ ok: false, retryable: false });
  });
});
