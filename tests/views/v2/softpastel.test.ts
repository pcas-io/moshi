// Smoke tests for the moshi.moshi Soft Pastel design system: pastel tokens,
// soft glow shadow, sheen primitive, footer strip, responsive scaler markup.

import { describe, it, expect } from "vitest";
import { V2Layout } from "../../../src/views/v2/layout";
import { V2_TOKENS, V2_GLASS, V2_BTN } from "../../../src/views/v2/tokens";

async function render(props: Parameters<typeof V2Layout>[0]): Promise<string> {
  return String(await Promise.resolve(V2Layout(props)));
}

describe("Soft Pastel tokens", () => {
  it("uses sakura-cream bg #fdf4f8", () => {
    expect(V2_TOKENS.bg).toBe("#fdf4f8");
  });

  it("uses soft plum-tinted lines (rgba(120,80,120,...))", () => {
    expect(V2_TOKENS.line).toContain("120,80,120");
    expect(V2_TOKENS.line2).toContain("120,80,120");
  });

  it("exposes a pillowy pink primary button gradient", () => {
    expect(V2_BTN.primaryBg).toContain("linear-gradient");
    expect(V2_BTN.primaryBg).toContain("#ff");
  });

  it("glassShadow is soft + diffuse (inset highlight + pink glow, no hard anchor)", () => {
    expect(V2_GLASS.shadow).toContain("inset");
    expect(V2_GLASS.shadow).toContain("rgba(217,130,175");
    expect(V2_GLASS.shadow).not.toContain("rgba(20,16,8");
  });

  it("provides a sheen radial-gradient", () => {
    expect(V2_GLASS.sheen).toContain("radial-gradient");
    expect(V2_GLASS.sheen).toContain("rgba(255,255,255");
  });
});

describe("V2Layout — Soft Pastel shell", () => {
  it("wraps the shell in a responsive scaler", async () => {
    const html = await render({ active: "HOME", children: "x" });
    expect(html).toContain('class="v2-stage"');
    expect(html).toContain('class="v2-scaler"');
    expect(html).toContain('class="v2-shell"');
  });

  it("adds sheen overlay to top-bar and footer", async () => {
    const html = await render({ active: "HOME", children: "x" });
    const matches = html.match(/class="v2-sheen"/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it("renders the footer with stack chain + warn marker", async () => {
    const html = await render({ active: "HOME", children: "x" });
    expect(html).toContain('class="v2-footer"');
    expect(html).toContain("moshi.enki.run");
    expect(html).toContain("Hono · TypeScript");
    expect(html).toContain("NATS JetStream");
    expect(html).toContain("Apache 2.0");
    expect(html).toContain("NATS · single-node");
  });

  it("ships the responsive scaler script", async () => {
    const html = await render({ active: "HOME", children: "x" });
    expect(html).toContain("v2-design-width");
    expect(html).toContain("ResizeObserver");
    expect(html).toContain(String(V2_TOKENS.compactBreakpoint));
  });

  it("title carries the moshi.moshi brand when no page title", async () => {
    const html = await render({ active: "HOME", children: "x" });
    expect(html).toContain("moshi.moshi");
  });
});
