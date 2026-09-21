// Daily online copies of the SQLite file (src/services/backup.ts).
//
// The service holds the only copy of the history. On 2026-09-19 a copy made
// by hand before a migration brought a deleted agent back. There was no
// regular one.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync, readdirSync, writeFileSync, statSync, existsSync, mkdirSync, utimesSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { backupIfDue, backupBeforeMigration, DAILY_KEEP, BEFORE_MIGRATION_KEEP } from "../../src/services/backup";
import { initDatabase } from "../../src/services/db";

let root: string;
let dir: string;
let db: Database.Database;

const at = (iso: string) => () => new Date(iso);
const files = () => (existsSync(dir) ? readdirSync(dir).sort() : []);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "moshi-backup-"));
  dir = join(root, "backups");
  db = initDatabase(join(root, "moshi.db"));
  db.prepare("INSERT INTO agents (id, name, inbox_key, name_since, inbox_since, token_hash, is_active, created_at, updated_at) VALUES ('01A', 'scout', 'scout', 't', 't', 'h', 1, 't', 't')").run();
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("backupIfDue", () => {
  it("writes one copy a day, named after the UTC date, that opens and holds the data", () => {
    expect(backupIfDue(db, { dir, now: at("2026-09-20T03:00:00Z") })).toBe(1);
    expect(files()).toEqual(["moshi-2026-09-20.db"]);
    const copy = new Database(join(dir, "moshi-2026-09-20.db"), { readonly: true });
    expect(copy.pragma("integrity_check", { simple: true })).toBe("ok");
    expect(copy.prepare("SELECT name FROM agents").all()).toEqual([{ name: "scout" }]);
    expect((copy.prepare("SELECT COUNT(*) AS n FROM _migrations").get() as { n: number }).n).toBeGreaterThan(0);
    copy.close();

    expect(backupIfDue(db, { dir, now: at("2026-09-20T23:59:59Z") })).toBe(0);
    expect(files()).toEqual(["moshi-2026-09-20.db"]);
    expect(backupIfDue(db, { dir, now: at("2026-09-21T00:00:01Z") })).toBe(1);
    expect(files()).toEqual(["moshi-2026-09-20.db", "moshi-2026-09-21.db"]);
  });

  it("contains what is still in the write-ahead log", () => {
    db.pragma("wal_autocheckpoint = 0");
    db.prepare("UPDATE agents SET name = 'scout-eu'").run();
    backupIfDue(db, { dir, now: at("2026-09-20T03:00:00Z") });
    const copy = new Database(join(dir, "moshi-2026-09-20.db"), { readonly: true });
    expect(copy.prepare("SELECT name FROM agents").get()).toEqual({ name: "scout-eu" });
    copy.close();
  });

  it("keeps the newest seven and touches nothing that is not its own", () => {
    expect(DAILY_KEEP).toBe(7);
    mkdirSync(dir, { recursive: true });
    for (const other of ["moshi-pre-deploy-2026-09-19.db", "notes.txt", "moshi-2026-09-01.db.tmp", "moshi-2026-13-45.db.bak"]) writeFileSync(join(dir, other), "x");
    for (let day = 10; day <= 19; day++) backupIfDue(db, { dir, now: at(`2026-09-${day}T03:00:00Z`) });
    expect(files().filter((f) => /^moshi-\d{4}-\d{2}-\d{2}\.db$/.test(f))).toEqual(
      ["13", "14", "15", "16", "17", "18", "19"].map((d) => `moshi-2026-09-${d}.db`),
    );
    expect(files()).toEqual(expect.arrayContaining(["moshi-pre-deploy-2026-09-19.db", "notes.txt", "moshi-2026-13-45.db.bak"]));
  });

  it("never counts what a crash left behind as a backup, and clears it away once it is old", () => {
    mkdirSync(dir, { recursive: true });
    // A killed copy of another day, of today, and of a pre-migration copy. Each
    // writer uses a name of its own, so nobody can delete a copy in progress.
    for (const left of ["moshi-2026-09-01.db.tmp-111-aaaa", "moshi-2026-09-20.db.tmp-222-bbbb", "moshi-before-0009_x-20260901T000000Z.db.tmp-333-cccc"]) writeFileSync(join(dir, left), "half a file");
    const old = new Date("2026-09-19T00:00:00Z");
    for (const left of files()) utimesSync(join(dir, left), old, old);
    writeFileSync(join(dir, "moshi-2026-09-20.db.tmp-444-dddd"), "somebody is writing this right now");
    expect(backupIfDue(db, { dir, now: at("2026-09-20T03:00:00Z") })).toBe(1);
    expect(files()).toEqual(["moshi-2026-09-20.db", "moshi-2026-09-20.db.tmp-444-dddd"]);
  });

  it("lets two processes copy at the same moment: a rolling deploy shares the volume for seconds", () => {
    const second = new Database(join(root, "moshi.db"));
    expect(backupIfDue(db, { dir, now: at("2026-09-20T03:00:00Z") })).toBe(1);
    // The other one finds today's copy and leaves it alone.
    expect(backupIfDue(second, { dir, now: at("2026-09-20T03:00:01Z") })).toBe(0);
    // And when both start before either has finished, both finish: own temp names, last rename wins.
    rmSync(join(dir, "moshi-2026-09-20.db"));
    const a = backupBeforeMigration(db, { dir, now: at("2026-09-20T08:30:05Z") }, ["0010_x.sql"]);
    const b = backupBeforeMigration(second, { dir, now: at("2026-09-20T08:30:05Z") }, ["0010_x.sql"]);
    expect(a).toBe("moshi-before-0010_x-20260920T083005Z.db");
    expect(b).toBeNull(); // there is one for this migration already
    second.close();
  });

  it("throws away a copy that does not pass its integrity check", () => {
    expect(() => backupIfDue(db, { dir, now: at("2026-09-20T03:00:00Z"), verify: () => "*** in database main ***\nPage 3: btreeInitPage() returns error code 11" })).toThrow(/integrity/);
    expect(files()).toEqual([]);
  });

  it("keeps the copies to the service's user", () => {
    backupIfDue(db, { dir, now: at("2026-09-20T03:00:00Z") });
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "moshi-2026-09-20.db")).mode & 0o777).toBe(0o600);
  });

  it("throws when it cannot write, leaves nothing behind, and works again at the next sweep", () => {
    // A directory that cannot exist: its parent is a file.
    const impossible = join(root, "moshi.db", "backups");
    expect(() => backupIfDue(db, { dir: impossible, now: at("2026-09-20T03:00:00Z") })).toThrow();
    expect(files()).toEqual([]);
    expect(backupIfDue(db, { dir, now: at("2026-09-20T04:00:00Z") })).toBe(1);
    expect(files()).toEqual(["moshi-2026-09-20.db"]);
  });

  it("does nothing for a database that is not a file, or when told to keep none", () => {
    const memory = new Database(":memory:");
    expect(backupIfDue(memory, { dir, now: at("2026-09-20T03:00:00Z") })).toBe(0);
    memory.close();
    expect(backupIfDue(db, { dir, keep: 0, now: at("2026-09-20T03:00:00Z") })).toBe(0);
    expect(files()).toEqual([]);
  });
});

