// ensureConsumer used to run on every /mcp request: two lookups, and a bare
// `catch` that took ANY failure for "does not exist" and tried to create the
// consumer. With the broker gone that was a second full timeout per durable.

import { describe, it, expect, vi } from "vitest";
import { ConsumerRegistry } from "../../src/services/consumers";

const notFound = () => Object.assign(new Error("consumer not found"), { api_error: { err_code: 10014 } });
const timeout = () => Object.assign(new Error("TIMEOUT"), { code: "TIMEOUT" });

/** `existing`: durable names, or name -> the time the broker created it. */
function setup(existing: string[] | Record<string, string> = []) {
  const known = new Map<string, string>(
    Array.isArray(existing) ? existing.map((n) => [n, "2026-01-01T00:00:00.000000000Z"]) : Object.entries(existing),
  );
  const admin = {
    info: vi.fn(async (name: string) => { if (!known.has(name)) throw notFound(); return { created: known.get(name) }; }),
    add: vi.fn(async (config: { durable_name?: string }) => { known.set(config.durable_name!, "2026-09-20T12:00:00.000000000Z"); return {}; }),
    delete: vi.fn(async (name: string) => { if (!known.delete(name)) throw notFound(); return true; }),
  };
  return { admin, registry: new ConsumerRegistry(admin) };
}

describe("ConsumerRegistry.ensure", () => {
  it("creates nothing when both durables exist", async () => {
    const { admin, registry } = setup(["agent-scout", "agent-scout-broadcast"]);
    await registry.ensure("scout");
    expect(admin.info).toHaveBeenCalledTimes(2);
    expect(admin.add).not.toHaveBeenCalled();
  });

  it("creates the missing durables with the inbox key as address, lower-cased", async () => {
    const { admin, registry } = setup();
    await registry.ensure("Scout");
    expect(admin.add.mock.calls.map(([c]) => c)).toEqual([
      expect.objectContaining({ durable_name: "agent-scout", filter_subject: "mesh.agents.scout.inbox", ack_policy: "explicit", max_deliver: 5, ack_wait: 30_000_000_000 }),
      expect.objectContaining({ durable_name: "agent-scout-broadcast", filter_subject: "mesh.broadcast", ack_policy: "explicit", max_deliver: 5, ack_wait: 30_000_000_000 }),
    ]);
  });

  it("passes an outage on instead of answering it with a create", async () => {
    const { admin, registry } = setup();
    admin.info.mockRejectedValueOnce(timeout());
    await expect(registry.ensure("scout")).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(admin.add).not.toHaveBeenCalled();
  });

  it("asks the broker once per key, whatever the spelling", async () => {
    const { admin, registry } = setup();
    await registry.ensure("scout");
    admin.info.mockClear();
    admin.add.mockClear();
    await registry.ensure("scout");
    await registry.ensure("SCOUT");
    expect(admin.info).not.toHaveBeenCalled();
    expect(admin.add).not.toHaveBeenCalled();
  });

  it("does not remember a key it failed to ensure", async () => {
    const { admin, registry } = setup();
    admin.info.mockRejectedValueOnce(timeout());
    await registry.ensure("scout").catch(() => {});
    await registry.ensure("scout");
    expect(admin.add).toHaveBeenCalledTimes(2);
  });

  it("shares one round trip between concurrent requests for the same key", async () => {
    const { admin, registry } = setup();
    await Promise.all([registry.ensure("scout"), registry.ensure("scout"), registry.ensure("scout")]);
    expect(admin.info).toHaveBeenCalledTimes(2);
    expect(admin.add).toHaveBeenCalledTimes(2);
  });

  it("does not remember a key that was forgotten while its ensure was still running", async () => {
    // A revoke lands during an agent's first ensure: what the ensure has just
    // confirmed is exactly what the revoke deletes.
    const { admin, registry } = setup();
    let release!: () => void;
    admin.info.mockImplementationOnce(() => new Promise((_, reject) => { release = () => reject(notFound()); }));
    const running = registry.ensure("scout");
    registry.forget("scout");
    release();
    await running;
    expect(registry.has("scout")).toBe(false);
    admin.info.mockClear();
    await registry.ensure("scout");
    expect(admin.info).toHaveBeenCalled(); // asked the broker again

    expect(registry.has("scout")).toBe(true);
    expect(registry.has("SCOUT")).toBe(true);
  });

  it("asks again after forget(key) and after clear()", async () => {
    const { admin, registry } = setup();
    await registry.ensure("scout");
    await registry.ensure("dex");
    admin.info.mockClear();

    registry.forget("Scout");
    await registry.ensure("scout");
    await registry.ensure("dex");
    expect(admin.info).toHaveBeenCalledTimes(2); // scout only

    registry.clear();
    await registry.ensure("dex");
    expect(admin.info).toHaveBeenCalledTimes(4);
  });
});

