// Authorization codes for the OAuth flow.
//
// A code is 32 random bytes. The database knows its SHA-256 and nothing else,
// so reading the table (or a backup of it) yields no code that could be
// redeemed. The bearer token waits for the exchange sealed with AES-256-GCM.
// The key comes from the code AND the server secret: the file alone opens
// nothing, and neither does the file together with the environment.
//
// The PKCE challenge is stored with the row and is part of what the seal
// authenticates. The token endpoint verifies against that value, never
// against anything the client sends along with the code.

import crypto from "node:crypto";
import type Database from "better-sqlite3";

export const CODE_EXPIRY_MS = 300_000; // 5 minutes

/** An S256 challenge: 32 bytes as base64url without padding. */
export const CODE_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const SEAL_VERSION = "v1";
const KEY_INFO = "moshi/oauth-code/v1";

export type Redeemed =
  | { ok: true; token: string }
  | { ok: false; reason: "unknown" | "expired" | "pkce" | "unreadable" };

const sha256Hex = (value: string): string => crypto.createHash("sha256").update(value).digest("hex");

function sealKey(code: string, secret: string): Buffer {
  return Buffer.from(crypto.hkdfSync("sha256", code, secret, KEY_INFO, 32));
}

const NONCE_BYTES = 12;
const TAG_BYTES = 16;
// Said out loud on both sides. Without it Node accepts a tag cut down to four
// bytes (DEP0182), which would make the binding below a 32-bit one for
// anybody who can write the table.
const GCM = { authTagLength: TAG_BYTES } as const;

/** What the seal vouches for besides the token: which code, which challenge,
 *  and until when. Every column of the row is either the key to it or in here. */
const sealContext = (codeHash: string, codeChallenge: string, expiresAt: number): Buffer =>
  Buffer.from(`${codeHash}:${codeChallenge}:${expiresAt}`);

function seal(token: string, key: Buffer, context: Buffer): string {
  const iv = crypto.randomBytes(NONCE_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv, GCM);
  cipher.setAAD(context);
  const sealed = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return [SEAL_VERSION, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), sealed.toString("base64url")].join(".");
}

function open(sealed: string, key: Buffer, context: Buffer): string | null {
  const parts = sealed.split(".");
  if (parts.length !== 4 || parts[0] !== SEAL_VERSION) return null;
  try {
    const iv = Buffer.from(parts[1], "base64url");
    const tag = Buffer.from(parts[2], "base64url");
    if (iv.length !== NONCE_BYTES || tag.length !== TAG_BYTES) return null;
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv, GCM);
    decipher.setAAD(context);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(Buffer.from(parts[3], "base64url")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** Stores `token` for one exchange and returns the code that redeems it. */
export function issueCode(
  db: Database.Database,
  secret: string,
  token: string,
  codeChallenge: string,
  now: number = Date.now(),
): string {
  const code = crypto.randomBytes(32).toString("base64url");
  const codeHash = sha256Hex(code);
  const expiresAt = now + CODE_EXPIRY_MS;
  db.prepare("INSERT INTO oauth_codes (code_hash, token_sealed, code_challenge, expires_at) VALUES (?, ?, ?, ?)").run(
    codeHash,
    seal(token, sealKey(code, secret), sealContext(codeHash, codeChallenge, expiresAt)),
    codeChallenge,
    expiresAt,
  );
  return code;
}

/**
 * Redeems a code. The row is gone after the first attempt, whatever the
 * outcome: a code is good for one try at the verifier, not for a search.
 */
export function redeemCode(
  db: Database.Database,
  secret: string,
  code: string,
  codeVerifier: string,
  now: number = Date.now(),
): Redeemed {
  const codeHash = sha256Hex(code);
  const row = db
    .prepare("DELETE FROM oauth_codes WHERE code_hash = ? RETURNING token_sealed, code_challenge, expires_at")
    .get(codeHash) as { token_sealed: string; code_challenge: string; expires_at: number } | undefined;
  if (!row) return { ok: false, reason: "unknown" };
  if (now >= row.expires_at) return { ok: false, reason: "expired" };

  const computed = crypto.createHash("sha256").update(codeVerifier).digest();
  const expected = Buffer.from(row.code_challenge, "base64url");
  if (expected.length !== computed.length || !crypto.timingSafeEqual(computed, expected)) {
    return { ok: false, reason: "pkce" };
  }

  const token = open(row.token_sealed, sealKey(code, secret), sealContext(codeHash, row.code_challenge, row.expires_at));
  return token === null ? { ok: false, reason: "unreadable" } : { ok: true, token };
}

export function cleanupExpiredOAuthCodes(db: Database.Database, now: number = Date.now()): number {
  return db.prepare("DELETE FROM oauth_codes WHERE expires_at <= ?").run(now).changes;
}

/**
 * Empties `oauth_tokens`, the plaintext table of the release before 0009. It
 * is kept for one release so that a rollback can still sign people in; this
 * makes sure that what a rolled-back release wrote there does not outlive the
 * roll-forward. No table, no work.
 */
export function purgeLegacyOAuthTokens(db: Database.Database): number {
  const there = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'oauth_tokens'").get();
  return there ? db.prepare("DELETE FROM oauth_tokens").run().changes : 0;
}