describe("backupBeforeMigration", () => {
  it("copies the database as it was, named after the first migration that is about to run", () => {
    const name = backupBeforeMigration(db, { dir, now: at("2026-09-20T08:30:05Z") }, ["0009_oauth_codes.sql", "0010_next.sql"]);
    expect(name).toBe("moshi-before-0009_oauth_codes-20260920T083005Z.db");
    expect(files()).toEqual([name]);
  });

  it("keeps the three NEWEST, whatever the migrations are called", () => {
    // Pruned by file name, a copy for a lower-numbered migration (a late branch)
    // sorted first and was deleted the moment it had been written.
    for (const [n, day] of [["0010", 21], ["0011", 22], ["0012", 23]] as const) backupBeforeMigration(db, { dir, now: at(`2026-09-${day}T08:00:00Z`) }, [`${n}_x.sql`]);
    const late = backupBeforeMigration(db, { dir, now: at("2026-09-24T08:00:00Z") }, ["0009_late_branch.sql"]);
    expect(files()).toContain(late);
    expect(files().filter((f) => f.startsWith("moshi-before-")).map((f) => f.slice(13, 17)).sort()).toEqual(["0009", "0011", "0012"]);
  });

  it("writes one copy per migration, not one per restart: a crash loop must not push the older copies out", () => {
    backupBeforeMigration(db, { dir, now: at("2026-09-10T08:00:00Z") }, ["0007_x.sql"]);
    backupBeforeMigration(db, { dir, now: at("2026-09-11T08:00:00Z") }, ["0008_x.sql"]);
    for (let restart = 0; restart < 5; restart++) {
      const name = backupBeforeMigration(db, { dir, now: at(`2026-09-20T08:00:0${restart}Z`) }, ["0009_bad.sql"]);
      expect(name === null).toBe(restart > 0);
    }
    expect(files().filter((f) => f.startsWith("moshi-before-")).map((f) => f.slice(13, 17))).toEqual(["0007", "0008", "0009"]);
  });

  it("carries no plaintext token out of the old oauth_tokens table", () => {
    db.exec("CREATE TABLE IF NOT EXISTS oauth_tokens (code TEXT PRIMARY KEY, token TEXT NOT NULL, expires_at INTEGER NOT NULL)");
    db.prepare("INSERT INTO oauth_tokens (code, token, expires_at) VALUES ('c', 'bt_plaintext_in_a_backup', 1)").run();
    const name = backupBeforeMigration(db, { dir, now: at("2026-09-20T08:30:05Z") }, ["0010_x.sql"])!;
    backupIfDue(db, { dir, now: at("2026-09-20T09:00:00Z") });
    for (const f of [name, "moshi-2026-09-20.db"]) expect(readFileSync(join(dir, f)).includes(Buffer.from("bt_plaintext_in_a_backup")), f).toBe(false);
    // The live database is not touched by that.
    expect(db.prepare("SELECT COUNT(*) AS n FROM oauth_tokens").get()).toEqual({ n: 1 });
  });

  it("keeps the last three, and they do not count against the daily seven", () => {
    expect(BEFORE_MIGRATION_KEEP).toBe(3);
    for (let n = 1; n <= 5; n++) backupBeforeMigration(db, { dir, now: at(`2026-09-2${n}T08:00:00Z`) }, [`001${n}_x.sql`]);
    for (let day = 10; day <= 17; day++) backupIfDue(db, { dir, now: at(`2026-09-${day}T03:00:00Z`) });
    expect(files().filter((f) => f.startsWith("moshi-before-"))).toHaveLength(3);
    expect(files().filter((f) => /^moshi-\d{4}-\d{2}-\d{2}\.db$/.test(f))).toHaveLength(7);
    expect(files().filter((f) => f.startsWith("moshi-before-"))[0]).toContain("0013_x");
  });

  it("refuses a migration name that would leave the directory", () => {
    expect(() => backupBeforeMigration(db, { dir, now: at("2026-09-20T08:30:05Z") }, ["../../etc/x.sql"])).toThrow();
    expect(files()).toEqual([]);
  });
});
