// ensureConsumer used to run on every /mcp request: two lookups, and a bare
// `catch` that took ANY failure for "does not exist" and tried to create the
// consumer. With the broker gone that was a second full timeout per durable.

import { describe, it, expect, vi } from "vitest";
import { ConsumerRegistry } from "../../src/services/consumers";

const notFound = () => Object.assign(new Error("consumer not found"), { api_error: { err_code: 10014 } });
const timeout = () => Object.assign(new Error("TIMEOUT"), { code: "TIMEOUT" });

function setup(existing: string[] = []) {
  const known = new Set(existing);
  const admin = {
    info: vi.fn(async (name: string) => { if (!known.has(name)) throw notFound(); return {}; }),
    add: vi.fn(async (config: { durable_name?: string }) => { known.add(config.durable_name!); return {}; }),
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