// DeliverAll was the default: a durable created today handed out everything
// the stream still held. A brand-new agent started with a week of other
// agents' broadcasts, and delete-and-recreate replayed what had been read.
describe("ConsumerRegistry.ensure — where a new durable starts, and whose an old one is", () => {
  const SINCE = "2026-09-20T10:00:00.000Z";

  it("starts a new durable at the agent's inbox_since, not at the beginning of the stream", async () => {
    const { admin, registry } = setup();
    await registry.ensure("scout", SINCE);
    expect(admin.add.mock.calls.map(([c]) => c)).toEqual([
      expect.objectContaining({ durable_name: "agent-scout", deliver_policy: "by_start_time", opt_start_time: SINCE }),
      expect.objectContaining({ durable_name: "agent-scout-broadcast", deliver_policy: "by_start_time", opt_start_time: SINCE }),
    ]);
    expect(admin.delete).not.toHaveBeenCalled();
  });

  it("keeps a durable that was made for this agent: it is younger than inbox_since", async () => {
    const { admin, registry } = setup({
      "agent-scout": "2026-09-20T10:00:07.123456789Z",
      "agent-scout-broadcast": "2026-09-20T10:00:07.223456789Z",
    });
    await registry.ensure("scout", SINCE);
    expect(admin.delete).not.toHaveBeenCalled();
    expect(admin.add).not.toHaveBeenCalled();
  });

  it("replaces a durable that is older than the agent: a predecessor with the same key left it behind", async () => {
    // The delete of the old agent's durables was swallowed by an outage, the
    // process restarted, and the name was given out again.
    const { admin, registry } = setup({
      "agent-scout": "2026-08-01T09:00:00.000000000Z",
      "agent-scout-broadcast": "2026-08-01T09:00:00.100000000Z",
    });
    await registry.ensure("scout", SINCE, { replaceLeftBehind: true });
    expect(admin.delete.mock.calls.map(([n]) => n)).toEqual(["agent-scout", "agent-scout-broadcast"]);
    expect(admin.add.mock.calls.map(([c]) => c)).toEqual([
      expect.objectContaining({ durable_name: "agent-scout", deliver_policy: "by_start_time", opt_start_time: SINCE }),
      expect.objectContaining({ durable_name: "agent-scout-broadcast", deliver_policy: "by_start_time", opt_start_time: SINCE }),
    ]);
  });

  it("allows for a few seconds between the app's clock and the broker's", async () => {
    const { admin, registry } = setup({
      "agent-scout": "2026-09-20T09:59:57.000000000Z", // three seconds "before" the agent
      "agent-scout-broadcast": "2026-09-20T09:59:57.000000000Z",
    });
    await registry.ensure("scout", SINCE, { replaceLeftBehind: true });
    expect(admin.delete).not.toHaveBeenCalled();
  });

  it("replaces nothing unless it is told to: an agent from before this rule may have been reading from an inherited durable for weeks", async () => {
    // Replacing that one would hand the agent up to seven days of read mail again.
    const { admin, registry } = setup({
      "agent-scout": "2026-08-01T09:00:00.000000000Z",
      "agent-scout-broadcast": "2026-08-01T09:00:00.100000000Z",
    });
    await registry.ensure("scout", SINCE);
    await registry.ensure("scout2", SINCE, { replaceLeftBehind: false });
    expect(admin.delete).not.toHaveBeenCalled();
  });

  it("says so in the log when it replaces a durable, so a replay can be explained afterwards", async () => {
    const { registry } = setup({ "agent-scout": "2026-08-01T09:00:00.000000000Z" });
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: string) => { lines.push(String(line)); });
    const err = vi.spyOn(console, "error").mockImplementation((line: string) => { lines.push(String(line)); });
    const warn = vi.spyOn(console, "warn").mockImplementation((line: string) => { lines.push(String(line)); });
    await registry.ensure("scout", SINCE, { replaceLeftBehind: true });
    spy.mockRestore(); err.mockRestore(); warn.mockRestore();
    const line = lines.find((l) => l.includes("agent-scout") && l.includes("2026-08-01T09:00:00"));
    expect(line, lines.join("\n")).toBeDefined();
    expect(line).toContain(SINCE);
  });

  it("does not remember the key when the old durable cannot be removed", async () => {
    const { admin, registry } = setup({ "agent-scout": "2026-08-01T09:00:00.000000000Z" });
    admin.delete.mockRejectedValueOnce(timeout());
    await expect(registry.ensure("scout", SINCE, { replaceLeftBehind: true })).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(admin.add).not.toHaveBeenCalled();
    expect(registry.has("scout")).toBe(false);
  });

  it("leaves everything as it is when nothing is known about the agent", async () => {
    const { admin, registry } = setup({ "agent-scout": "2020-01-01T00:00:00.000000000Z" });
    await registry.ensure("scout");
    expect(admin.delete).not.toHaveBeenCalled();
    expect(admin.add.mock.calls.map(([c]) => c)).toEqual([
      expect.not.objectContaining({ deliver_policy: expect.anything() }),
    ]);
  });
});
