import Database from "better-sqlite3";
import { readFileSync, readdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

export interface InitOptions {
  /** Where the .sql files are. Tests build a database "as it was before". */
  migrationsDir?: string;
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
  const applied = runMigrations(db, opts.migrationsDir);
  if (applied > 0) {
    // After a schema change the file is written anew and the log is folded
    // in. Migration 0009 dropped a table of plaintext tokens: DROP TABLE frees
    // pages as they are, and what main had deleted over the months sat in
    // free space as well. Neither a backup nor a volume snapshot should find
    // them. Rare (deploys with a migration) and quick (the file is small).
    try {
      db.exec("VACUUM");
      db.pragma("wal_checkpoint(TRUNCATE)");
    } catch (err) {
      console.warn(`Database not compacted after migrating: ${String(err)}`);
    }
  }
  return db;
}

function runMigrations(db: Database.Database, dir?: string): number {
  db.exec("CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");

  const applied = new Set(
    db.prepare("SELECT name FROM _migrations").all().map((r: any) => r.name)
  );

  // Find migrations directory - works from src/ or dist/
  const currentDir = dirname(fileURLToPath(import.meta.url));
  let migrationsDir = dir ?? join(currentDir, "../../migrations");
  if (!existsSync(migrationsDir)) {
    migrationsDir = join(currentDir, "../migrations");
  }
  if (!existsSync(migrationsDir)) {
    console.warn("No migrations directory found");
    return 0;
  }

  let count = 0;
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(migrationsDir, file), "utf-8");
    db.exec(sql);
    db.prepare("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)").run(file, new Date().toISOString());
    console.log(`Migration applied: ${file}`);
    count++;
  }
  return count;
}
