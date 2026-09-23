// send_attempts: the record a repeated send is recognised by, and how long
// it is kept. Nothing tested what rotateAttempts removed — replacing its
// body with `return 0` left the whole suite green — and the table carries a
// full envelope: the payload's hash, the correlation id and up to 2048
// characters of context per row.

import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { initDatabase } from "../../src/services/db";
import { createMessage } from "../../src/services/message";
import { recordAttempt, ownAttempt, forgetAttempt, rotateAttempts, payloadHash } from "../../src/services/attempts";
import { maintenanceTasks } from "../../src/services/maintenance-tasks";
import { ActivityService } from "../../src/services/activity";

const DAY = 86_400_000;

describe("send_attempts", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = initDatabase(":memory:");
  });

  const attempt = (payload: string, ageMs = 0) => {
    const msg = createMessage({ from: "beta", to: "alpha", type: "info", payload, context: "ctx" });
    msg.created_at = new Date(Date.now() - ageMs).toISOString();
    recordAttempt(db, msg, { fromKey: "beta", toKey: "alpha", subject: "mesh.agents.alpha.inbox" });
    return msg;
  };

  it("keeps a send under its id, for its sender only", () => {
    const msg = attempt("the one that may be repeated");
    const mine = ownAttempt(db, msg.id, "beta");
    expect(mine?.payload_sha256).toBe(payloadHash("the one that may be repeated"));
    // A name is not an address: only the sender's inbox key opens its own.
    expect(ownAttempt(db, msg.id, "alpha")).toBeNull();
    expect(ownAttempt(db, "msg_nothing", "beta")).toBeNull();
  });

  it("forgets one that was confirmed", () => {
    const msg = attempt("delivered");
    forgetAttempt(db, msg.id);
    expect(ownAttempt(db, msg.id, "beta")).toBeNull();
  });

  it("rotates by age and keeps the rest", () => {
    const old = attempt("eight days ago", 8 * DAY);
    const recent = attempt("six days ago", 6 * DAY);
    expect(rotateAttempts(db, 7)).toBe(1);
    expect(ownAttempt(db, old.id, "beta")).toBeNull();
    expect(ownAttempt(db, recent.id, "beta")).not.toBeNull();
    // Nothing left to remove the second time.
    expect(rotateAttempts(db, 7)).toBe(0);
  });

  it("is rotated by the hourly maintenance", () => {
    attempt("eight days ago", 8 * DAY);
    const tasks = maintenanceTasks({ db, activity: new ActivityService(db), backupDir: null, backupKeep: 0 });
    const task = tasks.find((t) => t.name === "send_attempts");
    expect(task, tasks.map((t) => t.name).join(", ")).toBeDefined();
    expect(task!.run()).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM send_attempts").get()).toEqual({ n: 0 });
  });
});
