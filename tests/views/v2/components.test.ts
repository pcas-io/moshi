import { describe, it, expect } from "vitest";
import {
  PRESENCE_COLOR,
  PRESENCE_WORD,
  avatarRadius,
  kindLabel,
  V2Dot,
  V2Avatar,
  V2Btn,
  V2Pill,
  V2Card,
} from "../../../src/views/v2/components";
import { V2_TOKENS } from "../../../src/views/v2/tokens";

async function render(node: unknown): Promise<string> {
  return String(await Promise.resolve(node));
}

describe("presence", () => {
  it("keeps all four states and folds never into the offline colour", () => {
    expect(PRESENCE_COLOR.live).toBe(V2_TOKENS.presenceLive);
    expect(PRESENCE_COLOR.stale).toBe(V2_TOKENS.presenceStale);
    expect(PRESENCE_COLOR.offline).toBe(V2_TOKENS.presenceOffline);
    expect(PRESENCE_COLOR.never).toBe(V2_TOKENS.presenceOffline);
  });

  it("labels the states in words a person would say out loud", () => {
    expect(PRESENCE_WORD).toEqual({
      live: "online", stale: "quiet", offline: "asleep", never: "never seen",
    });
  });

  it("renders the dot without a glow — a shadow only blurs the edge on white", async () => {
    const html = await render(V2Dot({ presence: "live" }));
    expect(html).toContain(V2_TOKENS.presenceLive);
    expect(html).not.toContain("box-shadow");
  });

  it("pulses only when asked, and only while live", async () => {
    expect(await render(V2Dot({ presence: "live", pulse: true }))).toContain("m-pulse");
    expect(await render(V2Dot({ presence: "stale", pulse: true }))).not.toContain("m-pulse");
    expect(await render(V2Dot({ presence: "live" }))).not.toContain("m-pulse");
  });
});

describe("avatarRadius", () => {
  it("scales the corner with the emblem, per the handoff's shape table", () => {
    expect(avatarRadius(22)).toBe(8);
    expect(avatarRadius(26)).toBe(8);
    expect(avatarRadius(34)).toBe(10);
    expect(avatarRadius(40)).toBe(11);
    expect(avatarRadius(44)).toBe(13);
    expect(avatarRadius(52)).toBe(15);
  });
});

describe("V2Avatar", () => {
  it("is keyed on the agent name, not an id", async () => {
    const html = await render(V2Avatar({ name: "dex-eu", role: "dev-assistant", size: 34 }));
    expect(html).toContain(">DE<");
    expect(html).toContain("border-radius:10px");
    expect(html).toContain('width="34"');
  });

  it("survives a null role without throwing", async () => {
    expect(await render(V2Avatar({ name: "x", role: null }))).toContain(">X<");
  });
});

describe("V2Btn", () => {
  it("fills the primary button green under white text", async () => {
    const html = await render(V2Btn({ kind: "primary", children: "Connect an agent" }));
    expect(html).toContain(`background:${V2_TOKENS.green}`);
    expect(html).toContain("color:#ffffff");
    expect(html).toContain("d-solid");
  });

  it("gives the gated look no hover and a dim label", async () => {
    const html = await render(V2Btn({ kind: "muted", children: "Copy it first" }));
    expect(html).toContain(`color:${V2_TOKENS.dim}`);
    expect(html).toContain("cursor:default");
    expect(html).not.toContain("d-solid");
  });

  it("renders as a link when given an href", async () => {
    const html = await render(V2Btn({ kind: "primary", href: "/agents/connect", children: "Go" }));
    expect(html).toMatch(/^<a /);
    expect(html).toContain('href="/agents/connect"');
  });

  it("outlines the destructive action in red rather than filling it", async () => {
    const html = await render(V2Btn({ kind: "danger", children: "Deactivate" }));
    expect(html).toContain(`color:${V2_TOKENS.red}`);
    expect(html).toContain(`border:1px solid ${V2_TOKENS.redLine}`);
  });
});

describe("V2Pill", () => {
  it("is filled, not outlined", async () => {
    const html = await render(V2Pill({ ink: "#c0392b", ground: "#fcedeb", children: "incident" }));
    expect(html).toContain("background:#fcedeb");
    expect(html).toContain("color:#c0392b");
    expect(html).toContain(`border-radius:${V2_TOKENS.radiusPill}px`);
  });
});

describe("V2Card", () => {
  it("carries the one card shadow and the 18px radius", async () => {
    const html = await render(V2Card({ title: "Latest conversation", children: "x" }));
    expect(html).toContain(`border-radius:${V2_TOKENS.radiusCard}px`);
    expect(html).toContain("box-shadow:0 1px 2px rgba(36,33,29,.04)");
    expect(html).toContain("Latest conversation");
  });

  it("renders the footer on the sunk ground when one is given", async () => {
    const html = await render(V2Card({ title: "t", foot: "Read the whole thread →", children: "x" }));
    expect(html).toContain(`background:${V2_TOKENS.sunk}`);
    expect(html).toContain("Read the whole thread →");
  });
});

describe("kindLabel", () => {
  it("renames the four-word wire types to something a reader can scan", () => {
    expect(kindLabel("task_update")).toBe("progress");
    expect(kindLabel("deploy_request")).toBe("deploy ask");
    expect(kindLabel("deploy_status")).toBe("deploy done");
    expect(kindLabel("review_request")).toBe("review ask");
    expect(kindLabel("review_result")).toBe("review done");
  });

  it("passes every other type through unchanged, including unknown ones", () => {
    for (const t of ["info", "question", "answer", "reply", "incident", "script", "made-up"]) {
      expect(kindLabel(t)).toBe(t);
    }
  });
});
