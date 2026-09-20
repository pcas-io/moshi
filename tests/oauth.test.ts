import { describe, it, expect } from "vitest";
import { isAllowedRedirectUri } from "../src/oauth";

// Authorization codes and the sealed token live in src/oauth-codes.ts and are
// tested in tests/oauth-codes.test.ts.

describe("isAllowedRedirectUri", () => {
  it("allows http localhost with port", () => {
    expect(isAllowedRedirectUri("http://localhost:8080/callback")).toBe(true);
  });

  it("allows https localhost", () => {
    expect(isAllowedRedirectUri("https://localhost/cb")).toBe(true);
  });

  it("allows 127.0.0.1", () => {
    expect(isAllowedRedirectUri("http://127.0.0.1:3000/cb")).toBe(true);
  });

  it("allows [::1] IPv6 loopback", () => {
    expect(isAllowedRedirectUri("http://[::1]:3000/cb")).toBe(true);
  });

  it("allows *.localhost subdomains (e.g. app.localhost)", () => {
    expect(isAllowedRedirectUri("http://app.localhost:3000/cb")).toBe(true);
  });

  it("rejects external domain", () => {
    expect(isAllowedRedirectUri("http://evil.com/cb")).toBe(false);
  });

  it("rejects localhost-lookalike (localhost.evil.com)", () => {
    expect(isAllowedRedirectUri("http://localhost.evil.com/cb")).toBe(false);
  });

  it("allows Anthropic hosted connector (claude.ai/claude.com, https)", () => {
    expect(isAllowedRedirectUri("https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(isAllowedRedirectUri("https://claude.com/api/mcp/auth_callback")).toBe(true);
    expect(isAllowedRedirectUri("https://eu.claude.ai/api/mcp/auth_callback")).toBe(true);
  });

  it("rejects hosted connector over http and lookalikes", () => {
    expect(isAllowedRedirectUri("http://claude.ai/cb")).toBe(false);
    expect(isAllowedRedirectUri("https://claude.ai.evil.com/cb")).toBe(false);
    expect(isAllowedRedirectUri("https://notclaude.ai/cb")).toBe(false);
  });

  it("rejects javascript scheme", () => {
    expect(isAllowedRedirectUri("javascript:alert(1)")).toBe(false);
  });

  it("rejects file scheme", () => {
    expect(isAllowedRedirectUri("file:///etc/passwd")).toBe(false);
  });

  it("rejects malformed URI", () => {
    expect(isAllowedRedirectUri("not a url")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isAllowedRedirectUri("")).toBe(false);
  });
});
