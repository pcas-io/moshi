// The README's environment table against the code that reads the environment.
// The table used to claim MESH_COOKIE_SECRET was derived from the admin token
// and to leave out five variables; nothing noticed for months.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const README_VARS = [...readFileSync("README.md", "utf-8").matchAll(/^\| `([A-Z][A-Z0-9_]*)` \|/gm)].map((m) => m[1]);

/** Every `env.FOO` the configuration layer reads. */
const CODE_VARS = [
  ...readFileSync("src/config.ts", "utf-8").matchAll(/env\.([A-Z][A-Z0-9_]*)/g),
  ...readFileSync("src/version.ts", "utf-8").matchAll(/env\.([A-Z][A-Z0-9_]*)/g),
].map((m) => m[1]);

describe("README environment table", () => {
  it("lists every variable the code reads, and nothing the code does not", () => {
    expect([...new Set(README_VARS)].sort()).toEqual([...new Set(CODE_VARS)].sort());
  });

  it("names each variable once", () => {
    expect(README_VARS).toEqual([...new Set(README_VARS)]);
  });

  it("says the same defaults the code applies", () => {
    const config = readFileSync("src/config.ts", "utf-8");
    const row = (name: string) => README_VARS.includes(name)
      ? /(.*)/.exec(readFileSync("README.md", "utf-8").split("\n").find((l) => l.startsWith(`| \`${name}\` |`))!)![1]
      : "";
    // Each default below is written in src/config.ts as `env.X ?? "default"`.
    for (const [name, value] of [["NATS_URL", "nats://localhost:4222"], ["DATABASE_PATH", "./mesh.db"], ["PORT", "3000"]] as const) {
      expect(config, name).toContain(`env.${name} ?? "${value}"`);
      expect(row(name), name).toContain(value);
    }
  });
});
