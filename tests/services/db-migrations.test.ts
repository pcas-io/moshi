// The migration runner (src/services/db.ts).
//
// It used to run a file with db.exec() and record it with a second statement.
// A crash between the two left a migration applied and unrecorded: the next
// start ran `ALTER TABLE … ADD COLUMN` again and the process never came up.
// A file without its own BEGIN could also stop half way and stay that way.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, writeFileSync, rmSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { runMigrations, initDatabase, migrationBody, stripSqlComments } from "../../src/services/db";

let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "moshi-migrations-"));
  db = new Database(":memory:");
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const file = (name: string, sql: string) => writeFileSync(join(dir, name), sql);
const applied = () => (db.prepare("SELECT name FROM _migrations ORDER BY name").all() as { name: string }[]).map((r) => r.name);
const tables = () =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_%' ESCAPE '\\' ORDER BY name").all() as { name: string }[]).map((r) => r.name);

describe("runMigrations", () => {
  it("applies the repository's migrations to a fresh database and records every one", () => {
    const fresh = initDatabase(":memory:");
    const names = (fresh.prepare("SELECT name FROM _migrations ORDER BY name").all() as { name: string }[]).map((r) => r.name);
    expect(names).toEqual(readdirSync("migrations").filter((f) => f.endsWith(".sql")).sort());
    expect(fresh.inTransaction).toBe(false);
    fresh.close();
  });

  it("applies in name order and does nothing the second time", () => {
    file("0002_b.sql", "CREATE TABLE b (id INTEGER); INSERT INTO b SELECT COUNT(*) FROM a;");
    file("0001_a.sql", "CREATE TABLE a (id INTEGER);");
    file("notes.txt", "not a migration");
    expect(runMigrations(db, dir)).toEqual(["0001_a.sql", "0002_b.sql"]);
    expect(runMigrations(db, dir)).toEqual([]);
    expect(applied()).toEqual(["0001_a.sql", "0002_b.sql"]);
  });

  it("skips a migration that another process applied while this one waited for the lock", () => {
    // Two new containers on one volume start at once: the loser used to run
    // ALTER TABLE ADD COLUMN a second time and die with 'duplicate column'.
    const path = join(dir, "shared.db");
    const a = new Database(path);
    const b = new Database(path);
    try {
      file("0000_base.sql", "CREATE TABLE base (id INTEGER);");
      expect(runMigrations(a, dir)).toEqual(["0000_base.sql"]);
      file("0001_a.sql", "CREATE TABLE a (id INTEGER); ALTER TABLE a ADD COLUMN extra TEXT;");
      // A has computed its list of pending files; before it takes the lock
      // (the hook runs exactly there), B applies them.
      const done = runMigrations(a, dir, { beforeFirst: () => { expect(runMigrations(b, dir)).toEqual(["0001_a.sql"]); } });
      expect(done).toEqual([]);
      expect(a.prepare("SELECT COUNT(*) AS n FROM _migrations").get()).toEqual({ n: 2 });
      expect(a.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('a') WHERE name = 'extra'").get()).toEqual({ n: 1 });
    } finally {
      a.close();
      b.close();
    }
  });

  it("leaves nothing of a migration that fails half way, keeps the ones before it, and names the file", () => {
    file("0001_a.sql", "CREATE TABLE a (id INTEGER);");
    file("0002_broken.sql", "CREATE TABLE b (id INTEGER);\nINSERT INTO b VALUES (1);\nINSERT INTO missing VALUES (1);\nCREATE TABLE c (id INTEGER);");
    file("0003_never.sql", "CREATE TABLE d (id INTEGER);");
    expect(() => runMigrations(db, dir)).toThrow(/0002_broken\.sql/);
    expect(tables()).toEqual(["a"]);
    expect(applied()).toEqual(["0001_a.sql"]);
    expect(db.inTransaction).toBe(false);
  });

  it("records a migration in the same transaction that applies it", () => {
    // If the bookkeeping fails, the schema change must be gone as well. Before,
    // the table stayed, unrecorded, and the next start ran the file again.
    db.exec(`CREATE TABLE _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TRIGGER refuse BEFORE INSERT ON _migrations WHEN NEW.name = '0001_a.sql' BEGIN SELECT RAISE(ABORT, 'disk full'); END;`);
    for (const sql of ["CREATE TABLE a (id INTEGER);", "-- wraps itself\nBEGIN;\nCREATE TABLE a (id INTEGER);\nCOMMIT;\n"]) {
      file("0001_a.sql", sql);
      expect(() => runMigrations(db, dir)).toThrow(/disk full/);
      expect(tables()).toEqual([]);
      expect(applied()).toEqual([]);
      expect(db.inTransaction).toBe(false);
    }
  });

  it("takes over the transaction of a file that brings its own, as 0005, 0007 and 0008 do", () => {
    file("0001_wrapped.sql", "-- comment first; BEGIN is not the first line\n\nBEGIN;\nCREATE TABLE a (id INTEGER);\nINSERT INTO a VALUES (1);\nCOMMIT;\n");
    file("0002_wrapped_broken.sql", "BEGIN TRANSACTION;\nCREATE TABLE b (id INTEGER);\nINSERT INTO missing VALUES (1);\nCOMMIT;");
    expect(() => runMigrations(db, dir)).toThrow(/0002_wrapped_broken\.sql/);
    expect(tables()).toEqual(["a"]);
    expect(applied()).toEqual(["0001_wrapped.sql"]);
    expect(db.inTransaction).toBe(false);
  });

  it("refuses a file that handles transactions in the middle, before running any of it", () => {
    for (const sql of [
      "CREATE TABLE a (id INTEGER);\nCOMMIT;\nCREATE TABLE b (id INTEGER);",
      "BEGIN;\nCREATE TABLE a (id INTEGER);\nCOMMIT;\nBEGIN;\nCREATE TABLE b (id INTEGER);\nCOMMIT;",
      "CREATE TABLE a (id INTEGER);\nROLLBACK;",
      "BEGIN;\nCREATE TABLE a (id INTEGER);",
      "BEGIN;\nCREATE TABLE a (id INTEGER);\nEND TRANSACTION;",
      // No semicolon after the last statement: SQLite runs it all the same.
      "CREATE TABLE a (id INTEGER);\nCOMMIT",
      "CREATE TABLE a (id INTEGER);\nROLLBACK",
      "CREATE TABLE a (id INTEGER);\nEND",
    ]) {
      file("0001_a.sql", sql);
      expect(() => runMigrations(db, dir), sql).toThrow(/0001_a\.sql.*transaction/s);
      expect(tables(), sql).toEqual([]);
    }
  });

  it("never records a migration whose file ended the transaction behind the check's back", () => {
    // Whatever the check misses: if the runner's transaction is gone after the
    // file ran, nothing is recorded, and the error does not claim a rollback
    // that did not happen for the statements before it.
    for (const sql of ['CREATE TABLE a (id INTEGER);\n"COMMIT";\nCREATE TABLE b (id INTEGER);', "CREATE TABLE a (id INTEGER);\nCOMMIT /* done */ ;\nCREATE TABLE b (id INTEGER);"]) {
      const fresh = new Database(":memory:");
      file("0001_a.sql", sql);
      let message = "";
      try { runMigrations(fresh, dir); } catch (err) { message = String((err as Error).message); }
      expect(message, sql).toMatch(/0001_a\.sql/);
      expect((fresh.prepare("SELECT COUNT(*) AS n FROM _migrations").get() as { n: number }).n, sql).toBe(0);
      expect(fresh.inTransaction).toBe(false);
      fresh.close();
    }
  });

  it("is not confused by a trigger body, a comment or a string", () => {
    file("0001_a.sql", `-- BEGIN; COMMIT; in a comment
/* COMMIT;
   ROLLBACK; */
CREATE TABLE a (id INTEGER, note TEXT);
CREATE TABLE log (what TEXT);
CREATE TRIGGER a_ins AFTER INSERT ON a BEGIN
  INSERT INTO log VALUES ('row; COMMIT; -- not a comment');
END;
INSERT INTO a VALUES (1, 'it''s; BEGIN; here -- still the string');
`);
    expect(runMigrations(db, dir)).toEqual(["0001_a.sql"]);
    expect(db.prepare("SELECT note FROM a").get()).toEqual({ note: "it's; BEGIN; here -- still the string" });
    expect(db.prepare("SELECT what FROM log").get()).toEqual({ what: "row; COMMIT; -- not a comment" });
  });

  it("still sees an END of its own next to a trigger", () => {
    file("0001_a.sql", "CREATE TABLE a (id INTEGER);\nCREATE TRIGGER t AFTER INSERT ON a BEGIN\n  UPDATE a SET id = CASE WHEN id > 1 THEN 1 ELSE id END;\nEND;\nEND;\nCREATE TABLE b (id INTEGER);");
    expect(() => runMigrations(db, dir)).toThrow(/transaction/);
    expect(tables()).toEqual([]);
  });

  it("does not start a server on a directory without migrations", () => {
    expect(() => runMigrations(db, join(dir, "nowhere"))).toThrow(/migrations/);
  });
});

describe("migrationBody", () => {
  it("returns the statements between a file's own BEGIN and COMMIT", () => {
    expect(migrationBody("BEGIN;\nCREATE TABLE a (id INTEGER);\nCOMMIT;").trim()).toBe("CREATE TABLE a (id INTEGER);");
    expect(migrationBody("begin immediate transaction ;\nCREATE TABLE a (id INTEGER);\ncommit transaction;\n").trim()).toBe("CREATE TABLE a (id INTEGER);");
    expect(migrationBody("CREATE TABLE a (id INTEGER);").trim()).toBe("CREATE TABLE a (id INTEGER);");
  });
});

describe("stripSqlComments", () => {
  it("removes comments and keeps strings and quoted names as they are", () => {
    expect(stripSqlComments("SELECT 1; -- one\nSELECT 2; /* two\nlines */ SELECT 3;").replace(/\s+/g, " ").trim()).toBe("SELECT 1; SELECT 2; SELECT 3;");
    expect(stripSqlComments("SELECT '--x', 'a''/*b*/', \"c--d\";")).toBe("SELECT '--x', 'a''/*b*/', \"c--d\";");
    expect(stripSqlComments("SELECT 1 /* never closed")).toBe("SELECT 1  ");
    // A comment separates tokens: CREATE/**/TABLE is valid SQL, CREATETABLE is not.
    expect(stripSqlComments("CREATE/**/TABLE a (id INTEGER);")).toBe("CREATE TABLE a (id INTEGER);");
    // [bracketed] names are quoted names too.
    expect(stripSqlComments("SELECT [a--b], [c/*d*/] FROM t; -- gone")).toBe("SELECT [a--b], [c/*d*/] FROM t; ");
  });
});

describe("a copy before migrating", () => {
  it("is taken from a database that has been in use, as it was before the first pending migration", () => {
    file("0001_a.sql", "CREATE TABLE a (id INTEGER);");
    const seen: string[][] = [];
    runMigrations(db, dir, { beforeFirst: (pending) => seen.push(pending) });
    // A fresh database has nothing worth copying.
    expect(seen).toEqual([]);

    file("0002_b.sql", "CREATE TABLE b (id INTEGER);");
    file("0003_c.sql", "CREATE TABLE c (id INTEGER);");
    // Asserted out here: the runner reports a throwing hook and carries on.
    let tablesAtCopy: string[] = [];
    runMigrations(db, dir, {
      beforeFirst: (pending) => {
        seen.push(pending);
        tablesAtCopy = tables();
      },
    });
    expect(seen).toEqual([["0002_b.sql", "0003_c.sql"]]);
    expect(tablesAtCopy).toEqual(["a"]); // nothing applied yet

    runMigrations(db, dir, { beforeFirst: (pending) => seen.push(pending) });
    expect(seen).toHaveLength(1); // nothing pending, nothing copied
  });

  it("does not keep the service down when the copy fails", () => {
    file("0001_a.sql", "CREATE TABLE a (id INTEGER);");
    runMigrations(db, dir);
    file("0002_b.sql", "CREATE TABLE b (id INTEGER);");
    const problems: string[] = [];
    runMigrations(db, dir, {
      beforeFirst: () => { throw new Error("disk full"); },
      onBackupError: (err) => problems.push(String(err)),
    });
    expect(tables()).toEqual(["a", "b"]);
    expect(problems.join()).toContain("disk full");
  });

  it("happens through initDatabase when it is given a backup directory", () => {
    const root = mkdtempSync(join(tmpdir(), "moshi-init-"));
    try {
      const path = join(root, "moshi.db");
      file("0001_a.sql", "CREATE TABLE a (id INTEGER);");
      initDatabase(path, { migrationsDir: dir, backupDir: join(root, "backups") }).close();
      expect(readdirSync(root)).not.toContain("backups");

      file("0002_b.sql", "CREATE TABLE b (id INTEGER);");
      initDatabase(path, { migrationsDir: dir, backupDir: join(root, "backups") }).close();
      const copies = readdirSync(join(root, "backups"));
      expect(copies).toHaveLength(1);
      expect(copies[0]).toMatch(/^moshi-before-0002_b-\d{8}T\d{6}Z\.db$/);
      const copy = new Database(join(root, "backups", copies[0]), { readonly: true });
      expect((copy.prepare("SELECT name FROM sqlite_master WHERE name IN ('a','b') ORDER BY name").all() as { name: string }[]).map((r) => r.name)).toEqual(["a"]);
      copy.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
