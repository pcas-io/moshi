import Database from "better-sqlite3";
import { readFileSync, readdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

export function initDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

function runMigrations(db: Database.Database): void {
  db.exec("CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");

  const applied = new Set(
    db.prepare("SELECT name FROM _migrations").all().map((r: any) => r.name)
  );

  // Find migrations directory - works from src/ or dist/
  const currentDir = dirname(fileURLToPath(import.meta.url));
  let migrationsDir = join(currentDir, "../../migrations");
  if (!existsSync(migrationsDir)) {
    migrationsDir = join(currentDir, "../migrations");
  }
  if (!existsSync(migrationsDir)) {
    console.warn("No migrations directory found");
    return;
  }

  const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(migrationsDir, file), "utf-8");
    db.exec(sql);
    db.prepare("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)").run(file, new Date().toISOString());
    console.log(`Migration applied: ${file}`);
  }
}
