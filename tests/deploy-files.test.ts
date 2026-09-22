// docker-compose.yml is configuration nobody executes in a test. These are
// the lines that were missing or drifting, pinned.

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { SHUTDOWN_BUDGET_MS, SHUTDOWN_STEP_TIMEOUTS_MS } from "../src/services/shutdown";

const compose = readFileSync("docker-compose.yml", "utf-8");
const service = (name: string): string => {
  const start = compose.indexOf(`\n  ${name}:\n`);
  if (start === -1) return "";
  const rest = compose.slice(start + 1);
  const next = rest.slice(1).search(/\n  [a-z][a-z0-9_-]*:\n|\nvolumes:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
};

describe("docker-compose.yml", () => {
  it("says that a proxy is in front: the container is reachable through it only", () => {
    // Without this the app believes the socket alone, and behind the proxy
    // every client has the proxy's address: one count for everybody.
    expect(service("moshi")).toMatch(/- MESH_BEHIND_PROXY=\$\{MESH_BEHIND_PROXY:-1\}/);
    expect(service("moshi")).toMatch(/\n    expose:\n/);
    expect(service("moshi")).not.toMatch(/\n    ports:\n/);
  });

  it("hands MESH_CSP to the container: a switch that never arrives switches nothing", () => {
    expect(service("moshi")).toMatch(/- MESH_CSP=\$\{MESH_CSP:-\}/);
  });

  it("hands MESH_ADMIN_TOKEN_PREVIOUS to the container: the rotation DEPLOY.md describes never arrived", () => {
    expect(service("moshi")).toMatch(/- MESH_ADMIN_TOKEN_PREVIOUS=\$\{MESH_ADMIN_TOKEN_PREVIOUS:-\}/);
  });

  it("restarts both services unless somebody stopped them", () => {
    expect(service("moshi")).toMatch(/\n    restart: unless-stopped\n/);
    expect(service("nats")).toMatch(/\n    restart: unless-stopped\n/);
  });

  it("gives the app longer to stop than its shutdown can take", () => {
    // The budget is a constant the process itself uses (src/services/shutdown.ts),
    // not a number this test fishes out of src/index.tsx with a regex: that one
    // skipped what it could not parse and passed with a 41 s budget.
    const grace = /^\s*stop_grace_period: (\d+)s\s*$/m.exec(service("moshi"));
    expect(grace).not.toBeNull();
    expect(Number(grace![1]) * 1000).toBeGreaterThanOrEqual(SHUTDOWN_BUDGET_MS);
    expect(SHUTDOWN_BUDGET_MS).toBeGreaterThan(10_000);
    // …and the process really uses those constants.
    const index = readFileSync("src/index.tsx", "utf-8");
    expect(index).not.toMatch(/timeoutMs: [0-9]/);
    expect(index.match(/timeoutMs: SHUTDOWN_STEP_TIMEOUTS_MS\./g)).toHaveLength(Object.keys(SHUTDOWN_STEP_TIMEOUTS_MS).length);
  });

  it("passes the backup settings on", () => {
    expect(service("moshi")).toMatch(/- BACKUP_DIR=\$\{BACKUP_DIR:-\}/);
    expect(service("moshi")).toMatch(/- BACKUP_KEEP=\$\{BACKUP_KEEP:-\}/);
  });

  it("runs the broker version the integration tests run against, by tag", () => {
    const tested = /nats:(\d+\.\d+\.\d+)-alpine/.exec(readFileSync("scripts/test-integration.sh", "utf-8"));
    expect(tested).not.toBeNull();
    // The LIVE image line, comments aside: a commented-out old pin above another
    // image used to satisfy a plain toContain.
    const images = service("nats").split("\n").filter((l) => !l.trim().startsWith("#")).map((l) => /^\s*image:\s*(\S+)\s*$/.exec(l)?.[1]).filter(Boolean);
    expect(images).toEqual([`nats:${tested![1]}-alpine`]);
  });
});
