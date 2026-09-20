// The session cookie and the form tokens, as plain functions.
//
// Before: the cookie was `name:timestamp:mac`, good for 30 days whatever
// happened to the token it was made from, and a form token was valid for
// anybody who held one, in any session.

import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import {
  generateSessionCookie, readSessionCookie, sessionFingerprint, csrfBindingOf, loginCsrfBinding,
  generateCsrfToken, validateCsrfToken,
  SESSION_IDLE_MS, SESSION_ABSOLUTE_MS, CSRF_SESSION_MAX_AGE_MS, CSRF_LOGIN_MAX_AGE_MS,
} from "../src/auth";

const SECRET = "c".repeat(40);
const HASH = crypto.createHash("sha256").update("bt_token").digest("hex");
const T0 = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

describe("session cookie", () => {
  const cookie = generateSessionCookie({ kind: "agent", id: "01AGENT", tokenHash: HASH }, SECRET, T0);

  it("carries who, since when, and a fingerprint of the token, but not the token hash", () => {
    const claims = readSessionCookie(cookie, SECRET, T0 + 1);
    expect(claims).toEqual({ kind: "agent", id: "01AGENT", createdAt: T0, issuedAt: T0, fingerprint: sessionFingerprint(HASH, SECRET) });
    expect(cookie).not.toContain(HASH);
    expect(sessionFingerprint(HASH, SECRET)).not.toBe(sessionFingerprint(HASH, "another secret"));
  });

  it("lasts seven days without being used, not a millisecond longer", () => {
    expect(SESSION_IDLE_MS).toBe(7 * DAY);
    expect(readSessionCookie(cookie, SECRET, T0 + 7 * DAY)).not.toBeNull();
    expect(readSessionCookie(cookie, SECRET, T0 + 7 * DAY + 1)).toBeNull();
  });

  it("ends thirty days after the sign-in however often it was renewed", () => {
    expect(SESSION_ABSOLUTE_MS).toBe(30 * DAY);
    const renewed = generateSessionCookie({ kind: "agent", id: "01AGENT", tokenHash: HASH, createdAt: T0 }, SECRET, T0 + 29 * DAY);
    expect(readSessionCookie(renewed, SECRET, T0 + 30 * DAY)).toMatchObject({ createdAt: T0, issuedAt: T0 + 29 * DAY });
    expect(readSessionCookie(renewed, SECRET, T0 + 30 * DAY + 1)).toBeNull();
  });

  it("refuses a cookie from the future, a forged one, and the old three-part format", () => {
    expect(readSessionCookie(cookie, SECRET, T0 - 1)).toBeNull();
    expect(readSessionCookie(cookie, "another secret", T0 + 1)).toBeNull();
    expect(readSessionCookie(cookie.replace("01AGENT", "01OTHER"), SECRET, T0 + 1)).toBeNull();
    expect(readSessionCookie(cookie.replace(":agent:", ":admin:"), SECRET, T0 + 1)).toBeNull();
    const payload = `admin:${T0}`;
    const legacy = `${payload}:${crypto.createHmac("sha256", SECRET).update(payload).digest("hex")}`;
    expect(readSessionCookie(legacy, SECRET, T0 + 1)).toBeNull();
    for (const junk of ["", "v2", "v2::::::", "v2:agent:01AGENT:x:y:z:0", "constructor"]) expect(readSessionCookie(junk, SECRET, T0)).toBeNull();
  });

  it("does not let a renewal move the sign-in date forward", () => {
    // createdAt is part of what is signed; a client cannot reset it.
    const parts = cookie.split(":");
    parts[3] = String(T0 + 5 * DAY);
    expect(readSessionCookie(parts.join(":"), SECRET, T0 + 6 * DAY)).toBeNull();
  });
});

describe("form tokens", () => {
  const claims = readSessionCookie(generateSessionCookie({ kind: "agent", id: "01AGENT", tokenHash: HASH }, SECRET, T0), SECRET, T0)!;
  const mine = csrfBindingOf(claims);

  it("are good in the session they were made for", () => {
    expect(validateCsrfToken(generateCsrfToken(SECRET, mine, T0), SECRET, mine, CSRF_SESSION_MAX_AGE_MS, T0 + 1)).toBe(true);
  });

  it("are worth nothing in another session", () => {
    const token = generateCsrfToken(SECRET, mine, T0);
    const other = csrfBindingOf({ kind: "agent", id: "01OTHER", fingerprint: claims.fingerprint });
    const admin = csrfBindingOf({ kind: "admin", id: "", fingerprint: claims.fingerprint });
    const afterReset = csrfBindingOf({ kind: "agent", id: "01AGENT", fingerprint: sessionFingerprint("f".repeat(64), SECRET) });
    for (const binding of [other, admin, afterReset, loginCsrfBinding("n1"), ""]) {
      expect(validateCsrfToken(token, SECRET, binding, CSRF_SESSION_MAX_AGE_MS, T0 + 1), binding).toBe(false);
    }
  });

  it("stay good when the cookie is renewed", () => {
    const renewed = readSessionCookie(
      generateSessionCookie({ kind: "agent", id: "01AGENT", tokenHash: HASH, createdAt: T0 }, SECRET, T0 + 2 * DAY), SECRET, T0 + 2 * DAY)!;
    expect(csrfBindingOf(renewed)).toBe(mine);
  });

  it("from the sign-in page belong to one browser", () => {
    const token = generateCsrfToken(SECRET, loginCsrfBinding("nonce-a"), T0);
    expect(validateCsrfToken(token, SECRET, loginCsrfBinding("nonce-a"), CSRF_LOGIN_MAX_AGE_MS, T0 + 1)).toBe(true);
    expect(validateCsrfToken(token, SECRET, loginCsrfBinding("nonce-b"), CSRF_LOGIN_MAX_AGE_MS, T0 + 1)).toBe(false);
    expect(validateCsrfToken(token, SECRET, loginCsrfBinding(""), CSRF_LOGIN_MAX_AGE_MS, T0 + 1)).toBe(false);
  });

  it("expire: ten minutes on the sign-in page, a working day inside a session", () => {
    expect(CSRF_LOGIN_MAX_AGE_MS).toBe(10 * 60_000);
    expect(CSRF_SESSION_MAX_AGE_MS).toBe(8 * 60 * 60_000);
    const token = generateCsrfToken(SECRET, mine, T0);
    expect(validateCsrfToken(token, SECRET, mine, CSRF_SESSION_MAX_AGE_MS, T0 + CSRF_SESSION_MAX_AGE_MS)).toBe(true);
    expect(validateCsrfToken(token, SECRET, mine, CSRF_SESSION_MAX_AGE_MS, T0 + CSRF_SESSION_MAX_AGE_MS + 1)).toBe(false);
    expect(validateCsrfToken(token, SECRET, mine, CSRF_SESSION_MAX_AGE_MS, T0 - 1)).toBe(false);
  });

  it("never validate against an empty binding, even if one was used to make them", () => {
    // A route that forgot to set a binding must fail closed.
    expect(validateCsrfToken(generateCsrfToken(SECRET, "", T0), SECRET, "", CSRF_SESSION_MAX_AGE_MS, T0 + 1)).toBe(false);
  });

  it("are not a TypeError for anything a form can send", () => {
    for (const bad of [undefined, null, 1, {}, [], ["a"], "", "x", "a.b", "a:b.c"]) {
      expect(validateCsrfToken(bad as never, SECRET, mine)).toBe(false);
    }
  });
});
