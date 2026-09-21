// scripts/verify-deploy.mjs — the comparison, without git and without a network.

import { describe, it, expect } from "vitest";
// @ts-expect-error — a plain .mjs script, no types
import { compare } from "../../scripts/verify-deploy.mjs";

const HEAD = "dd7c1ee0a1b2c3d4e5f60718293a4b5c6d7e8f90";

describe("verify-deploy compare()", () => {
  it("is satisfied when commit and version both match", () => {
    expect(compare({ health: { commit: HEAD, version: "1.1.0" }, head: HEAD, version: "1.1.0" })).toEqual({ code: 0, problems: [] });
    expect(compare({ health: { commit: HEAD.slice(0, 7).toUpperCase(), version: "1.1.0" }, head: HEAD, version: "1.1.0" }).code).toBe(0);
  });

  it("reports another commit", () => {
    const r = compare({ health: { commit: "a".repeat(40), version: "1.1.0" }, head: HEAD, version: "1.1.0" });
    expect(r.code).toBe(1);
    expect(r.problems.join(" ")).toContain("commit");
  });

  it("reports a version that does not belong to the commit, even when the commit matches", () => {
    // The second, independent check: a frozen commit field is caught by it,
    // and so is a comparison against the wrong ref.
    const r = compare({ health: { commit: HEAD, version: "1.0.0" }, head: HEAD, version: "1.1.0" });
    expect(r.code).toBe(1);
    expect(r.problems.join(" ")).toContain("version");
  });

  it("takes seven characters for a commit and not six", () => {
    expect(compare({ health: { commit: HEAD.slice(0, 7), version: "1.1.0" }, head: HEAD, version: "1.1.0" }).code).toBe(0);
    expect(compare({ health: { commit: HEAD.slice(0, 6), version: "1.1.0" }, head: HEAD, version: "1.1.0" }).code).toBe(2);
  });

  it("cannot tell when /health names no commit, and says where to look", () => {
    for (const commit of ["unknown", "", undefined, 42, "main"]) {
      const r = compare({ health: { commit, version: "1.1.0" }, head: HEAD, version: "1.1.0" });
      expect(r.code, String(commit)).toBe(2);
      expect(r.problems[0]).toContain("SOURCE_COMMIT");
    }
    expect(compare({ health: null, head: HEAD, version: "1.1.0" }).code).toBe(2);
  });
});
