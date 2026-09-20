// The seal of src/oauth-codes.ts, pinned as documented.
//
// From the review: a "seal" that only encoded the token, a key that ignored
// the code, and a four-byte tag each passed the suite. This file opens the
// stored value by hand, so the construction itself is what is tested.
import { describe, it, expect, beforeEach } from "vitest";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "fs";
import { issueCode, redeemCode, CODE_EXPIRY_MS } from "../src/oauth-codes";

const SECRET = "s".repeat(40);
const TOKEN = "bt_" + "t".repeat(40);
const VERIFIER = "v".repeat(64);
const CHALLENGE = crypto.createHash("sha256").update(VERIFIER).digest("base64url");
const hash = (c: string) => crypto.createHash("sha256").update(c).digest("hex");
const hkdf = (ikm: string, salt: string) => Buffer.from(crypto.hkdfSync("sha256", ikm, salt, "moshi/oauth-code/v1", 32));

let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  for (const f of readdirSync("migrations").filter((x) => x.endsWith(".sql")).sort()) db.exec(readFileSync(`migrations/${f}`, "utf-8"));
});
const expiresOf = (code: string) => (db.prepare("SELECT expires_at FROM oauth_codes WHERE code_hash = ?").get(hash(code)) as { expires_at: number }).expires_at;
const sealedOf = (code: string) => (db.prepare("SELECT token_sealed FROM oauth_codes WHERE code_hash = ?").get(hash(code)) as { token_sealed: string }).token_sealed;

describe("the seal, as documented", () => {
  it("is AES-256-GCM under HKDF(code, secret): 12-byte nonce, 16-byte tag, and no token in another alphabet", () => {
    const code = issueCode(db, SECRET, TOKEN, CHALLENGE);
    const [version, iv, tag, ct] = sealedOf(code).split(".").map((p, i) => (i === 0 ? p : Buffer.from(p, "base64url"))) as [string, Buffer, Buffer, Buffer];
    expect(version).toBe("v1");
    expect(iv).toHaveLength(12);
    expect(tag).toHaveLength(16);
    expect(ct.includes(Buffer.from(TOKEN))).toBe(false);
    for (const enc of ["base64", "base64url", "hex"] as const) expect(db.serialize().includes(Buffer.from(Buffer.from(TOKEN).toString(enc)))).toBe(false);

    const openWith = (key: Buffer): string | null => {
      try {
        const d = crypto.createDecipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
        d.setAAD(Buffer.from(`${hash(code)}:${CHALLENGE}:${expiresOf(code)}`));
        d.setAuthTag(tag);
        return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
      } catch { return null; }
    };
    expect(openWith(hkdf(code, SECRET))).toBe(TOKEN);
    // The file together with the environment, without the code, opens nothing.
    expect(openWith(hkdf(SECRET, ""))).toBeNull();
    expect(openWith(hkdf(SECRET, hash(code)))).toBeNull();
  });

  it("burns a row it cannot open", () => {
    const code = issueCode(db, SECRET, TOKEN, CHALLENGE);
    expect(redeemCode(db, "another secret".repeat(4), code, VERIFIER)).toEqual({ ok: false, reason: "unreadable" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM oauth_codes").get()).toEqual({ n: 0 });
  });

  it("lives five minutes, as the consent screen says", () => {
    expect(CODE_EXPIRY_MS).toBe(5 * 60 * 1000);
  });

  it("refuses a seal whose tag was shortened in the table", () => {
    for (const bytes of [4, 8, 12, 15]) {
      const code = issueCode(db, SECRET, TOKEN, CHALLENGE);
      const [v, iv, tag, ct] = sealedOf(code).split(".");
      db.prepare("UPDATE oauth_codes SET token_sealed = ? WHERE code_hash = ?").run([v, iv, Buffer.from(tag, "base64url").subarray(0, bytes).toString("base64url"), ct].join("."), hash(code));
      expect(redeemCode(db, SECRET, code, VERIFIER), `${bytes}-byte tag`).toEqual({ ok: false, reason: "unreadable" });
    }
  });
});

describe("what the seal vouches for", () => {
  it("includes the expiry: a row whose life was extended in the table does not open", () => {
    const t0 = 1_800_000_000_000;
    const code = issueCode(db, SECRET, TOKEN, CHALLENGE, t0);
    db.prepare("UPDATE oauth_codes SET expires_at = ?").run(t0 + 1e9);
    expect(redeemCode(db, SECRET, code, VERIFIER, t0 + 1e8)).toEqual({ ok: false, reason: "unreadable" });
  });

  it("refuses a nonce of another length", () => {
    const code = issueCode(db, SECRET, TOKEN, CHALLENGE);
    const [v, , tag, ct] = sealedOf(code).split(".");
    db.prepare("UPDATE oauth_codes SET token_sealed = ?").run([v, Buffer.alloc(16).toString("base64url"), tag, ct].join("."));
    expect(redeemCode(db, SECRET, code, VERIFIER)).toEqual({ ok: false, reason: "unreadable" });
  });
});
