import { describe, it, expect } from "vitest";
import {
  deriveAvatarSpec,
  initialsFor,
  renderAvatarSvg,
  renderAvatarSvgInner,
} from "../../../src/views/v2/avatar";

describe("initialsFor", () => {
  it("takes one letter per segment for a multi-segment name", () => {
    expect(initialsFor("dex-eu")).toBe("DE");
    expect(initialsFor("triage-1")).toBe("T1");
    expect(initialsFor("sec-warden")).toBe("SW");
    expect(initialsFor("cortex_local")).toBe("CL");
    expect(initialsFor("pm mira")).toBe("PM");
  });

  it("takes the first two letters of a single-segment name", () => {
    expect(initialsFor("scout")).toBe("SC");
    expect(initialsFor("qa")).toBe("QA");
  });

  it("reads a one-character name as a single letter, not a blank", () => {
    expect(initialsFor("x")).toBe("X");
  });

  it("ignores segments beyond the second", () => {
    expect(initialsFor("a-b-c-d")).toBe("AB");
  });

  it("drops non-alphanumerics and falls back rather than rendering nothing", () => {
    expect(initialsFor("")).toBe("??");
    expect(initialsFor("!!")).toBe("??");
  });
});

describe("deriveAvatarSpec", () => {
  it("is deterministic for the same name and role", () => {
    expect(deriveAvatarSpec("cloud", "dev-assistant"))
      .toEqual(deriveAvatarSpec("cloud", "dev-assistant"));
  });

  it("keys the field and monogram on the name, not on any id", () => {
    const a = deriveAvatarSpec("cloud", "dev-assistant");
    const b = deriveAvatarSpec("cortex", "dev-assistant");
    expect(a.initials).toBe("CL");
    expect(b.initials).toBe("CO");
    expect(a.field !== b.field || a.rotation !== b.rotation).toBe(true);
  });

  it("maps a known role straight to its stripe", () => {
    expect(deriveAvatarSpec("any", "security").stripe).toBe("#5a6270");
    expect(deriveAvatarSpec("any", "product-manager").stripe).toBe("#a8823f");
  });

  it("fuzzy-matches an unknown role so existing roles keep their colour", () => {
    // /dev|code|engineer/ → dev-assistant
    expect(deriveAvatarSpec("any", "code-reviewer").stripe).toBe("#5f7fb0");
    // /triage|incident/ → triage-agent
    expect(deriveAvatarSpec("any", "incident-responder").stripe).toBe("#4f8fa8");
  });

  it("falls back to the neutral stripe for an empty or unmatched role", () => {
    expect(deriveAvatarSpec("any", "").stripe).toBe("#8a8578");
    expect(deriveAvatarSpec("any", "florist").stripe).toBe("#8a8578");
    expect(deriveAvatarSpec("any").stripe).toBe("#8a8578");
  });

  it("rotates the arc motif to one of four quarter turns", () => {
    for (const name of ["a", "b", "c", "longer-name-here", "x".repeat(40)]) {
      expect([0, 90, 180, 270]).toContain(deriveAvatarSpec(name).rotation);
    }
  });

  it("never produces an empty field or ink", () => {
    for (const name of ["", "x", "ops-kai", "y".repeat(64)]) {
      const s = deriveAvatarSpec(name);
      expect(s.field).toMatch(/^#[0-9a-f]{6}$/);
      expect(s.ink).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});

describe("renderAvatarSvg", () => {
  it("returns a valid SVG in the 0-32 coordinate space", () => {
    const svg = renderAvatarSvg("cloud", "dev-assistant");
    expect(svg).toMatch(/^<svg /);
    expect(svg).toContain('viewBox="0 0 32 32"');
    expect(svg).toContain("</svg>");
  });

  it("respects a custom size", () => {
    expect(renderAvatarSvg("x", "any", { size: 64 })).toContain('width="64"');
  });

  it("emits a clip path only when asked to round", () => {
    expect(renderAvatarSvg("x", "any", { rounded: true })).toContain('clip-path="url(#r)"');
    expect(renderAvatarSvg("x", "any")).not.toContain("clip-path");
  });

  it("draws the monogram and the role stripe", () => {
    const svg = renderAvatarSvg("dex-eu", "dev-assistant");
    expect(svg).toContain(">DE<");
    expect(svg).toContain('<rect x="0" y="29.33" width="32" height="2.67"');
  });

  it("carries no portrait geometry from the previous generator", () => {
    const svg = renderAvatarSvg("x", "dev-assistant");
    expect(svg).not.toContain("<ellipse");
    expect(svg).not.toContain("shape-rendering");
  });

  it("is byte-identical for the same input", () => {
    expect(renderAvatarSvg("cortex-local", "cortex-local"))
      .toBe(renderAvatarSvg("cortex-local", "cortex-local"));
  });
});

describe("renderAvatarSvgInner", () => {
  it("returns embeddable markup with no <svg> wrapper", () => {
    const inner = renderAvatarSvgInner("cloud", "dev-assistant");
    expect(inner).toContain("<rect ");
    expect(inner).not.toContain("<svg");
    expect(inner).not.toContain("</svg>");
  });

  it("matches the inner content of renderAvatarSvg", () => {
    expect(renderAvatarSvg("cloud", "dev-assistant"))
      .toContain(renderAvatarSvgInner("cloud", "dev-assistant"));
  });
});
