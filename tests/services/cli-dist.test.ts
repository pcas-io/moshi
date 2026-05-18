import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { registerCliRoutes } from "../../src/services/cli-dist";

function app() {
  // Route handlers only touch c.req / c.json / c.body — no bindings needed.
  const a = new Hono();
  registerCliRoutes(a as never);
  return a;
}

describe("cli-dist routes", () => {
  it("serves an origin-aware POSIX install script", async () => {
    const res = await app().request("/install.sh", {
      headers: { host: "moshi.enki.run", "x-forwarded-proto": "https" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("shellscript");
    const body = await res.text();
    expect(body).toContain("#!/bin/sh");
    expect(body).toContain("https://moshi.enki.run/cli/");
    expect(body).toContain("uname -m");
    expect(body).toContain("moshi self-update");
  });

  it("serves a Windows PowerShell install script", async () => {
    const res = await app().request("/install.ps1", {
      headers: { host: "moshi.enki.run" },
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Invoke-WebRequest");
    expect(body).toContain("moshi-windows-");
  });

  it("/cli/version returns a platforms map", async () => {
    const res = await app().request("/cli/version");
    expect(res.status).toBe(200);
    const j = (await res.json()) as { platforms: Record<string, string>; count: number };
    expect(j).toHaveProperty("platforms");
    expect(typeof j.count).toBe("number");
    // No cli-dist in the test/dev tree → empty but well-formed.
    expect(j.count).toBe(Object.keys(j.platforms).length);
  });

  it("rejects path-traversal / bogus asset names with 404", async () => {
    for (const p of ["/cli/..%2f..%2fetc%2fpasswd", "/cli/evil.sh", "/cli/moshi-plan9-mips"]) {
      const res = await app().request(p);
      expect(res.status).toBe(404);
    }
  });

  it("404s a valid asset name when the build is absent (dev tree)", async () => {
    const res = await app().request("/cli/moshi-linux-amd64");
    expect(res.status).toBe(404);
    const j = (await res.json()) as { error: string };
    expect(j.error).toBe("not_found");
  });
});
