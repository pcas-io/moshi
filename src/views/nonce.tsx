// Inline scripts and the nonce of the response they are in.
//
// The Content-Security-Policy allows a script only when it carries the nonce
// of THIS response (src/middleware/security-headers.ts). The nonce reaches the
// views through a context, so that no page has to pass it down by hand, and a
// script is only ever written through <InlineScript>: the code is a constant
// of this code base, never anything a request said.
//
// What this must never become: a pass over the finished HTML that adds the
// nonce to every <script> it finds. That would bless exactly the script a CSP
// is there to stop.

import type { FC } from "hono/jsx";
import { createContext, useContext } from "hono/jsx";
import { raw } from "hono/html";
import type { Context } from "hono";
import type { HtmlEscapedString } from "hono/utils/html";

export const NonceContext = createContext<string>("");

export const InlineScript: FC<{ code: string }> = ({ code }) => {
  const nonce = useContext(NonceContext);
  return raw(`<script${nonce ? ` nonce="${nonce}"` : ""}>${code}</script>`);
};

/** `c.html()` for a page, with the response's nonce in reach of its scripts. */
// biome-ignore lint/suspicious/noExplicitAny: works for every route's context
export function page(c: Context<any>, node: HtmlEscapedString | Promise<HtmlEscapedString>, status: 200 | 401 | 403 | 404 | 429 = 200) {
  const nonce = (c.get("cspNonce") as string | undefined) ?? "";
  return c.html(<NonceContext.Provider value={nonce}>{node}</NonceContext.Provider>, status);
}
