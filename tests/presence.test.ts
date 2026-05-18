import { describe, it, expect } from "vitest";
import {
  computePresenceState,
  PRESENCE_THRESHOLDS,
} from "../src/services/presence";

describe("computePresenceState", () => {
  const now = new Date("2026-04-11T12:00:00.000Z").getTime();
  const STALE_MS = PRESENCE_THRESHOLDS.staleMs;

  describe("live state", () => {
    it("returns live when agent is in NATS KV presence (regardless of last_seen_at)", () => {
      expect(computePresenceState(true, "2026-04-11T11:59:00.000Z", now)).toBe("live");
    });

    it("returns live even if last_seen_at is null (KV trumps DB)", () => {
      expect(computePresenceState(true, null, now)).toBe("live");
    });

    it("returns live even if last_seen_at is ancient (KV still fresh)", () => {
      expect(computePresenceState(true, "2020-01-01T00:00:00.000Z", now)).toBe("live");
    });
  });

  describe("never state", () => {
    it("returns never when not in KV and last_seen_at is null", () => {
      expect(computePresenceState(false, null, now)).toBe("never");
    });

    it("returns never when last_seen_at is an unparseable string", () => {
      expect(computePresenceState(false, "not-a-date", now)).toBe("never");
    });
  });

  describe("stale state", () => {
    it("returns stale when last_seen_at is within the threshold (5 min ago)", () => {
      const fiveMinAgo = new Date(now - 5 * 60 * 1000).toISOString();
      expect(computePresenceState(false, fiveMinAgo, now)).toBe("stale");
    });

    it("returns stale when last_seen_at is just under 24h ago", () => {
      const almost24h = new Date(now - (STALE_MS - 60 * 1000)).toISOString();
      expect(computePresenceState(false, almost24h, now)).toBe("stale");
    });
  });

  describe("offline state", () => {
    it("returns offline when last_seen_at is exactly at the threshold", () => {
      const exactly24h = new Date(now - STALE_MS).toISOString();
      expect(computePresenceState(false, exactly24h, now)).toBe("offline");
    });

    it("returns offline when last_seen_at is 48h ago", () => {
      const twoDaysAgo = new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString();
      expect(computePresenceState(false, twoDaysAgo, now)).toBe("offline");
    });

    it("returns offline when last_seen_at is years ago", () => {
      expect(computePresenceState(false, "2024-01-01T00:00:00.000Z", now)).toBe("offline");
    });
  });

  describe("custom threshold", () => {
    it("respects a custom stale threshold (1 hour)", () => {
      const oneHour = 60 * 60 * 1000;
      const halfHourAgo = new Date(now - 30 * 60 * 1000).toISOString();
      const twoHoursAgo = new Date(now - 2 * 60 * 60 * 1000).toISOString();
      expect(
        computePresenceState(false, halfHourAgo, now, { staleMs: oneHour }),
      ).toBe("stale");
      expect(
        computePresenceState(false, twoHoursAgo, now, { staleMs: oneHour }),
      ).toBe("offline");
    });
  });

  describe("invariant", () => {
    it("presence === 'live' iff inPresenceKV === true", () => {
      expect(computePresenceState(true, null, now) === "live").toBe(true);
      expect(
        computePresenceState(false, new Date().toISOString(), now),
      ).not.toBe("live");
    });
  });
});
