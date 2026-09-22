// Smoke tests for the moshi.moshi "Daylight" design system: warm light
// tokens, the usable green, Sora/JetBrains Mono, the four-item shell, the
// footer, and the contrast floor the handoff set.

import { describe, it, expect } from "vitest";
import { V2Layout } from "../../../src/views/v2/layout";
import { V2_TOKENS, V2_CSS, KIND_COLORS, kindColors } from "../../../src/views/v2/tokens";
import { V2_INTERACTION_CSS } from "../../../src/views/v2/components";

async function render(props: Parameters<typeof V2Layout>[0]): Promise<string> {
  return String(await Promise.resolve(V2Layout(props)));
}

/** WCAG 2.x relative luminance / contrast ratio for two #rrggbb values. */
function contrast(a: string, b: string): number {
  const lum = (hex: string): number => {
    const n = parseInt(hex.slice(1), 16);
    const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}

describe("Daylight tokens", () => {
  it("uses warm paper #faf7f2 with white cards", () => {
    expect(V2_TOKENS.paper).toBe("#faf7f2");
    expect(V2_TOKENS.card).toBe("#ffffff");
  });

  it("keeps the neon out: the green is a usable value", () => {
    expect(V2_TOKENS.green).toBe("#0e8a3e");
    expect(V2_TOKENS.greenText).toBe("#0c7c38");
    expect(V2_TOKENS.greenDeep).toBe("#0a6e31");
    expect(JSON.stringify(V2_TOKENS)).not.toContain("hsl(119");
    expect(JSON.stringify(V2_TOKENS)).not.toContain("05e901");
  });

  it("keeps the four presence states, with the neon surviving only as the dot", () => {
    expect(V2_TOKENS.presenceLive).toBe("#16a34a");
    expect(V2_TOKENS.presenceStale).toBe("#b7791f");
    expect(V2_TOKENS.presenceOffline).toBe("#c5bdb0");
    expect(V2_TOKENS.live).toBe(V2_TOKENS.presenceLive);
  });

  it("meets 4.5:1 for every text ink on its stated ground", () => {
    expect(contrast(V2_TOKENS.ink, V2_TOKENS.card)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(V2_TOKENS.body, V2_TOKENS.card)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(V2_TOKENS.faint, V2_TOKENS.card)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(V2_TOKENS.greenText, V2_TOKENS.card)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(V2_TOKENS.greenDeep, V2_TOKENS.greenSoft)).toBeGreaterThanOrEqual(4.5);
    // Two measured exceptions, both deliberate and both pinned here so a
    // later tweak cannot quietly make them worse:
    //   `dim` on white is 4.49:1 — allowed at >= 13px only.
    //   white on `green` is 4.45:1 — solid fills only, and the handoff chose it.
    expect(contrast(V2_TOKENS.dim, V2_TOKENS.card)).toBeGreaterThan(4.4);
    expect(contrast("#ffffff", V2_TOKENS.green)).toBeGreaterThan(4.4);
  });

  it("ships only the two motion keyframes, both reduced-motion aware", () => {
    expect(V2_CSS).toContain("@keyframes m-rise");
    expect(V2_CSS).toContain("@keyframes m-pulse");
    expect(V2_CSS).toContain("prefers-reduced-motion");
    expect(V2_CSS.match(/@keyframes/g)).toHaveLength(2);
  });

  it("defines link colours, because an undefined link renders browser blue", () => {
    expect(V2_CSS).toContain("a { color: var(--green-text)");
    expect(V2_CSS).toContain("a:hover");
  });

  it("drops the whole .v2-* class set the dark design encoded its look in", () => {
    for (const cls of [".v2-btn", ".v2-chip", ".v2-card", ".v2-nav", ".v2-eyebrow",
      ".v2-h1", ".v2-input", ".v2-tag", ".v2-topbar", ".v2-footer", ".v2-toast"]) {
      expect(V2_CSS).not.toContain(cls);
    }
  });

  it("maps message and audit kinds to a filled ink/ground pair", () => {
    expect(kindColors("incident")).toEqual([V2_TOKENS.red, V2_TOKENS.redSoft]);
    expect(kindColors("question")).toEqual([V2_TOKENS.blue, V2_TOKENS.blueSoft]);
    expect(kindColors("script")).toEqual([V2_TOKENS.purple, V2_TOKENS.purpleSoft]);
    expect(kindColors("something-new")).toEqual(KIND_COLORS["info"]);
  });

  // Pills render at 12px, so AA applies in full. Three pairs used the fill
  // colour as ink and measured 3.3-4.0:1; they now use this file's deeper
  // inks. Measured here so a later colour tweak cannot quietly undo it.
  it("clears 4.5:1 on every single kind pill", () => {
    for (const [kind, [ink, ground]] of Object.entries(KIND_COLORS)) {
      expect(contrast(ink, ground), `${kind}: ${ink} on ${ground}`)
        .toBeGreaterThanOrEqual(4.5);
    }
  });

  it("uses the deeper ink, not the fill colour, where the fill was too light", () => {
    expect(kindColors("answer")).toEqual([V2_TOKENS.greenDeep, V2_TOKENS.greenSoft]);
    expect(kindColors("review_request")).toEqual([V2_TOKENS.amberInk, V2_TOKENS.amberSoft]);
    expect(kindColors("info")).toEqual([V2_TOKENS.faint, V2_TOKENS.subtle]);
  });
});

describe("Daylight interaction CSS", () => {
  it("gives every interactive element a visible focus ring", () => {
    expect(V2_INTERACTION_CSS).toContain("button:focus-visible");
    expect(V2_INTERACTION_CSS).toContain("input:focus-visible");
    expect(V2_INTERACTION_CSS).toContain(`outline: 2px solid ${V2_TOKENS.green}`);
  });

  it("darkens solid fills on hover without moving anything", () => {
    expect(V2_INTERACTION_CSS).toContain("filter: brightness(0.94)");
    expect(V2_INTERACTION_CSS).not.toContain("translate");
  });

  // Pages set their backgrounds inline, which outranks any selector — these
  // three hovers are dead without it, and were, on all four table screens.
  it("forces the background hovers past the inline styles the pages set", () => {
    for (const rule of [".d-ghost:hover", ".d-row:hover", ".d-tab:hover"]) {
      const line = V2_INTERACTION_CSS.split("\n").find((l) => l.startsWith(rule));
      expect(line, rule).toBeDefined();
      expect(line, rule).toContain("!important");
    }
  });
});

describe("V2Layout — the Daylight shell", () => {
  it("declares English and a light colour scheme", async () => {
    const html = await render({ active: "HOME", children: "x" });
    expect(html).toContain('lang="en"');
    expect(html).toContain('content="light"');
    expect(html).not.toContain('lang="de"');
  });

  it("ships four nav items and no Messages entry", async () => {
    const html = await render({ active: "HOME", children: "x", userRole: "admin" });
    expect(html).toContain(">Home<");
    expect(html).toContain(">Agents<");
    expect(html).toContain(">Conversations<");
    expect(html).toContain(">Log<");
    expect(html).not.toContain('href="/messages"');
    expect(html).not.toContain('href="/activity"');
  });

  it("marks the active nav item with the subtle fill and 600 weight", async () => {
    const html = await render({ active: "LOG", children: "x" });
    expect(html).toMatch(
      new RegExp(`href="/log" style="[^"]*font-weight:600[^"]*background:${V2_TOKENS.subtle}`),
    );
  });

  it("hides Agents and the connect button from non-admins", async () => {
    const agentHtml = await render({ active: "HOME", children: "x", userRole: "agent" });
    expect(agentHtml).not.toContain('href="/agents"');
    expect(agentHtml).not.toContain("Connect an agent");
    const adminHtml = await render({ active: "HOME", children: "x", userRole: "admin" });
    expect(adminHtml).toContain('href="/agents"');
    expect(adminHtml).toContain('href="/agents/connect"');
    expect(adminHtml).toContain("Connect an agent");
  });

  it("has no hero surface and no grid overlay left", async () => {
    const html = await render({ active: "HOME", children: "x" });
    expect(html).not.toContain("background-size:56px 56px");
    expect(html).not.toContain("radial-gradient");
  });

  it("states the two infrastructure facts and drops the single-node alarm", async () => {
    const html = await render({ active: "HOME", children: "x" });
    expect(html).toContain("moshi.enki.run");
    expect(html).toContain("NATS JetStream · single node");
    expect(html).toContain("SQLite");
    expect(html).toContain("Apache 2.0");
    expect(html).not.toContain("NATS · SINGLE-NODE");
    expect(html).not.toContain("Hetzner");
  });

  it("uses the green favicon, not the neon one", async () => {
    const html = await render({ active: "HOME", children: "x" });
    expect(html).toContain("fill='%230e8a3e'");
    expect(html).not.toContain("05e901");
  });

  it("brings its two typefaces from this origin, one variable file per subset", async () => {
    const html = await render({ active: "HOME", children: "x" });
    expect(html.match(/@font-face/g)).toHaveLength(4); // Sora and JetBrains Mono, latin and latin-ext
    expect(html).toMatch(/url\(\/fonts\/sora-latin\.[0-9a-f]{10}\.woff2\)/);
    expect(html).toMatch(/url\(\/fonts\/jetbrains-mono-latin\.[0-9a-f]{10}\.woff2\)/);
    expect(html).not.toMatch(/googleapis|gstatic/);
  });

  it("signs out through a CSRF-carrying POST, not a bare link", async () => {
    const html = await render({ active: "HOME", children: "x", csrfToken: "tok-123", userName: "admin" });
    expect(html).toContain('action="/logout"');
    expect(html).toContain('name="csrf" value="tok-123"');
    expect(html).toContain('title="Sign out"');
  });

  it("injects the one shared copy handler exactly once", async () => {
    const html = await render({ active: "HOME", children: "x" });
    expect(html.match(/if \(window\.__dCopy\) return/g)).toHaveLength(1);
    expect(html).toContain("d-copied");
  });

  it("narrows the container for the doc-width pages", async () => {
    const app = await render({ active: "HOME", children: "x" });
    const doc = await render({ active: "AGENTS", children: "x", narrow: true });
    expect(app).toContain(`max-width:${V2_TOKENS.maxWidthApp}px`);
    expect(doc).toContain(`max-width:${V2_TOKENS.maxWidthDoc}px`);
  });
});
