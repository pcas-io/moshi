// Migration 0009 on a database that still has the old table — the live case.
//
// `oauth_tokens` held the bearer token in plaintext until the exchange (or,
// for an abandoned sign-in, until the hourly cleanup). Its rows go. The table
// itself stays for one release, because the release before this one cannot
// sign anybody in without it. Its successor never sees a token it could read
// back on its own.

import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { readFileSync, readdirSync, mkdtempSync, rmSync, existsSync, copyFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { initDatabase } from "../../src/services/db";
import { purgeLegacyOAuthTokens } from "../../src/oauth-codes";

const MIGRATION = "0009_oauth_codes.sql";

function legacyDb(): Database.Database {
  const db = new Database(":memory:");
  for (const file of readdirSync("migrations").filter((f) => f.endsWith(".sql") && f < MIGRATION).sort()) {
    db.exec(readFileSync(`migrations/${file}`, "utf-8"));
  }
  db.prepare("INSERT INTO oauth_tokens (code, token, expires_at) VALUES (?, ?, ?)").run("1790000000000.abc", "bt_plaintext_left_behind", Date.now() + 60_000);
  return db;
}

const tables = (db: Database.Database) =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);

describe("migration 0009 — oauth codes", () => {
  it("empties the plaintext table and keeps it for one release, so a rollback still signs in", () => {
    // The commit before this one needs `oauth_tokens`: without the table its
    // POST /oauth/authorize is an HTTP 500, for every connector, until somebody
    // recreates it by hand. 0004 is recorded as applied, so nothing would.
    const db = legacyDb();
    db.exec(readFileSync(`migrations/${MIGRATION}`, "utf-8"));
    expect(tables(db)).toContain("oauth_tokens");
    expect(db.prepare("SELECT COUNT(*) AS n FROM oauth_tokens").get()).toEqual({ n: 0 });
    expect(tables(db)).toContain("oauth_codes");
    expect(db.prepare("SELECT COUNT(*) AS n FROM oauth_codes").get()).toEqual({ n: 0 });
    // What the old code does on a sign-in still works on this schema.
    db.prepare("INSERT OR REPLACE INTO oauth_tokens (code, token, expires_at) VALUES (?, ?, ?)").run("c", "t", 1);
  });

  it("has no column a token or a code could sit in unprotected", () => {
    const db = legacyDb();
    db.exec(readFileSync(`migrations/${MIGRATION}`, "utf-8"));
    const columns = (db.prepare("PRAGMA table_info(oauth_codes)").all() as { name: string }[]).map((c) => c.name).sort();
    expect(columns).toEqual(["code_challenge", "code_hash", "expires_at", "token_sealed"]);
  });

  it("runs in one transaction: a failure leaves the old table as it was", () => {
    const db = legacyDb();
    db.exec("CREATE TABLE oauth_codes (clash INTEGER)"); // makes the CREATE in 0009 fail
    expect(() => db.exec(readFileSync(`migrations/${MIGRATION}`, "utf-8"))).toThrow();
    if (db.inTransaction) db.exec("ROLLBACK");
    expect(tables(db)).toContain("oauth_tokens");
    expect(db.prepare("SELECT COUNT(*) AS n FROM oauth_tokens").get()).toEqual({ n: 1 });
  });

  it("is followed by a sweep: what a rolled-back release wrote does not outlive the roll-forward", () => {
    const db = legacyDb();
    db.exec(readFileSync(`migrations/${MIGRATION}`, "utf-8"));
    db.prepare("INSERT INTO oauth_tokens (code, token, expires_at) VALUES (?, ?, ?)").run("rollback", "bt_written_by_the_old_code", Date.now() + 60_000);
    expect(purgeLegacyOAuthTokens(db)).toBe(1);
    expect(purgeLegacyOAuthTokens(db)).toBe(0);
    // …and it is no error once a later migration has dropped the table.
    db.exec("DROP TABLE oauth_tokens");
    expect(purgeLegacyOAuthTokens(db)).toBe(0);
  });
});

// SQL cannot see this one. DROP TABLE hands the pages to the free list as
// they are, and the token of the last agent that signed in through OAuth
// stayed readable in the file (and in its -wal) until something overwrote it.
describe("migration 0009 — the file, not the schema", () => {
  const PLAINTEXT = "bt_plaintext_left_behind";
  const inFile = (path: string) => existsSync(path) && readFileSync(path).includes(Buffer.from(PLAINTEXT));

  it("leaves no token in the database file or its write-ahead log, waiting or long redeemed", () => {
    const root = mkdtempSync(join(tmpdir(), "moshi-0009-"));
    try {
      // The database as production has it: everything before 0009, through the app's own runner.
      const before = join(root, "before");
      mkdirSync(before);
      for (const f of readdirSync("migrations").filter((x) => x.endsWith(".sql") && x < MIGRATION)) copyFileSync(join("migrations", f), join(before, f));
      const path = join(root, "moshi.db");
      // Opened the way main opened it: WAL, and NO secure_delete. Going through
      // today's initDatabase here would zero the deleted rows before the test begins.
      const old = new Database(path);
      old.pragma("journal_mode = WAL");
      old.exec("CREATE TABLE _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
      for (const f of readdirSync(before).sort()) {
        old.exec(readFileSync(join(before, f), "utf-8"));
        old.prepare("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)").run(f, "2026-09-01T00:00:00.000Z");
      }
      const insert = old.prepare("INSERT INTO oauth_tokens (code, token, expires_at) VALUES (?, ?, ?)");
      insert.run("1790000000000.waiting", `${PLAINTEXT}_waiting`, Date.now() + 60_000);
      insert.run("1790000000000.redeemed", `${PLAINTEXT}_redeemed`, Date.now() + 60_000);
      old.prepare("DELETE FROM oauth_tokens WHERE code = ?").run("1790000000000.redeemed"); // what main did after an exchange
      // Many at once, redeemed long ago: their pages went to the free list. secure_delete
      // alone does not reach those (137 of 200 stayed readable); rebuilding the file does.
      for (let i = 0; i < 200; i++) insert.run(`1790000000000.bulk${i}`, `${PLAINTEXT}_bulk_${i}_${"x".repeat(200)}`, Date.now() + 60_000);
      old.prepare("DELETE FROM oauth_tokens WHERE code LIKE '1790000000000.bulk%'").run();
      old.pragma("wal_checkpoint(TRUNCATE)");
      old.close();
      expect(inFile(path)).toBe(true); // the premise

      const db = initDatabase(path);
      expect(inFile(path)).toBe(false);
      expect(inFile(`${path}-wal`)).toBe(false);
      db.close();
      expect(inFile(path)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("overwrites what is deleted from now on, instead of leaving it in the file until the page is reused", () => {
    const root = mkdtempSync(join(tmpdir(), "moshi-secure-delete-"));
    try {
      const path = join(root, "moshi.db");
      const db = initDatabase(path);
      db.prepare("INSERT INTO oauth_codes (code_hash, token_sealed, code_challenge, expires_at) VALUES (?, ?, ?, ?)").run("h", `${PLAINTEXT}_row`, "c", 1);
      db.pragma("wal_checkpoint(TRUNCATE)");
      expect(inFile(path)).toBe(true);
      db.prepare("DELETE FROM oauth_codes").run();
      db.pragma("wal_checkpoint(TRUNCATE)");
      expect(inFile(path)).toBe(false);
      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
