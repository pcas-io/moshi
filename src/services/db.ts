import Database from "better-sqlite3";
import { readFileSync, readdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { backupBeforeMigration } from "./backup.js";

export interface InitOptions {
  /** Where a copy goes before pending migrations touch a database that has
   *  been in use. Null or absent: no copy. */
  backupDir?: string | null;
  migrationsDir?: string;
  onLog?: (level: "info" | "error", msg: string, extra: Record<string, unknown>) => void;
}

export function initDatabase(dbPath: string, opts: InitOptions = {}): Database.Database {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  // Deleted content is overwritten with zeros instead of staying in the file
  // until the page happens to be reused. What is deleted here: bearer-token
  // hashes of revoked agents, expired OAuth rows, message payloads past
  // their retention.
  db.pragma("secure_delete = ON");
  const backupDir = opts.backupDir ?? null;
  const applied = runMigrations(db, opts.migrationsDir, {
    beforeFirst: backupDir
      ? (pending) => {
          const name = backupBeforeMigration(db, { dir: backupDir }, pending);
          if (name) opts.onLog?.("info", "database copied before migrating", { file: name, pending });
        }
      : undefined,
    onBackupError: (err) => opts.onLog?.("error", "could not copy the database before migrating, migrating anyway", { err: String(err) }),
  });
  if (applied.length > 0) {
    // After a schema change the file is written anew and the log is folded
    // in. Migration 0009 emptied a table of plaintext tokens: DELETE and DROP
    // free pages as they are, and what main had deleted over the months sat
    // in free space as well. Neither a backup nor a volume snapshot should
    // find them. Rare (deploys with a migration) and quick (the file is small).
    try {
      db.exec("VACUUM");
      db.pragma("wal_checkpoint(TRUNCATE)");
    } catch (err) {
      opts.onLog?.("error", "database not compacted after migrating", { err: String(err) });
    }
  }
  return db;
}

// --- Migrations ---
//
// One migration, one transaction, and the row in `_migrations` is part of it.
//
// It used to be `db.exec(file)` and then a separate INSERT. A crash between
// the two left a migration applied and unrecorded, the next start ran
// `ALTER TABLE … ADD COLUMN` a second time, and the process never came up
// again. A file without a BEGIN of its own could also stop half way.
//
// Some files bring their own `BEGIN; … COMMIT;` (0005, 0007, 0008, 0009).
// The runner takes that pair off and owns the transaction, so the bookkeeping
// row goes inside. Anything else to do with transactions in a file is refused
// before a single statement has run.
//
// Note for authors: `PRAGMA foreign_keys` does nothing inside a transaction.
// A migration that has to rebuild a table with foreign keys off needs a
// change to this runner first, not a PRAGMA in the file.

/** Where the .sql files are: next to `src/`, or next to `dist/`. */
function defaultMigrationsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const fromSrc = join(here, "../../migrations");
  return existsSync(fromSrc) ? fromSrc : join(here, "../migrations");
}

