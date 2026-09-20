// Agent-controlled strings used as plain-object keys.
//
// A message `type` and an agent `role` are free text. Looked up in an object
// literal, "constructor" or "__proto__" return something inherited — a
// function or an object — instead of undefined. `kindColors` handed that to
// a destructuring assignment, and one broadcast with type "constructor"
// turned /log and /conversations into a permanent HTTP 500 for everyone.

import { describe, it, expect } from "vitest";
import { kindColors, KIND_COLORS } from "../../../src/views/v2/tokens";
import { kindLabel } from "../../../src/views/v2/components";
import { deriveAvatarSpec, renderAvatarSvg } from "../../../src/views/v2/avatar";
import { MessagesTable } from "../../../src/views/v2/messages";
import { roleIndex } from "../../../src/views/v2/role-index";

const INHERITED = ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"];

describe("lookups keyed by agent-controlled strings", () => {
  it("kindColors falls back to the info pair for inherited keys", () => {
    for (const key of INHERITED) {
      expect(kindColors(key), key).toEqual(KIND_COLORS["info"]);
      const [ink, ground] = kindColors(key); // what the views do
      expect(typeof ink).toBe("string");
      expect(typeof ground).toBe("string");
    }
  });

  it("kindLabel returns the raw type, never a function's source", () => {
    for (const key of INHERITED) expect(kindLabel(key), key).toBe(key);
  });

  it("an inherited key as agent role gets the fallback stripe", () => {
    const fallback = deriveAvatarSpec("scout", "no-such-role").stripe;
    for (const key of INHERITED) {
      expect(deriveAvatarSpec("scout", key).stripe, key).toBe(fallback);
    }
  });

  it("a role that is not a string cannot break the avatar", () => {
    // What a prototype-bearing lookup hands over for "constructor".
    for (const role of [Object, () => 1, {}, 42]) {
      expect(() => renderAvatarSvg("scout", role as never)).not.toThrow();
    }
  });

  it("roleIndex answers only for agents it was given", () => {
    const index = roleIndex([
      { name: "scout", role: "dev" },
      { name: "constructor", role: "qa" },
      { name: "quiet", role: null },
    ]);
    expect(index["scout"]).toBe("dev");
    expect(index["constructor"]).toBe("qa");
    expect(index["quiet"]).toBeNull();
    for (const key of ["toString", "valueOf", "hasOwnProperty", "__proto__"]) {
      expect(index[key], key).toBeUndefined();
    }
  });

  it("the log table renders mail from a deleted agent called 'constructor'", async () => {
    // Messages outlive their agent by 30 days, so the name is no longer in
    // the role index when the row is drawn.
    const row = {
      id: "msg_2", from: "constructor", to: "valueOf", type: "info", payload: "p", context: "c",
      correlation_id: null, reply_to: null, priority: "normal", ttl_seconds: 60,
      created_at: new Date().toISOString(),
    };
    for (const agentRoles of [roleIndex([]), {} as Record<string, string | null>]) {
      const html = String(await Promise.resolve(MessagesTable({
        result: { data: [row], has_more: false, total: 1, limit: 50, offset: 0 },
        agentRoles,
      } as never)));
      expect(html).toContain("constructor");
    }
  });

  it("the log table renders a message whose type is 'constructor'", async () => {
    const row = {
      id: "msg_1", from: "scout", to: "ops", type: "constructor", payload: "p", context: "c",
      correlation_id: null, reply_to: null, priority: "normal", ttl_seconds: 60,
      created_at: new Date().toISOString(),
    };
    const html = String(await Promise.resolve(MessagesTable({
      result: { data: [row], has_more: false, total: 1, limit: 50, offset: 0 },
      agentRoles: {},
    } as never)));
    expect(html).toContain("constructor");
  });
});
