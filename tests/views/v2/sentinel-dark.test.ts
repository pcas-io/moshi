// Smoke tests for the moshi.moshi SENTINEL Dark design system: charcoal
// tokens, neon-green accent, Sora/JetBrains Mono, responsive shell (no
// fixed-width scaler), hero variant, footer strip.

import { describe, it, expect } from "vitest";
import { V2Layout } from "../../../src/views/v2/layout";
import { V2_TOKENS, V2_CSS, V2_HERO_BG, V2_GRID_BG, greenGlow } from "../../../src/views/v2/tokens";

async function render(props: Parameters<typeof V2Layout>[0]): Promise<string> {
  return String(await Promise.resolve(V2Layout(props)));
}

describe("SENTINEL Dark tokens", () => {
  it("uses charcoal page bg #0f0f0f and card surface #161616", () => {
    expect(V2_TOKENS.bg).toBe("#0f0f0f");
    expect(V2_TOKENS.surface).toBe("#161616");
  });

  it("uses the neon-green accent hsl(119 99% 46%) with dark ink", () => {
    expect(V2_TOKENS.accent).toBe("hsl(119 99% 46%)");
    expect(V2_TOKENS.accentInk).toBe("#0a0a0a");
  });

  it("keeps the presence palette: amber stale, red danger, blue info", () => {
    expect(V2_TOKENS.warn).toBe("#e0992f");
    expect(V2_TOKENS.danger).toBe("#ef4444");
    expect(V2_TOKENS.info).toBe("#6aa8e8");
  });

  it("greenGlow produces the accent as rgba", () => {
    expect(greenGlow(0.5)).toBe("rgba(5,233,1,0.5)");
  });

  it("ships Sora + JetBrains Mono and sharp 2px CTAs in the base CSS", () => {
    expect(V2_CSS).toContain("Sora");
    expect(V2_CSS).toContain("JetBrains Mono");
    expect(V2_CSS).toContain(`border-radius: ${V2_TOKENS.radiusBtn}px`);
  });

  it("hero background layers green radial glows over charcoal", () => {
    expect(V2_HERO_BG).toContain("radial-gradient");
    expect(V2_HERO_BG).toContain("rgba(5,233,1");
    expect(V2_HERO_BG).toContain(V2_TOKENS.bg);
  });
});

describe("V2Layout — SENTINEL Dark shell", () => {
  it("renders a responsive wrap without the legacy fixed-width scaler", async () => {
    const html = await render({ active: "HOME", children: "x" });
    expect(html).toContain('class="v2-wrap');
    expect(html).not.toContain("v2-scaler");
    expect(html).not.toContain("v2-stage");
  });

  it("renders the brand with green mark and accent dot", async () => {
    const html = await render({ active: "HOME", children: "x" });
    expect(html).toContain('class="v2-brand-mark"');
    expect(html).toContain("moshi");
    expect(html).toContain('class="dot"');
  });

  it("marks the active nav link", async () => {
    const html = await render({ active: "MESSAGES", children: "x" });
    expect(html).toMatch(/href="\/messages" class="active"/);
  });

  it("hides the Agents nav entry from non-admins", async () => {
    const agentHtml = await render({ active: "HOME", children: "x", userRole: "agent" });
    expect(agentHtml).not.toContain('href="/agents" class=');
    const adminHtml = await render({ active: "HOME", children: "x", userRole: "admin" });
    expect(adminHtml).toContain('href="/agents"');
  });

  it("renders the footer with stack chain + single-node warning", async () => {
    const html = await render({ active: "HOME", children: "x" });
    expect(html).toContain("moshi.enki.run");
    expect(html).toContain("Hono · TypeScript");
    expect(html).toContain("NATS JetStream");
    expect(html).toContain("Apache 2.0");
    expect(html).toContain("NATS · SINGLE-NODE");
  });

  it("renders the 56px grid pattern only in hero mode", async () => {
    const plain = await render({ active: "HOME", children: "x" });
    expect(plain).not.toContain("background-size:56px 56px");
    const hero = await render({ active: "HOME", children: "x", hero: "h" });
    expect(hero).toContain("background-size:56px 56px");
    expect(hero).toContain(V2_GRID_BG.slice(0, 40));
  });

  it("declares dark color-scheme", async () => {
    const html = await render({ active: "HOME", children: "x" });
    expect(html).toContain('content="dark"');
  });
});
