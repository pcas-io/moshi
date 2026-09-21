// scripts/verify-deploy.mjs as a process, against a scratch git remote and a
// local /health. From the review: it said VERIFIED for the OLD deploy right
// after a merge, because it only asked the local copy of origin/main.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, mkdirSync, realpathSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT = resolve("scripts/verify-deploy.mjs");
let root: string;
let clone: string;
let other: string;
let server: Server;
let base: string;
let answer: { status: number; headers?: Record<string, string>; body: string };

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { cwd, encoding: "utf-8" }).trim();
// Not spawnSync: the /health server lives in this process, and a blocked
// event loop cannot answer the script it is waiting for.
const run = (script: string, ...args: string[]) =>
  new Promise<{ code: number | null; out: string }>((done) => {
    const child = spawn("node", [script, ...args], { cwd: clone });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => done({ code, out }));
  });
const health = (commit: string, version = "1.1.0") => ({ status: 200, body: JSON.stringify({ status: "ok", version, commit, nats: "connected", db: "ok" }) });

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "moshi-verify-")));
  git(root, "init", "-q", "--bare", "-b", "main", "remote.git");
  clone = join(root, "clone");
  other = join(root, "other");
  git(root, "clone", "-q", "remote.git", "clone");
  writeFileSync(join(clone, "package.json"), JSON.stringify({ version: "1.1.0" }));
  git(clone, "add", "package.json");
  git(clone, "commit", "-q", "-m", "one");
  git(clone, "push", "-q", "origin", "HEAD:main");
  git(clone, "fetch", "-q", "origin");
  git(root, "clone", "-q", "remote.git", "other");

  server = createServer((req, res) => {
    if (req.url === "/elsewhere") { res.writeHead(200, { "Content-Type": "application/json" }); res.end(health("f".repeat(40)).body); return; }
    res.writeHead(answer.status, { "Content-Type": "application/json", ...(answer.headers ?? {}) });
    res.end(answer.body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  rmSync(root, { recursive: true, force: true });
});

describe("verify-deploy, as a process", () => {
  it("says VERIFIED with what it compared, and exits 0", async () => {
    const head = git(clone, "rev-parse", "origin/main");
    answer = health(head);
    const r = await run(SCRIPT, base, "origin/main");
    expect(r.out).toContain("VERIFIED");
    expect(r.out).toContain(head.slice(0, 7));
    expect(r.out).toContain("one"); // the commit's subject: a human sees what was compared
    expect(r.code).toBe(0);
  });

  it("says so when it runs through a symlink, instead of exiting 0 without a word", async () => {
    const linked = join(root, "linked");
    mkdirSync(linked);
    symlinkSync(SCRIPT, join(linked, "verify.mjs"));
    answer = health("a".repeat(40));
    const r = await run(join(linked, "verify.mjs"), base, "origin/main");
    expect(r.out).toContain("MISMATCH");
    expect(r.code).toBe(1);
  });

  it("cannot tell when /health redirects: the answer would be somebody else's", async () => {
    answer = { status: 302, headers: { Location: "/elsewhere" }, body: "" };
    const r = await run(SCRIPT, base, "origin/main");
    expect(r.code).toBe(2);
    expect(r.out).toContain("CANNOT TELL");
  });

  it("names an older build for what it is: no version and no commit on /health", async () => {
    answer = { status: 200, body: JSON.stringify({ status: "ok", nats: "connected", db: "ok" }) };
    const r = await run(SCRIPT, base, "origin/main");
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/older build|from before/i);
    expect(r.out).not.toContain("SOURCE_COMMIT");
  });

  it("does not confirm the OLD deploy against a local origin/main that is behind the remote", async () => {
    const old = git(clone, "rev-parse", "origin/main");
    writeFileSync(join(other, "file.txt"), "merged on GitHub");
    git(other, "add", "file.txt");
    git(other, "commit", "-q", "-m", "two");
    git(other, "push", "-q", "origin", "HEAD:main");
    answer = health(old); // production still runs the old commit
    const stale = await run(SCRIPT, base, "origin/main");
    expect(stale.out).not.toContain("VERIFIED");
    expect(stale.out).toContain("git fetch");
    expect(stale.code).toBe(2);

    git(clone, "fetch", "-q", "origin");
    const fresh = await run(SCRIPT, base, "origin/main");
    expect(fresh.out).toContain("MISMATCH");
    expect(fresh.code).toBe(1);
  });
});
