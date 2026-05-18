import { describe, it, expect } from "vitest";
import { deriveAvatarSpec, renderAvatarSvg, renderAvatarSvgInner } from "../../../src/views/v2/avatar";

describe("deriveAvatarSpec", () => {
  it("is deterministic for the same id", () => {
    const a = deriveAvatarSpec("cloud", "dev-assistant");
    const b = deriveAvatarSpec("cloud", "dev-assistant");
    expect(a).toEqual(b);
  });

  it("produces different specs for different ids", () => {
    const a = deriveAvatarSpec("cloud", "dev-assistant");
    const b = deriveAvatarSpec("cortex", "dev-assistant");
    // At least the variants must differ; palette pick may collide.
    expect(a.hairVariant !== b.hairVariant ||
           a.eyeVariant !== b.eyeVariant ||
           a.mouthVariant !== b.mouthVariant ||
           a.bg !== b.bg).toBe(true);
  });

  it("maps known role to its kit", () => {
    const spec = deriveAvatarSpec("any", "security");
    expect(spec.kit.accessory).toBe("shades");
    expect(spec.kit.collar).toBe("suit");
    expect(spec.shirt).toBe("#5a5a6a");
  });

  it("falls back via fuzzy match for unknown roles", () => {
    const spec = deriveAvatarSpec("any", "code-reviewer");
    // matches /dev|code|engineer/ → dev-assistant kit
    expect(spec.kit.accessory).toBe("headset");
    expect(spec.kit.collar).toBe("hoodie");
  });

  it("falls back to default kit when role is empty", () => {
    const spec = deriveAvatarSpec("any", "");
    expect(spec.kit.accessory).toBe("cap");
    expect(spec.kit.collar).toBe("shirt");
  });

  it("variants stay in expected ranges", () => {
    for (const id of ["a", "b", "c", "longer-id-here", "x".repeat(40)]) {
      const s = deriveAvatarSpec(id);
      expect(s.hairVariant).toBeGreaterThanOrEqual(0);
      expect(s.hairVariant).toBeLessThan(8);
      expect(s.eyeVariant).toBeGreaterThanOrEqual(0);
      expect(s.eyeVariant).toBeLessThan(4);
      expect(s.mouthVariant).toBeGreaterThanOrEqual(0);
      expect(s.mouthVariant).toBeLessThan(4);
    }
  });
});

describe("renderAvatarSvg", () => {
  it("returns a valid SVG string", () => {
    const svg = renderAvatarSvg("cloud", "dev-assistant");
    expect(svg).toMatch(/^<svg /);
    expect(svg).toContain('viewBox="0 0 32 32"');
    expect(svg).toContain("</svg>");
  });

  it("respects custom size", () => {
    expect(renderAvatarSvg("x", "any", { size: 64 })).toContain('width="64"');
  });

  it("emits clip-path when rounded", () => {
    expect(renderAvatarSvg("x", "any", { rounded: true })).toContain('clip-path="url(#r)"');
  });

  it("renders smooth anime shapes (ellipses, no pixel crispEdges)", () => {
    const svg = renderAvatarSvg("x");
    expect(svg).not.toContain('shape-rendering="crispEdges"');
    expect(svg).toContain("<ellipse ");
  });

  it("is byte-identical for the same input", () => {
    expect(renderAvatarSvg("crtx-local", "cortex-local"))
      .toBe(renderAvatarSvg("crtx-local", "cortex-local"));
  });
});

describe("renderAvatarSvgInner", () => {
  it("returns rect markup with no <svg> wrapper (embeddable)", () => {
    const inner = renderAvatarSvgInner("cloud", "dev-assistant");
    expect(inner).toContain("<rect ");
    expect(inner).not.toContain("<svg");
    expect(inner).not.toContain("</svg>");
  });

  it("matches the inner content of renderAvatarSvg", () => {
    const full = renderAvatarSvg("cloud", "dev-assistant");
    const inner = renderAvatarSvgInner("cloud", "dev-assistant");
    expect(full).toContain(inner);
  });

  it("is deterministic", () => {
    expect(renderAvatarSvgInner("crtx-local", "cortex-local"))
      .toBe(renderAvatarSvgInner("crtx-local", "cortex-local"));
  });
});
