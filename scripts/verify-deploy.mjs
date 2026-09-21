#!/usr/bin/env node
// Is what runs what was merged?
//
//   node scripts/verify-deploy.mjs [url] [git ref]
//   npm run verify:deploy -- https://moshi.enki.run origin/main
//
// Compares TWO independent things, because a check that believes one
// self-reported field verifies nothing (ocellio reported a stale commit for
// four weeks): /health.commit against the ref, and /health.version against
// package.json AT that ref.
//
// For a remote-tracking ref (origin/main) it also asks the remote where that
// branch is NOW. Right after a merge on GitHub the local origin/main is one
// commit behind, production still runs the old deploy, and the two agree:
// that used to be "VERIFIED".
//
// Exit 0 verified · 1 something else is running · 2 could not tell.
// Read-only: one GET to the service, one ls-remote to the git remote.

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const COMMIT_ID = /^[0-9a-f]{7,40}$/;

/** Pure: what the three facts add up to. */
export function compare({ health, head, version }) {
  const problems = [];
  const commit = typeof health?.commit === "string" ? health.commit.toLowerCase() : "";
  if (!COMMIT_ID.test(commit)) {
    // No such fields at all: a build from before /health said what it is.
    if (health && typeof health === "object" && !("commit" in health) && !("version" in health)) {
      return { code: 2, problems: ["/health names neither version nor commit: an older build is running (from before 1.1.0)"] };
    }
    return { code: 2, problems: [`/health names no commit (${JSON.stringify(health?.commit)}): is SOURCE_COMMIT reaching the container?`] };
  }
  if (!head.toLowerCase().startsWith(commit)) problems.push(`commit: running ${commit.slice(0, 12)}, ref is ${head.slice(0, 12)}`);
  if (health.version !== version) problems.push(`version: running ${health.version}, package.json at the ref says ${version}`);
  return { code: problems.length ? 1 : 0, problems };
}

/** Am I the script that was started? Both sides resolved: a symlinked path
 *  used to make this false, and the script exited 0 without a word. */
export function isMain(argv1, metaUrl) {
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}

const git = (...args) => execFileSync("git", args, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();

async function main() {
  const url = (process.argv[2] ?? "https://moshi.enki.run").replace(/\/+$/, "");
  const ref = process.argv[3] ?? "origin/main";
  let head, version, subject;
  try {
    head = git("rev-parse", "--verify", `${ref}^{commit}`);
    version = JSON.parse(git("show", `${ref}:package.json`)).version;
    subject = git("log", "-1", "--format=%s (%cs)", head);
  } catch (err) {
    console.error(`CANNOT TELL: git does not know ${ref} (${String(err.message).split("\n")[0]}). Try: git fetch origin`);
    return 2;
  }

  // A remote-tracking ref is only a memory of the remote. Ask the remote.
  const tracking = /^([^/]+)\/(.+)$/.exec(ref);
  if (tracking) {
    let remotes = [];
    try { remotes = git("remote").split("\n"); } catch { /* not a repository: caught above already */ }
    if (remotes.includes(tracking[1])) {
      let there;
      try {
        there = git("ls-remote", tracking[1], `refs/heads/${tracking[2]}`).split(/\s+/)[0];
      } catch (err) {
        console.error(`CANNOT TELL: could not ask ${tracking[1]} where ${tracking[2]} is (${String(err.message).split("\n")[0]})`);
        return 2;
      }
      if (there && there !== head) {
        console.error(`CANNOT TELL: ${ref} is ${head.slice(0, 7)} here but ${there.slice(0, 7)} on ${tracking[1]}. Run: git fetch ${tracking[1]}`);
        return 2;
      }
    }
  }

  let health;
  try {
    // A 503 is a body too: /health is readiness, and a degraded instance
    // still says what it is. A redirect is not: whoever answers at the other
    // end is not the service that was asked.
    const res = await fetch(`${url}/health`, {
      headers: { "User-Agent": "moshi-verify-deploy/1.0", Accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status >= 300 && res.status < 400) {
      console.error(`CANNOT TELL: ${url}/health redirects to ${res.headers.get("location") ?? "somewhere else"}`);
      return 2;
    }
    health = await res.json();
  } catch (err) {
    console.error(`CANNOT TELL: ${url}/health did not answer with JSON (${err.message})`);
    return 2;
  }
  const { code, problems } = compare({ health, head, version });
  if (code === 0) console.log(`VERIFIED: ${url} runs ${head.slice(0, 7)} = ${ref}, version ${version}, status ${health.status}\n  ${subject}`);
  else console.error(`${code === 1 ? "MISMATCH" : "CANNOT TELL"}: ${url}\n  ${problems.join("\n  ")}`);
  return code;
}

if (isMain(process.argv[1], import.meta.url)) {
  process.exitCode = await main();
}
