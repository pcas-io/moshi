// The connect flow's token memory: created once, read by steps 2, 3 and 4,
// gone 15 minutes later.

import { describe, it, expect, beforeEach } from "vitest";
import {
  CONNECT_SESSION_TTL_MS,
  clearConnectSessions,
  createConnectSession,
  readConnectSession,
} from "../../src/services/connect-session";

const INPUT = { agentId: "01HZAGENTID", agentName: "dex-eu", token: "bt_testtoken" };

describe("connect-session", () => {
  beforeEach(() => clearConnectSessions());

  it("hands back an unguessable key with the agent and its token", () => {
    const session = createConnectSession(INPUT);
    expect(session.agentId).toBe(INPUT.agentId);
    expect(session.agentName).toBe(INPUT.agentName);
    expect(session.token).toBe(INPUT.token);
    expect(session.key.length).toBeGreaterThanOrEqual(20);
    expect(session.key).toMatch(/^[A-Za-z0-9_-]+$/); // URL-safe, no padding
  });

  it("gives every run a different key", () => {
    const a = createConnectSession(INPUT);
    const b = createConnectSession(INPUT);
    expect(a.key).not.toBe(b.key);
  });

  it("does NOT consume on read — the flow needs it across three steps", () => {
    const { key } = createConnectSession(INPUT);
    expect(readConnectSession(key)?.token).toBe(INPUT.token);
    expect(readConnectSession(key)?.token).toBe(INPUT.token);
    expect(readConnectSession(key)?.token).toBe(INPUT.token);
  });

  it("expires after the 15 minute TTL", () => {
    const now = 1_000_000;
    const { key } = createConnectSession(INPUT, now);
    expect(readConnectSession(key, now + CONNECT_SESSION_TTL_MS - 1)).not.toBeNull();
    expect(readConnectSession(key, now + CONNECT_SESSION_TTL_MS)).toBeNull();
  });

  it("sweeps expired entries rather than leaking them", () => {
    const now = 5_000_000;
    const stale = createConnectSession(INPUT, now);
    // A later read is what triggers the sweep; the stale entry must not
    // come back even if the clock is wound back afterwards.
    createConnectSession(INPUT, now + CONNECT_SESSION_TTL_MS + 1);
    expect(readConnectSession(stale.key, now)).toBeNull();
  });

  it("returns null for an unknown key and for no key at all", () => {
    expect(readConnectSession("nope")).toBeNull();
    expect(readConnectSession(undefined)).toBeNull();
    expect(readConnectSession("")).toBeNull();
  });
});
