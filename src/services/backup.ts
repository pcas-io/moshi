// Online copies of the SQLite file, on the same volume.
//
// `VACUUM INTO` reads through the write-ahead log, needs no pause, and writes
// a compact file without free pages, so nothing deleted rides along. It runs
// inside the hourly maintenance sweep and is due once per UTC day.
//
// A second kind is taken right before pending migrations run, because that is
// the moment a copy has actually been needed (incident of 2026-09-19).
//
// Same volume means: this protects against a bad migration, a bad delete and
// a bad deploy, not against losing the volume. Offsite is a separate step.

import type Database from "better-sqlite3";
import DatabaseCtor from "better-sqlite3";
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "fs";
import { randomBytes } from "node:crypto";
import { join } from "path";

export const DAILY_KEEP = 7;
export const BEFORE_MIGRATION_KEEP = 3;

const DAILY = /^moshi-\d{4}-\d{2}-\d{2}\.db$/;
const BEFORE_MIGRATION = /^moshi-before-([A-Za-z0-9_.-]+)-(\d{8}T\d{6}Z)\.db$/;
/** A copy somebody is writing, or was writing when it died. */
const PARTIAL = /^moshi-[A-Za-z0-9_.-]+\.db\.tmp-\d+-[0-9a-f]+(-journal)?$/;
/** Older than this, nobody is writing it any more. */
const PARTIAL_MAX_AGE_MS = 60 * 60_000;

export interface BackupOptions {
  dir: string;
  /** How many daily copies stay. 0 switches backups off. */
  keep?: number;
  now?: () => Date;
  /** The integrity verdict of a finished copy ("ok" passes). Tests replace it. */
  verify?: (path: string) => string;
}

function integrityOf(path: string): string {
  const copy = new DatabaseCtor(path, { readonly: true });
  try {
    return String(copy.pragma("integrity_check", { simple: true }));
  } finally {
    copy.close();
  }
}

/** The release before migration 0009 kept bearer tokens in plaintext in
 *  `oauth_tokens`, and the table stays for one release. A copy is for getting
 *  agents and history back, not for carrying tokens around: they are taken
 *  out of the COPY, never out of the live database. */
function scrub(path: string): void {
  const copy = new DatabaseCtor(path);
  try {
    const there = copy.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'oauth_tokens'").get();
    if (!there || (copy.prepare("SELECT COUNT(*) AS n FROM oauth_tokens").get() as { n: number }).n === 0) return;
    copy.pragma("secure_delete = ON");
    copy.exec("DELETE FROM oauth_tokens");
    copy.exec("VACUUM");
  } finally {
    copy.close();
  }
}

const isFileDatabase = (db: Database.Database): boolean => db.name !== "" && db.name !== ":memory:" && !db.memory;

/** Writes `name` into `dir` via a temporary file of this writer's own,
 *  checks it, and returns its path. */
function copyTo(db: Database.Database, opts: BackupOptions, name: string): string {
  const { dir } = opts;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Best effort: a directory on a volume of its own may belong to somebody
  // else and still be writable.
  try { chmodSync(dir, 0o700); } catch { /* not ours to change */ }
  const target = join(dir, name);
  // A name of this writer's own. With one fixed name, two processes copying
  // at once (a rolling deploy shares the volume) deleted each other's file,
  // and a killed copy blocked nothing but was never cleared away either.
  const partial = `${target}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    db.prepare("VACUUM INTO ?").run(partial);
    scrub(partial);
    // A copy that does not open is worse than none: it looks like a backup.
    const verdict = (opts.verify ?? integrityOf)(partial);
    if (verdict !== "ok") throw new Error(`backup failed its integrity check: ${verdict.split("\n")[0]}`);
    chmodSync(partial, 0o600);
    renameSync(partial, target);
  } catch (err) {
    rmSync(partial, { force: true });
    rmSync(`${partial}-journal`, { force: true });
    throw err;
  }
  return target;
}

/** Clears away what a killed copy left behind, once nobody can be writing it. */
function sweepPartials(dir: string, now: Date): void {
  for (const file of readdirSync(dir)) {
    if (!PARTIAL.test(file)) continue;
    try {
      if (now.getTime() - statSync(join(dir, file)).mtimeMs > PARTIAL_MAX_AGE_MS) rmSync(join(dir, file), { force: true });
    } catch { /* gone in the meantime */ }
  }
}

/** Deletes all but the newest `keep` files matching `pattern`. `when` names
 *  the part of a file name that says how old it is. */
function prune(dir: string, pattern: RegExp, keep: number, when: (name: string) => string): void {
  const mine = readdirSync(dir).filter((f) => pattern.test(f)).sort((a, b) => when(a).localeCompare(when(b)));
  for (const old of mine.slice(0, Math.max(0, mine.length - keep))) rmSync(join(dir, old), { force: true });
}

/**
 * Writes today's copy unless there is one. Returns 1 when it wrote one, else 0,
 * so it fits the maintenance sweep. Throws when the copy cannot be written;
 * the next sweep tries again.
 */
export function backupIfDue(db: Database.Database, opts: BackupOptions): number {
  const keep = opts.keep ?? DAILY_KEEP;
  if (keep <= 0 || !isFileDatabase(db)) return 0;
  const today = (opts.now?.() ?? new Date()).toISOString().slice(0, 10);
  const name = `moshi-${today}.db`;
  if (existsSync(join(opts.dir, name))) return 0;
  copyTo(db, opts, name);
  prune(opts.dir, DAILY, keep, (f) => f);
  sweepPartials(opts.dir, opts.now?.() ?? new Date());
  return 1;
}

/**
 * A copy of the database as it is, before `pending` migrations touch it.
 * Returns the file name, or null when there is nothing to copy.
 */
export function backupBeforeMigration(db: Database.Database, opts: BackupOptions, pending: string[]): string | null {
  if ((opts.keep ?? DAILY_KEEP) <= 0 || !isFileDatabase(db) || pending.length === 0) return null;
  const first = pending[0].replace(/\.sql$/, "");
  if (!/^[A-Za-z0-9_.-]+$/.test(first) || first.includes("..")) throw new Error(`not a migration name: ${pending[0]}`);
  // One copy per migration, not one per start. A migration that fails keeps
  // the service restarting, every start wrote an identical copy, and three
  // restarts later the copies of the migrations before it were gone.
  if (existsSync(opts.dir) && readdirSync(opts.dir).some((f) => BEFORE_MIGRATION.exec(f)?.[1] === first)) return null;
  const stamp = (opts.now?.() ?? new Date()).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const name = `moshi-before-${first}-${stamp}.db`;
  copyTo(db, opts, name);
  // Newest by the time in the name. Sorted by whole name, the copy for a
  // lower-numbered migration was the "oldest" and went the moment it was written.
  prune(opts.dir, BEFORE_MIGRATION, BEFORE_MIGRATION_KEEP, (f) => BEFORE_MIGRATION.exec(f)?.[2] ?? "");
  return name;
}
