// Which jobs the hourly sweep runs, and in which order
// (src/services/maintenance-tasks.ts). The list used to be built inside
// src/index.tsx, which no test can import: the backup task could be deleted
// there with the whole suite green.

import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync, readdirSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { initDatabase } from "../../src/services/db";
import { ActivityService } from "../../src/services/activity";
import { maintenanceTasks, BACKUP_TASK } from "../../src/services/maintenance-tasks";

describe("maintenanceTasks", () => {
  it("cleans up first and copies last, so a copy never carries what was about to be deleted", () => {
    const db = new Database(":memory:");
    const names = maintenanceTasks({ db, activity: new ActivityService(initDatabase(":memory:")), backupDir: "/data/backups", backupKeep: 7 }).map((t) => t.name);
    expect(names).toEqual(["oauth_codes", "oauth_tokens (legacy)", "expired_unread", "messages", "message_reads", "send_attempts", "activity_log", BACKUP_TASK]);
  });

  it("has no backup task without a directory, or when told to keep none", () => {
    const db = initDatabase(":memory:");
    const activity = new ActivityService(db);
    expect(maintenanceTasks({ db, activity, backupDir: null, backupKeep: 7 }).map((t) => t.name)).not.toContain(BACKUP_TASK);
    expect(maintenanceTasks({ db, activity, backupDir: "/data/backups", backupKeep: 0 }).map((t) => t.name)).not.toContain(BACKUP_TASK);
  });

  it("really writes the copy when the sweep runs", () => {
    const root = mkdtempSync(join(tmpdir(), "moshi-maintenance-"));
    try {
      const db = initDatabase(join(root, "moshi.db"));
      const tasks = maintenanceTasks({ db, activity: new ActivityService(db), backupDir: join(root, "backups"), backupKeep: 7 });
      const counts = Object.fromEntries(tasks.map((t) => [t.name, t.run()]));
      expect(counts[BACKUP_TASK]).toBe(1);
      expect(existsSync(join(root, "backups"))).toBe(true);
      expect(readdirSync(join(root, "backups")).filter((f) => /^moshi-\d{4}-\d{2}-\d{2}\.db$/.test(f))).toHaveLength(1);
      db.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
