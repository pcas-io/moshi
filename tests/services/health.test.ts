import { describe, it, expect, beforeEach } from "vitest";
import type Database from "better-sqlite3";
import { initDatabase } from "../../src/services/db";
import { checkHealth } from "../../src/services/health";

function createTestDb(): Database.Database {
  return initDatabase(":memory:");
}

describe("checkHealth", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it("returns status=ok when DB reachable AND NATS ping returns true", async () => {
    const nats = { ping: async () => true };
    const result = await checkHealth(db, nats);
    expect(result.status).toBe("ok");
    expect(result.nats).toBe("connected");
    expect(result.db).toBe("ok");
    expect(result.httpStatus).toBe(200);
  });

  it("returns status=degraded + httpStatus=503 when NATS ping returns false", async () => {
    const nats = { ping: async () => false };
    const result = await checkHealth(db, nats);
    expect(result.status).toBe("degraded");
    expect(result.nats).toBe("disconnected");
    expect(result.db).toBe("ok");
    expect(result.httpStatus).toBe(503);
  });

  it("returns status=degraded when DB throws", async () => {
    const nats = { ping: async () => true };
    const brokenDb = {
      prepare: () => {
        throw new Error("db closed");
      },
    } as unknown as Database.Database;
    const result = await checkHealth(brokenDb, nats);
    expect(result.status).toBe("degraded");
    expect(result.db).toBe("error");
    expect(result.nats).toBe("connected");
    expect(result.httpStatus).toBe(503);
  });
});
