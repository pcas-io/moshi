// Standard Webhooks signing (src/services/webhook-sign.ts), checked against the
// spec's own published example and against tampering.

import crypto from "node:crypto";
import { describe, it, expect } from "vitest";
import {
  generateSigningSecret,
  checkSigningSecret,
  checkBearerKey,
  signingHeaders,
  verifySignature,
  SIGNATURE_TOLERANCE_SECONDS,
} from "../../src/services/webhook-sign";

// The test vector from the Standard Webhooks specification (standardwebhooks.com,
// "Verifying webhook authenticity"), the format Grok's webhook triggers expect.
const SPEC = {
  secret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
  id: "msg_p5jXN8AQM9LWM0D4loKWxJek",
  timestamp: 1614265330,
  body: '{"test": 2432232314}',
  signature: "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
};

describe("signingHeaders", () => {
  it("produces the specification's signature for its example", () => {
    const headers = signingHeaders(SPEC.secret, SPEC.id, SPEC.timestamp, SPEC.body);
    expect(headers).toEqual({
      "webhook-id": SPEC.id,
      "webhook-timestamp": String(SPEC.timestamp),
      "webhook-signature": SPEC.signature,
    });
  });
});

describe("verifySignature", () => {
  const now = SPEC.timestamp + 10;
  const headers = signingHeaders(SPEC.secret, SPEC.id, SPEC.timestamp, SPEC.body);

  it("accepts the untouched request", () => {
    expect(verifySignature(SPEC.secret, headers, SPEC.body, now)).toBe(true);
  });

  it("rejects a changed body", () => {
    expect(verifySignature(SPEC.secret, headers, '{"test": 2432232315}', now)).toBe(false);
  });

  it("rejects the wrong secret", () => {
    expect(verifySignature(generateSigningSecret(), headers, SPEC.body, now)).toBe(false);
  });

  it("rejects a changed id or timestamp: both are signed", () => {
    expect(verifySignature(SPEC.secret, { ...headers, "webhook-id": "msg_other" }, SPEC.body, now)).toBe(false);
    expect(verifySignature(SPEC.secret, { ...headers, "webhook-timestamp": String(SPEC.timestamp + 1) }, SPEC.body, now)).toBe(false);
  });

  it("rejects a replay outside the tolerance, in both directions", () => {
    expect(verifySignature(SPEC.secret, headers, SPEC.body, SPEC.timestamp + SIGNATURE_TOLERANCE_SECONDS + 1)).toBe(false);
    expect(verifySignature(SPEC.secret, headers, SPEC.body, SPEC.timestamp - SIGNATURE_TOLERANCE_SECONDS - 1)).toBe(false);
  });

  it("finds its signature among several (a receiver rotating secrets)", () => {
    const several = { ...headers, "webhook-signature": `v1,AAAA ${SPEC.signature}` };
    expect(verifySignature(SPEC.secret, several, SPEC.body, now)).toBe(true);
  });

  it("rejects missing headers and a malformed timestamp without throwing", () => {
    expect(verifySignature(SPEC.secret, {}, SPEC.body, now)).toBe(false);
    expect(verifySignature(SPEC.secret, { ...headers, "webhook-timestamp": "soon" }, SPEC.body, now)).toBe(false);
  });
});

describe("signing secrets", () => {
  it("generates whsec_ with 32 random bytes", () => {
    const secret = generateSigningSecret();
    expect(secret).toMatch(/^whsec_[A-Za-z0-9+/]+=*$/);
    expect(Buffer.from(secret.slice(6), "base64")).toHaveLength(32);
    expect(generateSigningSecret()).not.toBe(secret);
  });

  it("accepts the specification's secret and a generated one", () => {
    expect(checkSigningSecret(SPEC.secret)).toBeNull();
    expect(checkSigningSecret(generateSigningSecret())).toBeNull();
  });

  it("refuses what is not whsec_ plus base64 of 24 to 64 bytes", () => {
    for (const bad of [
      "",
      "MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
      "whsec_",
      "whsec_not base64!",
      `whsec_${crypto.randomBytes(16).toString("base64")}`,
      `whsec_${crypto.randomBytes(65).toString("base64")}`,
    ]) {
      expect(checkSigningSecret(bad), bad).not.toBeNull();
    }
  });
});

describe("bearer keys", () => {
  it("accepts 16 to 512 visible characters", () => {
    expect(checkBearerKey("k".repeat(16))).toBeNull();
    expect(checkBearerKey("sk_live-AbC.123~xyz")).toBeNull();
    expect(checkBearerKey("k".repeat(512))).toBeNull();
  });

  it("refuses short, long, and anything with spaces or control characters", () => {
    for (const bad of ["k".repeat(15), "k".repeat(513), "a key with spaces!", "line\nbreak-0123456789", "tab\tkey-0123456789"]) {
      expect(checkBearerKey(bad), JSON.stringify(bad)).not.toBeNull();
    }
  });
});
