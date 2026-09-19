import { describe, it, expect } from "vitest";
import { formString } from "../../src/routes/form";
import { validateCsrfToken, generateCsrfToken } from "../../src/auth";

describe("formString", () => {
  it("returns trimmed strings and nothing else", () => {
    const body = { a: "  x  ", b: "", c: ["x", "y"], d: new File(["x"], "f.txt"), e: undefined } as Record<string, unknown>;
    expect(formString(body, "a")).toBe("x");
    expect(formString(body, "b")).toBeUndefined();
    expect(formString(body, "c")).toBeUndefined();
    expect(formString(body, "d")).toBeUndefined();
    expect(formString(body, "e")).toBeUndefined();
    expect(formString(body, "missing")).toBeUndefined();
  });
});

describe("validateCsrfToken — hostile input", () => {
  const SECRET = "s".repeat(32);
  it("rejects anything that is not a non-empty string instead of throwing", () => {
    for (const bad of [undefined, null, "", 123, [], {}, new File(["x"], "f")]) {
      expect(validateCsrfToken(bad as never, SECRET)).toBe(false);
    }
    expect(validateCsrfToken(generateCsrfToken(SECRET), SECRET)).toBe(true);
  });
});
