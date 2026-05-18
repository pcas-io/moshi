import { describe, it, expect, beforeEach } from "vitest";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import {
  isAllowedRedirectUri,
  generateCode,
  verifyCode,
  storeToken,
  retrieveToken,
  cleanupExpiredOAuthTokens,
} from "../src/oauth";

// In-memory replica of migrations/0004_oauth_tokens.sql
function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE oauth_tokens (
      code       TEXT PRIMARY KEY,
      token      TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX idx_oauth_tokens_expires ON oauth_tokens(expires_at);
  `);
  return db;
}

// Helper: replicate generateCode for arbitrary timestamps (expired, future).
// We cannot use generateCode() directly because it hardcodes Date.now().
function generateCodeAt(ts: number, secret: string): string {
  const sig = crypto
    .createHmac("sha256", secret)
    .update(`code:${ts}`)
    .digest("hex");
  return `${ts}.${sig}`;
}

describe("isAllowedRedirectUri", () => {
  it("allows http localhost with port", () => {
    expect(isAllowedRedirectUri("http://localhost:8080/callback")).toBe(true);
  });

  it("allows https localhost", () => {
    expect(isAllowedRedirectUri("https://localhost/cb")).toBe(true);
  });

  it("allows 127.0.0.1", () => {
    expect(isAllowedRedirectUri("http://127.0.0.1:3000/cb")).toBe(true);
  });

  it("allows [::1] IPv6 loopback", () => {
    expect(isAllowedRedirectUri("http://[::1]:3000/cb")).toBe(true);
  });

  it("allows *.localhost subdomains (e.g. app.localhost)", () => {
    expect(isAllowedRedirectUri("http://app.localhost:3000/cb")).toBe(true);
  });

  it("rejects external domain", () => {
    expect(isAllowedRedirectUri("http://evil.com/cb")).toBe(false);
  });

  it("rejects localhost-lookalike (localhost.evil.com)", () => {
    expect(isAllowedRedirectUri("http://localhost.evil.com/cb")).toBe(false);
  });

  it("rejects javascript scheme", () => {
    expect(isAllowedRedirectUri("javascript:alert(1)")).toBe(false);
  });

  it("rejects file scheme", () => {
    expect(isAllowedRedirectUri("file:///etc/passwd")).toBe(false);
  });

  it("rejects malformed URI", () => {
    expect(isAllowedRedirectUri("not a url")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isAllowedRedirectUri("")).toBe(false);
  });
});

describe("generateCode / verifyCode", () => {
  const secret = "test-secret-abcdef123456";

  it("roundtrip: generated code verifies with same secret", () => {
    const code = generateCode(secret);
    expect(verifyCode(code, secret)).toBe(true);
  });

  it("code has timestamp.hex-sig format", () => {
    const code = generateCode(secret);
    const parts = code.split(".");
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatch(/^\d+$/);
    expect(parts[1]).toHaveLength(64); // SHA-256 hex
  });

  it("rejects code signed with a different secret", () => {
    const code = generateCode(secret);
    expect(verifyCode(code, "other-secret")).toBe(false);
  });

  it("rejects malformed code without dot", () => {
    expect(verifyCode("malformed", secret)).toBe(false);
  });

  it("rejects malformed code with extra dots", () => {
    expect(verifyCode("123.abc.def", secret)).toBe(false);
  });

  it("rejects non-numeric timestamp", () => {
    expect(verifyCode("notatimestamp.abc", secret)).toBe(false);
  });

  it("rejects expired code (age > 5 min)", () => {
    const code = generateCodeAt(Date.now() - 400_000, secret);
    expect(verifyCode(code, secret)).toBe(false);
  });

  it("rejects future timestamp (age < 0, clock-skew guard)", () => {
    const code = generateCodeAt(Date.now() + 60_000, secret);
    expect(verifyCode(code, secret)).toBe(false);
  });

  it("rejects tampered signature with same timestamp", () => {
    const code = generateCode(secret);
    const [ts] = code.split(".");
    const tampered = `${ts}.${"0".repeat(64)}`;
    expect(verifyCode(tampered, secret)).toBe(false);
  });
});

describe("storeToken / retrieveToken (b6ec1e7 hardening)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it("stores and retrieves a token", () => {
    storeToken(db, "code-1", "bt_token_abc");
    expect(retrieveToken(db, "code-1")).toBe("bt_token_abc");
  });

  it("is one-time-use: second retrieval returns null", () => {
    storeToken(db, "code-1", "bt_token_abc");
    expect(retrieveToken(db, "code-1")).toBe("bt_token_abc");
    expect(retrieveToken(db, "code-1")).toBe(null);
  });

  it("returns null for unknown code", () => {
    expect(retrieveToken(db, "never-stored")).toBe(null);
  });

  it("returns null AND deletes row when token is expired", () => {
    storeToken(db, "code-1", "bt_token_abc");
    // Force the row past its 5min TTL
    db.prepare("UPDATE oauth_tokens SET expires_at = ? WHERE code = ?").run(
      Date.now() - 1000,
      "code-1",
    );
    expect(retrieveToken(db, "code-1")).toBe(null);
    // Documented defensive behavior: the row is deleted unconditionally,
    // even when expired (prevents stale tokens from surviving a missed
    // cleanup pass). This test pins the current implementation.
    const row = db
      .prepare("SELECT code FROM oauth_tokens WHERE code = ?")
      .get("code-1");
    expect(row).toBeUndefined();
  });

  it("INSERT OR REPLACE: storing same code twice overwrites", () => {
    storeToken(db, "code-1", "bt_first");
    storeToken(db, "code-1", "bt_second");
    expect(retrieveToken(db, "code-1")).toBe("bt_second");
  });
});

describe("cleanupExpiredOAuthTokens", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it("deletes only expired rows and keeps active ones", () => {
    const now = Date.now();
    const insert = db.prepare(
      "INSERT INTO oauth_tokens (code, token, expires_at) VALUES (?, ?, ?)",
    );
    insert.run("expired-1", "t1", now - 10_000);
    insert.run("expired-2", "t2", now - 5_000);
    insert.run("active-1", "t3", now + 60_000);

    const deleted = cleanupExpiredOAuthTokens(db);
    expect(deleted).toBe(2);

    const remaining = db
      .prepare("SELECT code FROM oauth_tokens ORDER BY code")
      .all() as { code: string }[];
    expect(remaining).toHaveLength(1);
    expect(remaining[0].code).toBe("active-1");
  });

  it("returns 0 when nothing to clean", () => {
    db.prepare(
      "INSERT INTO oauth_tokens (code, token, expires_at) VALUES (?, ?, ?)",
    ).run("active-1", "t", Date.now() + 60_000);
    expect(cleanupExpiredOAuthTokens(db)).toBe(0);
  });
});
