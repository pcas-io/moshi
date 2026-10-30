// How a webhook proves it comes from moshi: Standard Webhooks
// (standardwebhooks.com), the format Grok's webhook triggers verify.
//
//   webhook-id         the delivery's id, the same for every attempt
//   webhook-timestamp  seconds since the epoch, new for every attempt
//   webhook-signature  "v1," + base64(HMAC-SHA256(key, "<id>.<timestamp>.<body>"))
//
// The key is the secret without its `whsec_` prefix, base64-decoded. The
// receiver refuses a timestamp more than five minutes off, which is the replay
// protection: an old request cannot be sent again, and a new timestamp needs a
// new signature. Every attempt is therefore signed anew.
//
// The other mode, `bearer`, sends a key the receiver gave out as
// `Authorization: Bearer <key>`. moshi never makes one up: it is the
// receiver's.

import crypto from "node:crypto";

export const SIGNING_SECRET_PREFIX = "whsec_";
export const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

const SECRET_MIN_BYTES = 24;
const SECRET_MAX_BYTES = 64;
const GENERATED_SECRET_BYTES = 32;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
/** Visible ASCII only: a key goes into a header line. */
const BEARER_KEY = /^[\x21-\x7e]{16,512}$/;

export type SignatureHeaders = {
  "webhook-id": string;
  "webhook-timestamp": string;
  "webhook-signature": string;
};

export function generateSigningSecret(): string {
  return SIGNING_SECRET_PREFIX + crypto.randomBytes(GENERATED_SECRET_BYTES).toString("base64");
}

/** Null when `secret` is a signing secret moshi can use, else why not. */
export function checkSigningSecret(secret: string): string | null {
  const encoded = secret.startsWith(SIGNING_SECRET_PREFIX) ? secret.slice(SIGNING_SECRET_PREFIX.length) : null;
  if (encoded === null || !BASE64.test(encoded)) {
    return `a signing secret is "${SIGNING_SECRET_PREFIX}" followed by base64, as the receiver shows it`;
  }
  const bytes = Buffer.from(encoded, "base64").length;
  if (bytes < SECRET_MIN_BYTES || bytes > SECRET_MAX_BYTES) {
    return `a signing secret holds ${SECRET_MIN_BYTES} to ${SECRET_MAX_BYTES} bytes (this one ${bytes})`;
  }
  return null;
}

/** Null when `key` can go into an Authorization header, else why not. */
export function checkBearerKey(key: string): string | null {
  return BEARER_KEY.test(key) ? null : "a bearer key is 16 to 512 visible characters, without spaces";
}

function signature(secret: string, id: string, timestamp: string, body: string): Buffer {
  const key = Buffer.from(secret.slice(SIGNING_SECRET_PREFIX.length), "base64");
  return crypto.createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest();
}

export function signingHeaders(secret: string, id: string, timestampSeconds: number, body: string): SignatureHeaders {
  const timestamp = String(timestampSeconds);
  return {
    "webhook-id": id,
    "webhook-timestamp": timestamp,
    "webhook-signature": `v1,${signature(secret, id, timestamp, body).toString("base64")}`,
  };
}

/**
 * What a receiver does, here for the tests and as the reference the README
 * points to. True only for the right secret, the unchanged body and a
 * timestamp within the tolerance of `nowSeconds`.
 */
export function verifySignature(
  secret: string,
  headers: Partial<Record<keyof SignatureHeaders, string>>,
  body: string,
  nowSeconds: number,
): boolean {
  const id = headers["webhook-id"];
  const timestamp = headers["webhook-timestamp"];
  const signatures = headers["webhook-signature"];
  if (!id || !timestamp || !signatures || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(nowSeconds - Number(timestamp)) > SIGNATURE_TOLERANCE_SECONDS) return false;
  const expected = signature(secret, id, timestamp, body);
  // Several signatures, separated by spaces, while a receiver rotates.
  return signatures.split(" ").some((entry) => {
    const [version, value] = entry.split(",", 2);
    if (version !== "v1" || !value) return false;
    const given = Buffer.from(value, "base64");
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  });
}
