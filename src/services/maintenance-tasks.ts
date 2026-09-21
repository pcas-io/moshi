// Which jobs the hourly sweep runs, and in which order. Out of src/index.tsx
// so that a test can see the list: the bootstrap cannot be imported.

import type Database from "better-sqlite3";
import type { ActivityService } from "./activity.js";
import type { MaintenanceTask } from "./maintenance.js";
import { backupIfDue } from "./backup.js";
import { cleanupExpiredOAuthCodes, purgeLegacyOAuthTokens } from "../oauth-codes.js";
import { MESSAGE_RETENTION_DAYS, ACTIVITY_RETENTION_DAYS } from "../types.js";

export const BACKUP_TASK = "backup";

export interface MaintenanceDeps {
  db: Database.Database;
  activity: Pick<ActivityService, "rotate" | "rotateMessages">;
  backupDir: string | null;
  backupKeep: number;
}

export function maintenanceTasks({ db, activity, backupDir, backupKeep }: MaintenanceDeps): MaintenanceTask[] {
  return [
    { name: "oauth_codes", run: () => cleanupExpiredOAuthCodes(db) },
    // Plaintext rows of a rolled-back release. See migrations/0009.
    { name: "oauth_tokens (legacy)", run: () => purgeLegacyOAuthTokens(db) },
    { name: "messages", run: () => activity.rotateMessages(MESSAGE_RETENTION_DAYS) },
    { name: "activity_log", run: () => activity.rotate(ACTIVITY_RETENTION_DAYS) },
    // Last, so the copy is taken after the rows above are gone. Due once per
    // UTC day; the hourly sweep makes a failed attempt come round again.
    ...(backupDir && backupKeep > 0 ? [{ name: BACKUP_TASK, run: () => backupIfDue(db, { dir: backupDir, keep: backupKeep }) }] : []),
  ];
}
