// docker/entrypoint.sh, run for real with stand-ins for id, find, chown and
// su-exec on the PATH. From the review: it chowned whatever
// dirname(DATABASE_PATH) came to. 'moshi.db' handed all of /app to the
// service user, '/moshi.db' would have run `chown -R` on `/`.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

let bin: string;
let calls: string;

beforeAll(() => {
  bin = mkdtempSync(join(tmpdir(), "moshi-entrypoint-"));
  calls = join(bin, "calls.log");
  const stub = (name: string, body: string) => { writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`); chmodSync(join(bin, name), 0o755); };
  stub("id", 'if [ "$1" = "-u" ] && [ -z "${2:-}" ]; then echo "${FAKE_UID:-0}"; else echo 1000; fi');
  stub("find", 'echo "$1/not-ours"');          // "something in there does not belong to node"
  stub("mkdir", `echo "mkdir $*" >> "${calls}"`);
  stub("chown", `echo "chown $*" >> "${calls}"`);
  stub("su-exec", `echo "su-exec $*" >> "${calls}"`);
});
afterAll(() => rmSync(bin, { recursive: true, force: true }));

function run(env: Record<string, string>) {
  if (existsSync(calls)) rmSync(calls);
  const r = spawnSync("sh", [resolve("docker/entrypoint.sh"), "node", "server"], {
    env: { PATH: `${bin}:/usr/bin:/bin`, ...env }, encoding: "utf-8",
  });
  const log = existsSync(calls) ? readFileSync(calls, "utf-8").trim().split("\n") : [];
  return { code: r.status, out: `${r.stdout}${r.stderr}`, chowns: log.filter((l) => l.startsWith("chown")), exec: log.filter((l) => l.startsWith("su-exec")) };
}

describe("docker/entrypoint.sh", () => {
  it("hands the data directory over and drops root", () => {
    const r = run({ DATABASE_PATH: "/data/moshi.db" });
    expect(r.chowns).toEqual(["chown -R node:node /data"]);
    expect(r.exec).toEqual(["su-exec node node server"]);
  });

  it("uses /data/moshi.db when nothing is set, like the image does", () => {
    expect(run({}).chowns).toEqual(["chown -R node:node /data"]);
  });

  it("never touches a directory it has no business in, and still starts the service", () => {
    for (const path of ["moshi.db", "./moshi.db", ":memory:", "/moshi.db", "/app/moshi.db", "/app/db/moshi.db", "db/moshi.db", "/data/../moshi.db", "/data/../etc/x/moshi.db", ""]) {
      const r = run({ DATABASE_PATH: path });
      expect(r.chowns, JSON.stringify(path)).toEqual(path === "" ? ["chown -R node:node /data"] : []);
      expect(r.exec, JSON.stringify(path)).toEqual(["su-exec node node server"]);
      if (path !== "" && path !== ":memory:") expect(r.out, JSON.stringify(path)).toContain("not handing");
    }
  });

  it("hands over a backup directory of its own, the directory and not what is in it", () => {
    const r = run({ DATABASE_PATH: "/data/moshi.db", BACKUP_DIR: "/backups/moshi" });
    expect(r.chowns).toEqual(["chown -R node:node /data", "chown node:node /backups/moshi"]);
    // …and not at all when it is inside the data directory, or somewhere it must not reach.
    expect(run({ DATABASE_PATH: "/data/moshi.db", BACKUP_DIR: "/data/backups" }).chowns).toEqual(["chown -R node:node /data"]);
    expect(run({ DATABASE_PATH: "/data/moshi.db", BACKUP_DIR: "/" }).chowns).toEqual(["chown -R node:node /data"]);
    expect(run({ DATABASE_PATH: "/data/moshi.db", BACKUP_DIR: "/app/backups" }).chowns).toEqual(["chown -R node:node /data"]);
  });

  it("changes nothing when it was not started as root", () => {
    const r = run({ DATABASE_PATH: "/data/moshi.db", FAKE_UID: "1000" });
    expect(r.chowns).toEqual([]);
    expect(r.exec).toEqual([]);
  });
});
