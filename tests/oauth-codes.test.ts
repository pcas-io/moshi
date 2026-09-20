// Authorization codes (src/oauth-codes.ts).
//
// What used to be wrong: the code was `timestamp.hmac(timestamp)` plus an
// UNSIGNED `:challenge` suffix the client sent back, so whoever saw a code
// could swap the challenge for their own and redeem it. And the bearer token
// waited for the exchange as plaintext in `oauth_tokens`.

import { describe, it, expect, beforeEach } from "vitest";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "fs";
import { issueCode, redeemCode, cleanupExpiredOAuthCodes, CODE_EXPIRY_MS } from "../src/oauth-codes";

const SECRET = "s".repeat(40);
const TOKEN = "bt_" + "t".repeat(40);
const VERIFIER = "v".repeat(64);
const challengeOf = (verifier: string) => crypto.createHash("sha256").update(verifier).digest("base64url");
const CHALLENGE = challengeOf(VERIFIER);

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  for (const f of readdirSync("migrations").filter((x) => x.endsWith(".sql")).sort()) db.exec(readFileSync(`migrations/${f}`, "utf-8"));
  return db;
}

let db: Database.Database;
beforeEach(() => {
  db = freshDb();
});

describe("issueCode", () => {
  it("hands out a random code: 32 bytes, url-safe, never the same twice", () => {
    const codes = new Set(Array.from({ length: 200 }, () => issueCode(db, SECRET, TOKEN, CHALLENGE)));
    // The old code was a timestamp with a signature: two in one millisecond collided.
    expect(codes.size).toBe(200);
    for (const code of codes) expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("writes neither the code nor the token to the database", () => {
    const code = issueCode(db, SECRET, TOKEN, CHALLENGE);
    const file = db.serialize();
    expect(file.includes(Buffer.from(TOKEN))).toBe(false);
    expect(file.includes(Buffer.from(code))).toBe(false);
    // …while the row is there, under the hash of the code.
    const hash = crypto.createHash("sha256").update(code).digest("hex");
    expect(db.prepare("SELECT code_challenge FROM oauth_codes WHERE code_hash = ?").get(hash)).toEqual({ code_challenge: CHALLENGE });
  });

  it("seals the same token differently every time", () => {
    issueCode(db, SECRET, TOKEN, CHALLENGE);
    issueCode(db, SECRET, TOKEN, CHALLENGE);
    const sealed = db.prepare("SELECT token_sealed FROM oauth_codes").all() as { token_sealed: string }[];
    expect(sealed).toHaveLength(2);
    expect(sealed[0].token_sealed).not.toBe(sealed[1].token_sealed);
    for (const row of sealed) expect(row.token_sealed).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });
});

describe("redeemCode", () => {
  it("returns the token for the verifier that belongs to the stored challenge", () => {
    const code = issueCode(db, SECRET, TOKEN, CHALLENGE);
    expect(redeemCode(db, SECRET, code, VERIFIER)).toEqual({ ok: true, token: TOKEN });
  });

  it("works once", () => {
    const code = issueCode(db, SECRET, TOKEN, CHALLENGE);
    expect(redeemCode(db, SECRET, code, VERIFIER).ok).toBe(true);
    expect(redeemCode(db, SECRET, code, VERIFIER)).toEqual({ ok: false, reason: "unknown" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM oauth_codes").get()).toEqual({ n: 0 });
  });

  it("refuses a verifier that does not match, and the attempt uses the code up", () => {
    const code = issueCode(db, SECRET, TOKEN, CHALLENGE);
    expect(redeemCode(db, SECRET, code, "w".repeat(64))).toEqual({ ok: false, reason: "pkce" });
    // A second guess at the verifier is not on offer.
    expect(redeemCode(db, SECRET, code, VERIFIER)).toEqual({ ok: false, reason: "unknown" });
  });

  it("does not know a code it never issued", () => {
    issueCode(db, SECRET, TOKEN, CHALLENGE);
    expect(redeemCode(db, SECRET, "x".repeat(43), VERIFIER)).toEqual({ ok: false, reason: "unknown" });
    expect(redeemCode(db, SECRET, "", VERIFIER)).toEqual({ ok: false, reason: "unknown" });
  });

  it("refuses an expired code and removes its row", () => {
    const t0 = 1_800_000_000_000;
    const code = issueCode(db, SECRET, TOKEN, CHALLENGE, t0);
    expect(redeemCode(db, SECRET, code, VERIFIER, t0 + CODE_EXPIRY_MS)).toEqual({ ok: false, reason: "expired" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM oauth_codes").get()).toEqual({ n: 0 });
  });

  it("is still good one millisecond before it expires", () => {
    const t0 = 1_800_000_000_000;
    const code = issueCode(db, SECRET, TOKEN, CHALLENGE, t0);
    expect(redeemCode(db, SECRET, code, VERIFIER, t0 + CODE_EXPIRY_MS - 1)).toEqual({ ok: true, token: TOKEN });
  });

  it("cannot open a row with another secret", () => {
    const code = issueCode(db, SECRET, TOKEN, CHALLENGE);
    expect(redeemCode(db, "another secret".repeat(4), code, VERIFIER)).toEqual({ ok: false, reason: "unreadable" });
  });

  it("does not follow a challenge that was swapped in the database", () => {
    // Write access to the table must not be enough to redeem somebody's code:
    // the challenge is part of what the seal authenticates.
    const code = issueCode(db, SECRET, TOKEN, CHALLENGE);
    const theirs = "a".repeat(64);
    db.prepare("UPDATE oauth_codes SET code_challenge = ?").run(challengeOf(theirs));
    expect(redeemCode(db, SECRET, code, theirs)).toEqual({ ok: false, reason: "unreadable" });
  });

  it("does not open a row that was moved under another code", () => {
    const code = issueCode(db, SECRET, TOKEN, CHALLENGE);
    const other = issueCode(db, SECRET, "bt_" + "o".repeat(40), CHALLENGE);
    const hash = (c: string) => crypto.createHash("sha256").update(c).digest("hex");
    const stolen = db.prepare("SELECT token_sealed FROM oauth_codes WHERE code_hash = ?").get(hash(code)) as { token_sealed: string };
    db.prepare("UPDATE oauth_codes SET token_sealed = ? WHERE code_hash = ?").run(stolen.token_sealed, hash(other));
    expect(redeemCode(db, SECRET, other, VERIFIER)).toEqual({ ok: false, reason: "unreadable" });
  });
});

describe("cleanupExpiredOAuthCodes", () => {
  it("deletes expired rows and keeps the rest", () => {
    const t0 = 1_800_000_000_000;
    issueCode(db, SECRET, TOKEN, CHALLENGE, t0 - CODE_EXPIRY_MS - 10_000);
    issueCode(db, SECRET, TOKEN, CHALLENGE, t0 - CODE_EXPIRY_MS - 5_000);
    const live = issueCode(db, SECRET, TOKEN, CHALLENGE, t0);
    expect(cleanupExpiredOAuthCodes(db, t0)).toBe(2);
    expect(cleanupExpiredOAuthCodes(db, t0)).toBe(0);
    expect(redeemCode(db, SECRET, live, VERIFIER, t0 + 1).ok).toBe(true);
  });
});
