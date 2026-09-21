// The stream's configuration is code (src/services/stream-config.ts).
//
// It used to be create-only: `streams.info` and, on ANY error, `streams.add`.
// A stream made by an older version kept its old limits for ever, and a
// timeout was answered with a create.

import { describe, it, expect, vi } from "vitest";
import { reconcileStream, type StreamAdmin, type WantedStream } from "../../src/services/stream-config";

const WANTED: WantedStream = {
  name: "MESH_MESSAGES",
  subjects: ["mesh.agents.>", "mesh.broadcast"],
  retention: "limits",
  storage: "file",
  max_age: 7 * 24 * 3600 * 1e9,
  max_bytes: 1_073_741_824,
  duplicate_window: 300e9,
  num_replicas: 1,
};

const notFound = () => Object.assign(new Error("stream not found"), { api_error: { err_code: 10059 } });

function admin(config: Record<string, unknown> | Error, state: Record<string, unknown> = { messages: 0, bytes: 0 }): StreamAdmin & { add: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> } {
  return {
    info: vi.fn(async () => { if (config instanceof Error) throw config; return { config, state }; }),
    add: vi.fn(async () => ({})),
    update: vi.fn(async () => ({})),
  };
}

describe("reconcileStream", () => {
  it("creates the stream when there is none", async () => {
    const a = admin(notFound());
    expect(await reconcileStream(a, WANTED, () => {})).toBe("created");
    expect(a.add).toHaveBeenCalledWith(WANTED);
    expect(a.update).not.toHaveBeenCalled();
  });

  it("passes an outage on instead of answering it with a create", async () => {
    const a = admin(new Error("TIMEOUT"));
    await expect(reconcileStream(a, WANTED, () => {})).rejects.toThrow("TIMEOUT");
    expect(a.add).not.toHaveBeenCalled();
  });

  it("leaves a stream alone that is what it should be, whatever else the broker reports about it", async () => {
    const a = admin({ ...WANTED, subjects: ["mesh.broadcast", "mesh.agents.>"], discard: "old", max_msgs: -1, sealed: false });
    expect(await reconcileStream(a, WANTED, () => {})).toBe("unchanged");
    expect(a.update).not.toHaveBeenCalled();
  });

  it("updates what differs, keeps what it does not manage, and logs from and to", async () => {
    const lines: string[] = [];
    const current = { ...WANTED, max_age: 24 * 3600 * 1e9, subjects: ["mesh.agents.>"], discard: "old", description: "made in May" };
    const a = admin(current);
    expect(await reconcileStream(a, WANTED, (level, msg, extra) => lines.push(`${level} ${msg} ${JSON.stringify(extra)}`))).toBe("updated");
    expect(a.update).toHaveBeenCalledTimes(1);
    expect(a.update).toHaveBeenCalledWith("MESH_MESSAGES", { ...current, max_age: WANTED.max_age, subjects: WANTED.subjects });
    expect(lines.join("\n")).toContain('"field":"max_age"');
    expect(lines.join("\n")).toContain('"field":"subjects"');
    expect(lines[0]).toMatch(/^warn /);
  });

  it("answers only 'stream not found' with a create: by its code, or by its message, and nothing that merely sounds like it", async () => {
    const byCode = admin(Object.assign(new Error("whatever the text says"), { api_error: { err_code: 10059 } }));
    expect(await reconcileStream(byCode, WANTED, () => {})).toBe("created");
    const byMessage = admin(new Error("stream not found"));
    expect(await reconcileStream(byMessage, WANTED, () => {})).toBe("created");
    for (const other of [
      Object.assign(new Error("consumer not found"), { api_error: { err_code: 10014 } }),
      Object.assign(new Error("account not found"), { api_error: { err_code: 10035, code: 503 } }),
      new Error("not found"),
      Object.assign(new Error("stream not found"), { api_error: { err_code: 10035 } }), // the code wins over the text
    ]) {
      const a = admin(other);
      await expect(reconcileStream(a, WANTED, () => {}), other.message).rejects.toThrow();
      expect(a.add, other.message).not.toHaveBeenCalled();
    }
  });

  it("manages every field it names: a drift in any of them is an update", async () => {
    for (const [field, value] of [["duplicate_window", 1e9], ["num_replicas", 3], ["max_bytes", 1], ["max_age", 1e9], ["subjects", ["mesh.broadcast"]], ["retention", "interest"]] as const) {
      const a = admin({ ...WANTED, [field]: value });
      expect(await reconcileStream(a, WANTED, () => {}), field).toBe("updated");
      expect(a.update, field).toHaveBeenCalledWith("MESH_MESSAGES", expect.objectContaining({ [field]: WANTED[field] }));
    }
  });

  it("says what a smaller limit will cost BEFORE it applies it: the broker removes the mail at once", async () => {
    const lines: string[] = [];
    const log = (level: string, msg: string, extra?: Record<string, unknown>) => lines.push(`${level} ${msg} ${JSON.stringify(extra)}`);
    const a = admin({ ...WANTED, max_age: 0, max_bytes: -1 }, { messages: 6, bytes: 200_880, first_ts: "2026-09-13T08:00:00Z" });
    a.update.mockImplementation(async () => { lines.push("UPDATE SENT"); return {}; });
    await reconcileStream(a, WANTED, log);
    const loss = lines.findIndex((l) => l.startsWith("error ") && l.includes("removes stored messages at once"));
    expect(loss).toBeGreaterThanOrEqual(0);
    expect(loss).toBeLessThan(lines.indexOf("UPDATE SENT"));
    expect(lines[loss]).toContain('"messages":6');
    expect(lines[loss]).toContain("2026-09-13T08:00:00Z");
    // Raising a limit is not that kind of news.
    const calm: string[] = [];
    await reconcileStream(admin({ ...WANTED, max_age: 3600e9 }), WANTED, (level, msg) => calm.push(`${level} ${msg}`));
    expect(calm.join("\n")).not.toContain("removes stored messages");
  });

  it("does not try to change what a broker never changes, and says so loudly", async () => {
    const lines: string[] = [];
    const a = admin({ ...WANTED, storage: "memory" });
    expect(await reconcileStream(a, WANTED, (level, msg, extra) => lines.push(`${level} ${msg} ${JSON.stringify(extra)}`))).toBe("drift");
    expect(a.update).not.toHaveBeenCalled();
    expect(lines.join("\n")).toMatch(/^error .*"field":"storage"/);
  });

  it("still fixes the rest when one field cannot be changed", async () => {
    const a = admin({ ...WANTED, storage: "memory", max_bytes: 1 });
    expect(await reconcileStream(a, WANTED, () => {})).toBe("drift");
    expect(a.update).toHaveBeenCalledWith("MESH_MESSAGES", expect.objectContaining({ max_bytes: WANTED.max_bytes, storage: "memory" }));
  });

  it("reports an update the broker refuses as drift and lets the service start", async () => {
    // interest to limits the broker does in place; to workqueue it refuses.
    const lines: string[] = [];
    const a = admin({ ...WANTED, retention: "workqueue" });
    a.update.mockRejectedValue(Object.assign(new Error("stream configuration update can not change retention policy to/from workqueue"), { api_error: { err_code: 10052 } }));
    expect(await reconcileStream(a, WANTED, (level, msg, extra) => lines.push(`${level} ${msg} ${JSON.stringify(extra)}`))).toBe("drift");
    expect(lines.join("\n")).toMatch(/^error .*refused/m);
    // An outage is not a refusal.
    const down = admin({ ...WANTED, max_age: 1e9 });
    down.update.mockRejectedValue(Object.assign(new Error("TIMEOUT"), { code: "TIMEOUT" }));
    await expect(reconcileStream(down, WANTED, () => {})).rejects.toThrow("TIMEOUT");
  });
});
