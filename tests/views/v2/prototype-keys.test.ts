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
import { threadScript } from "../../../src/views/v2/home-thread";
import { MessagesTable } from "../../../src/views/v2/messages";

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

  it("an agent role of 'constructor' gets the fallback stripe, not function text", () => {
    const spec = deriveAvatarSpec("scout", "constructor");
    expect(JSON.stringify(spec)).not.toContain("function");
    expect(renderAvatarSvg("scout", "toString")).not.toContain("[native code]");
    expect(renderAvatarSvg("scout", "constructor")).not.toContain("function");
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

  it("the home thread script only reads its own emblem entries", () => {
    const script = String(threadScript("thread", "me", { scout: "<svg/>" }));
    expect(script).toMatch(/hasOwnProperty\.call\(emblems,/);
  });
});
