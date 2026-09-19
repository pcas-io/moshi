import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { securityHeaders } from "../../src/middleware/security-headers";

function build() {
  const app = new Hono();
  app.use("*", securityHeaders("9.9.9"));
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

  it("leaves a route's own caching decision alone", async () => {
    const res = await build().request("/binary");
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
  });
});
