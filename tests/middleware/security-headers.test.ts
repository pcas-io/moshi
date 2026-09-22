import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { securityHeaders } from "../../src/middleware/security-headers";

function build() {
  const app = new Hono();
  app.use("*", securityHeaders({ version: "9.9.9", cspMode: "enforce", hsts: false }));
  app.get("/page", (c) => c.html("<p>token bt_secret</p>"));
  app.get("/binary", (c) => { c.header("Cache-Control", "public, max-age=300"); return c.body("x"); });
  return app;
}

describe("securityHeaders", () => {
  it("sets the fixed headers on every response", async () => {
    const res = await build().request("/page");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(res.headers.get("x-mesh-version")).toBe("9.9.9");
  });

  it("marks dynamic responses no-store: the agents page can carry a one-time token", async () => {
    const res = await build().request("/page");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("gives a page a policy with a nonce of its own, and anything else a locked one", async () => {
    const app = build();
    const a = await app.request("/page");
    const b = await app.request("/page");
    const nonce = (res: Response) => /'nonce-([^']+)'/.exec(res.headers.get("content-security-policy") ?? "")?.[1];
    expect(nonce(a)).toBeTruthy();
    expect(nonce(a)).not.toBe(nonce(b));
    expect((await app.request("/binary")).headers.get("content-security-policy")).toBe("default-src 'none'; frame-ancestors 'none'");
  });

  it("leaves a route's own caching decision alone", async () => {
    const res = await build().request("/binary");
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
  });
});
