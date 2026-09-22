// The nonce reaches a script through <InlineScript> and through nothing else
// (src/views/nonce.tsx). What must never exist is a pass over the finished
// HTML that adds the nonce to every <script> it finds: that would bless
// exactly the script a Content-Security-Policy is there to stop.

import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { raw } from "hono/html";
import { jsx } from "hono/jsx";
import { page, InlineScript } from "../../src/views/nonce";

function appWith(nonce: string) {
  const app = new Hono<{ Variables: { cspNonce: string } }>();
  app.use("*", async (c, next) => { c.set("cspNonce", nonce); await next(); });
  return app;
}

describe("page()", () => {
  it("gives the nonce to InlineScript", async () => {
    const app = appWith("N0nce");
    app.get("/", (c) => page(c, jsx("div", {}, jsx(InlineScript, { code: "ok()" })) as never));
    expect(await (await app.request("/")).text()).toBe('<div><script nonce="N0nce">ok()</script></div>');
  });

  it("leaves a script that did not come through InlineScript without one", async () => {
    const app = appWith("N0nce");
    app.get("/", (c) => page(c, raw('<div><script>injected()</script><SCRIPT src="/x.js"></SCRIPT></div>') as never));
    const html = await (await app.request("/")).text();
    expect(html).toBe('<div><script>injected()</script><SCRIPT src="/x.js"></SCRIPT></div>');
    expect(html).not.toContain("N0nce");
  });
});
