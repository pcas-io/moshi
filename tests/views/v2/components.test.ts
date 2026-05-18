import { describe, it, expect } from "vitest";
import { withAlpha } from "../../../src/views/v2/components";

describe("withAlpha", () => {
  it("converts #rrggbb to rgba", () => {
    expect(withAlpha("#ff3d2e", 0.5)).toBe("rgba(255,61,46,0.5)");
  });

  it("expands #rgb shorthand", () => {
    expect(withAlpha("#fff", 1)).toBe("rgba(255,255,255,1)");
  });

  it("rewrites alpha on existing rgba", () => {
    expect(withAlpha("rgba(10,20,30,0.9)", 0.2)).toBe("rgba(10,20,30,0.2)");
  });

  it("upgrades rgb() to rgba()", () => {
    expect(withAlpha("rgb(10,20,30)", 0.4)).toBe("rgba(10,20,30,0.4)");
  });

  it("passes through unknown formats", () => {
    expect(withAlpha("oklch(0.5 0.1 200)", 0.7)).toBe("oklch(0.5 0.1 200)");
  });
});
