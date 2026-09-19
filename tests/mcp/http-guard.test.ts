// /mcp is stateless and POST-only.
//
// GET used to reach the transport, which answers 200 text/event-stream; the
// route then closed the transport at once. SDK clients treat a cleanly ended
// stream as "reconnect" with the retry counter reset, so every connected
// client re-dialled about once a second, forever. Only a 405 stops it.

import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { mcpPostOnly } from "../../src/mcp/http-guard";

function build() {
  const app = new Hono();
  let reached = 0;
  app.all("/mcp", mcpPostOnly, (c) => { reached++; return c.json({ ok: true }); });
  return { app, reached: () => reached };
}

describe("mcpPostOnly", () => {
  it("answers GET and DELETE with 405 and Allow: POST, before anything is built", async () => {
    for (const method of ["GET", "DELETE", "PUT", "PATCH"]) {
      const { app, reached } = build();
      const res = await app.request("/mcp", { method });
      expect(res.status, method).toBe(405);
      expect(res.headers.get("allow"), method).toBe("POST");
      expect(await res.json()).toMatchObject({ jsonrpc: "2.0", error: { code: -32000 }, id: null });
      expect(reached()).toBe(0);
    }
  });

  it("lets POST through", async () => {
    const { app, reached } = build();
    const res = await app.request("/mcp", { method: "POST" });
    expect(res.status).toBe(200);
    expect(reached()).toBe(1);
  });
});
