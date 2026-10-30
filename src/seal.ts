// AES-256-GCM, the one way this code base keeps a secret it has to give back:
// the bearer token waiting for an OAuth exchange (src/oauth-codes.ts) and the
// signing secret of a webhook (src/services/webhooks.ts).
//
// The context (AAD) says WHAT the sealed value belongs to. Every caller puts
// the columns of its row in there, so a sealed value copied to another row
// does not open.

import crypto from "node:crypto";

const SEAL_VERSION = "v1";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
// Said out loud on both sides. Without it Node accepts a tag cut down to four
// bytes (DEP0182), which would make the binding a 32-bit one for anybody who
// can write the table.
const GCM = { authTagLength: TAG_BYTES } as const;

export function seal(value: string, key: Buffer, context: Buffer): string {
  const iv = crypto.randomBytes(NONCE_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv, GCM);
  cipher.setAAD(context);
  const sealed = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [SEAL_VERSION, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), sealed.toString("base64url")].join(".");
}

/** The value, or null for anything that is not a seal of it under this key
 *  and context. Never throws. */
export function open(sealed: string, key: Buffer, context: Buffer): string | null {
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
