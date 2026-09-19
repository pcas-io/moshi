// /mcp is a stateless, POST-only JSON-RPC endpoint.
//
// The SDK transport also answers GET (an SSE stream for server-initiated
// messages) and DELETE (session teardown). This server has neither: every
// request gets a fresh transport that is closed when the handler returns.
// A GET therefore produced `200 text/event-stream` and an immediately closed
// stream — which SDK clients read as "reconnect", with the retry counter
// reset, about once a second, forever. Each of those GETs ran the auth
// middleware, a presence write and two JetStream calls. Only a 405 tells a
// client that there is no stream to wait for.

import type { MiddlewareHandler } from "hono";

export const mcpPostOnly: MiddlewareHandler = async (c, next) => {
  if (c.req.method === "POST") return next();
  c.header("Allow", "POST");
  return c.json(
    { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null },
    405,
  );
};