/** `sql` without `-- …` and `/* … *\/` comments. Strings and quoted names stay as they are. */
export function stripSqlComments(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === "'" || ch === '"' || ch === "`") {
      // A quoted run ends at the same quote; a doubled quote is an escape.
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === ch) {
          if (sql[j + 1] === ch) { j += 2; continue; }
          break;
        }
        j++;
      }
      out += sql.slice(i, j + 1);
      i = j + 1;
    } else if (ch === "[") {
      // [bracketed name]: quoted too, no escape inside.
      const end = sql.indexOf("]", i + 1);
      const stop = end === -1 ? sql.length : end + 1;
      out += sql.slice(i, stop);
      i = stop;
    } else if (ch === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end; // the newline stays
    } else if (ch === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
      out += " "; // a comment separates tokens: CREATE/**/TABLE
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

const LEADING_BEGIN = /^\s*BEGIN(\s+(DEFERRED|IMMEDIATE|EXCLUSIVE))?(\s+TRANSACTION)?\s*;/i;
const TRAILING_COMMIT = /COMMIT(\s+TRANSACTION)?\s*;\s*$/i;
// A statement of its own. A trigger body's BEGIN is followed by statements,
// not by a semicolon; its `END;` looks exactly like the end of a transaction,
// so trigger bodies are taken out before this is applied.
const TRIGGER_BODY = /\bCREATE\s+(TEMP(ORARY)?\s+)?TRIGGER\b[\s\S]*?\bBEGIN\b[\s\S]*?;\s*END\s*;/gi;
const TRANSACTION_STATEMENT =
  /(^|;)\s*(BEGIN(\s+(DEFERRED|IMMEDIATE|EXCLUSIVE))?(\s+TRANSACTION)?|COMMIT(\s+TRANSACTION)?|END(\s+TRANSACTION)?|ROLLBACK(\s+TRANSACTION)?)\s*(;|$)/i;

/**
 * The statements of a migration, without comments and without the file's own
 * `BEGIN; … COMMIT;` pair. Throws when the file does anything else with
 * transactions.
 */
export function migrationBody(sql: string): string {
  let body = stripSqlComments(sql);
  const begins = LEADING_BEGIN.test(body);
  const commits = TRAILING_COMMIT.test(body);
  if (begins !== commits) {
    throw new Error("transaction handling: a BEGIN at the top needs a COMMIT at the end, and the other way round");
  }
  if (begins) body = body.replace(LEADING_BEGIN, "").replace(TRAILING_COMMIT, "");
  // String contents are blanked for this check only, so `'; COMMIT;'` inside
  // a value is not mistaken for a statement.
  const statements = body.replace(/'(?:[^']|'')*'/g, "''").replace(TRIGGER_BODY, ";");
  if (TRANSACTION_STATEMENT.test(statements)) {
    throw new Error("transaction handling: BEGIN, COMMIT, END or ROLLBACK inside the file. The runner owns the transaction");
  }
  return body;
}

/**
 * Applies every `*.sql` in `dir` that `_migrations` does not list yet, in name
 * order. Returns the names it applied. Throws on the first failure, naming
 * the file; that migration has then left no trace.
 */
export interface MigrationHooks {
  /** Called once, before the first pending migration, and only for a database
   *  that already has migrations behind it. The moment for a safety copy. */
  beforeFirst?: (pending: string[]) => void;
  /** A failing copy is reported here and does not stop the migration: a
   *  service that stays down because its safety net tore is the worse outcome. */
  onBackupError?: (err: unknown) => void;
}

export function runMigrations(
  db: Database.Database,
  dir: string = defaultMigrationsDir(),
  hooks: MigrationHooks = {},
): string[] {
  if (!existsSync(dir)) {
    // No schema, no service. This used to be a warning and a process that
    // failed on its first query.
    throw new Error(`migrations directory not found: ${dir}`);
  }
  db.exec("CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  const applied = new Set((db.prepare("SELECT name FROM _migrations").all() as { name: string }[]).map((r) => r.name));
  const record = db.prepare("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)");

  const pending = readdirSync(dir).filter((f) => f.endsWith(".sql") && !applied.has(f)).sort();
  if (pending.length > 0 && applied.size > 0 && hooks.beforeFirst) {
    try {
      hooks.beforeFirst(pending);
    } catch (err) {
      hooks.onBackupError?.(err);
    }
  }

  const done: string[] = [];
  for (const file of pending) {
    try {
      const body = migrationBody(readFileSync(join(dir, file), "utf-8"));
      db.transaction(() => {
        db.exec(body);
        // Whatever the check above missed: if the file ended this transaction,
        // what it did is committed or gone already, and recording it now would
        // be a guess. Say so and record nothing.
        if (!db.inTransaction) throw new Error("transaction handling: the file ended the runner's transaction");
        record.run(file, new Date().toISOString());
      }).immediate();
    } catch (err) {
      // A failing statement inside exec() can leave the transaction open.
      if (db.inTransaction) db.exec("ROLLBACK");
      const message = (err as Error).message;
      // Do not promise a rollback that could not happen any more.
      const outcome = /ended the runner's transaction|no transaction is active/.test(message) ? "failed, and the database may hold part of it" : "failed and was rolled back";
      throw new Error(`migration ${file} ${outcome}: ${message}`, { cause: err });
    }
    done.push(file);
    console.log(`Migration applied: ${file}`);
  }
  return done;
}
