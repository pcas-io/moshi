// What is running? Until now nobody could tell from outside: VERSION was a
// constant somebody had to remember to edit, and /health named no commit.
// On 2026-09-11 that cost two days.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { VERSION, resolveCommit, versionLabel } from "../src/version";
import { VERSION as VERSION_FROM_TYPES } from "../src/types";
import { loadConfig, isConfigError } from "../src/config";

const pkg = JSON.parse(readFileSync("package.json", "utf-8")) as { version: string };
const SHA = "dd7c1ee0a1b2c3d4e5f60718293a4b5c6d7e8f90";

describe("VERSION", () => {
  it("is package.json's version, not a second copy of it", () => {
    expect(VERSION).toBe(pkg.version);
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(VERSION_FROM_TYPES).toBe(VERSION);
  });

  it("agrees with the lockfile", () => {
    const lock = JSON.parse(readFileSync("package-lock.json", "utf-8")) as { version: string; packages: Record<string, { version: string }> };
    expect(lock.version).toBe(pkg.version);
    expect(lock.packages[""].version).toBe(pkg.version);
  });
});

describe("resolveCommit", () => {
  it("reads Coolify's per-deploy SOURCE_COMMIT straight from the environment", () => {
    expect(resolveCommit({ SOURCE_COMMIT: SHA })).toBe(SHA);
  });

  it("prefers an explicit MOSHI_COMMIT (a build outside Coolify)", () => {
    expect(resolveCommit({ MOSHI_COMMIT: "abc1234", SOURCE_COMMIT: SHA })).toBe("abc1234");
  });

  it("falls through an empty or placeholder MOSHI_COMMIT: the image sets it to '' by default", () => {
    for (const blank of ["", "  ", "unknown", "HEAD"]) {
      expect(resolveCommit({ MOSHI_COMMIT: blank, SOURCE_COMMIT: SHA }), JSON.stringify(blank)).toBe(SHA);
    }
  });

  it("answers 'unknown' for anything that is not a commit id, and never echoes it", () => {
    for (const junk of [undefined, "", "main", "v1.1.0", "abc12", "g".repeat(40), SHA + "0", "<script>", "abc1234\nX-Injected: 1", "$(id)"]) {
      expect(resolveCommit({ SOURCE_COMMIT: junk }), JSON.stringify(junk)).toBe("unknown");
    }
  });

  it("takes seven characters for a commit and not six", () => {
    expect(resolveCommit({ SOURCE_COMMIT: "abc1234" })).toBe("abc1234");
    expect(resolveCommit({ SOURCE_COMMIT: "abc123" })).toBe("unknown");
  });

  it("normalises case and surrounding space", () => {
    expect(resolveCommit({ SOURCE_COMMIT: `  ${SHA.toUpperCase()}\n` })).toBe(SHA);
  });
});

describe("versionLabel", () => {
  it("is version+shortsha, the semver way of naming a build", () => {
    expect(versionLabel(SHA)).toBe(`${VERSION}+${SHA.slice(0, 7)}`);
    expect(versionLabel("unknown")).toBe(VERSION);
  });
});

describe("config", () => {
  it("carries the commit", () => {
    const config = loadConfig({ MESH_ADMIN_TOKEN: "a".repeat(40), SOURCE_COMMIT: SHA });
    if (isConfigError(config)) throw new Error(config.errors.join(", "));
    expect(config.commit).toBe(SHA);
  });
});

// The Coolify trap (ocellio concept 06aa94be-ae49): a `${SOURCE_COMMIT}`
// reference in the compose file makes Coolify STORE a variable of that name,
// and a stored one hides the per-deploy value for good. ocellio reported a
// stale commit for four weeks that way.
describe("deployment files", () => {
  // Every spelling, in every such file: ARG, ENV, --build-arg, a label, a
  // compose file next to the main one. Comments may name it (they say why).
  const code = (text: string) => text.split("\n").filter((line) => !line.trim().startsWith("#")).join("\n");
  const files = readdirSync(".").filter((f) => /^(Dockerfile|docker-compose)([.-].*)?(\.ya?ml)?$/.test(f) || /^Dockerfile/.test(f));

  it("finds the files it is there to guard", () => {
    expect(files).toEqual(expect.arrayContaining(["Dockerfile", "docker-compose.yml"]));
  });

  it("never mention SOURCE_COMMIT outside a comment", () => {
    for (const file of files) expect(code(readFileSync(file, "utf-8")), file).not.toMatch(/SOURCE_COMMIT/);
  });

  it("would notice: the check sees through the spellings that slipped past its first version", () => {
    for (const line of ["ENV  SOURCE_COMMIT=x", "env SOURCE_COMMIT x", "ARG\tSOURCE_COMMIT", "LABEL commit=$SOURCE_COMMIT", "RUN echo ${SOURCE_COMMIT}", "      - MOSHI_COMMIT=${SOURCE_COMMIT:-}"]) {
      expect(code(`FROM x\n${line}\n`), line).toMatch(/SOURCE_COMMIT/);
    }
    expect(code("# never add SOURCE_COMMIT here\nFROM x\n")).not.toMatch(/SOURCE_COMMIT/);
  });
});
