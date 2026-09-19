// Periodic housekeeping: retention and expired-credential cleanup.
//
// These used to run once, inside start(). With deploy-only restarts "30 days
// of history" really meant "until the next restart", and an abandoned OAuth
// flow left its plaintext token in SQLite for just as long.

export interface MaintenanceTask {
  name: string;
  /** Does the work and returns how many rows it touched. */
  run: () => number;
}

export interface MaintenanceOptions {
  intervalMs: number;
  /** Called only when a task actually did something. */
  onResult?: (name: string, count: number) => void;
  onError?: (name: string, err: unknown) => void;
}

/** Runs every task now and then on every interval. Returns a stop function.
 *  One failing task never stops the others or the schedule. */
export function startMaintenance(tasks: MaintenanceTask[], opts: MaintenanceOptions): () => void {
  const sweep = (): void => {
    for (const task of tasks) {
      try {
        const count = task.run();
        if (count > 0) opts.onResult?.(task.name, count);
      } catch (err) {
        opts.onError?.(task.name, err);
      }
    }
  };
  sweep();
  const timer = setInterval(sweep, opts.intervalMs);
  // Housekeeping must never keep the process alive on its own.
  timer.unref?.();
  return () => clearInterval(timer);
}
