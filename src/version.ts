// What is running: the version from package.json and the commit of the build.
//
// VERSION used to be a constant somebody had to remember to edit, and nothing
// named a commit. Whether a merge had been deployed could not be told from
// outside (2026-09-11: two days).

import { readFileSync } from "node:fs";

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as { version?: unknown };
    return typeof pkg.version === "string" && pkg.version.length > 0 ? pkg.version : "unknown";
  } catch {
    // A missing package.json must not keep the process from starting.
    return "unknown";
  }
}

/** package.json's `version`. The image copies package.json next to `src/`. */
export const VERSION: string = readVersion();

const COMMIT_ID = /^[0-9a-f]{7,40}$/;

const commitFrom = (value: string | undefined): string | null => {
  const id = (value ?? "").trim().toLowerCase();
  return COMMIT_ID.test(id) ? id : null;
};

/**
 * The deployed commit, or "unknown".
 *
 * Coolify writes a per-deploy `SOURCE_COMMIT` into the `.env` it attaches to
 * every compose service, so the app reads it from its own environment.
 * NEVER reference it in docker-compose.yml and never store it in Coolify: a
 * stored variable hides the per-deploy value for good (tests/version.test.ts
 * guards both files). `MOSHI_COMMIT` is for builds outside Coolify
 * (`--build-arg MOSHI_COMMIT=…`); the image leaves it empty.
 *
 * Only a commit id ever comes out of here. The value goes into a response
 * header and a JSON body.
 */
export function resolveCommit(env: Record<string, string | undefined>): string {
  return commitFrom(env.MOSHI_COMMIT) ?? commitFrom(env.SOURCE_COMMIT) ?? "unknown";
}

/** `1.1.0+dd7c1ee`: semver with the build as metadata. */
export function versionLabel(commit: string): string {
  return commit === "unknown" ? VERSION : `${VERSION}+${commit.slice(0, 7)}`;
}
