// The live sections' endpoints: GET /fragments/<section>.
//
// A fragment is the INSIDE of one live container on a page, server-rendered
// by the same loader and the same component the page uses. The browser
// script (src/views/v2/live-refresh.ts) fetches it every few seconds and
// swaps it in. There is no second, client-side renderer to drift apart.
//
// Contract, pinned by tests/app/fragments.test.ts:
// - `Accept: text/x-moshi-fragment` is required (406 otherwise), so a plain
//   navigation never shows bare fragment HTML. The value must not contain
//   "text/html": that is what makes the auth middleware answer an expired
//   session with a redirect to /login, which fetch() would follow.
// - `ETag` over the rendered HTML plus the out-of-band text, `304` on a
//   match. `Cache-Control: no-store, no-transform` stays, so the browser never revalidates
//   by itself: the script sends If-None-Match. The comparison is the weak one
//   of RFC 9110, and it looks past a `-gzip` / `-br` suffix: a compressing
//   proxy hands the tag back changed, and an exact match would never be one.
// - No <html>, no <script>.

import { Hono } from "hono";
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { Context } from "hono";
import type { Env, AppVariables } from "../types.js";
import type { AgentService } from "../services/agent.js";
import type { PresenceService } from "../services/presence.js";
import {
  loadConversationList,
  loadLogMessages,
  loadOpenThread,
  readConversationsQuery,
  readOffset,
  readText,
} from "../services/section-loaders.js";
import { loadHomeLatest } from "../services/v2-home-data.js";
import { roleIndex } from "../views/v2/role-index.js";
import {
  COUNT_LINE_ID,
  ConversationListSection,
  ConversationThreadSection,
  conversationCountLine,
} from "../views/v2/conversations.js";
import { LogMessagesSection, messageRoutingOf, parseLogRouting } from "../views/v2/log.js";
import { LatestConversationSection } from "../views/v2/home.js";
import { parseActivityRange } from "../services/activity.js";

type HonoEnv = { Bindings: Env; Variables: AppVariables };

/** The Accept value the live script sends. Deliberately not text/html. */
export const FRAGMENT_ACCEPT = "text/x-moshi-fragment";

export interface FragmentDeps {
  db: Database.Database;
  agents: AgentService;
  presence: PresenceService;
  /** Render clock. Injected by tests so page and fragment agree exactly. */
  now?: () => number;
}

async function renderToString(node: unknown): Promise<string> {
  const out = (node as { toString(): string | Promise<string> }).toString();
  return typeof out === "string" ? out : await out;
}

/** Text for elements OUTSIDE of the live container, as `id=text&id=text`,
 *  percent-encoded. The script writes each into `#id` as textContent. */
export const OUT_OF_BAND_HEADER = "X-Moshi-Oob";

/** Does If-None-Match name this tag? Weak comparison (RFC 9110, 8.8.3.2):
 *  `W/` does not count, the header is a list, `*` matches anything. A suffix
 *  a compressing proxy appended inside the quotes does not count either. */
export function matchesEtag(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  const opaque = (tag: string) => tag.trim().replace(/^W\//, "").replace(/-(gzip|br|deflate|zstd)"$/, '"');
  const wanted = opaque(etag);
  return header.split(",").some((candidate) => candidate.trim() === "*" || opaque(candidate) === wanted);
}

/** 200 with an ETag, or 304 when the client already has this markup. */
async function respond(c: Context<HonoEnv>, node: unknown, outOfBand: Record<string, string> = {}): Promise<Response> {
  const html = await renderToString(node);
  const oob = new URLSearchParams(outOfBand).toString();
  // The out-of-band text is part of what the client has: it goes into the hash.
  const etag = `"${createHash("sha256").update(html).update("\u0000").update(oob).digest("hex").slice(0, 32)}"`;
  // no-transform: a proxy must leave the markup and the tag alone. Cloudflare
  // weakens or drops the ETag of HTML it rewrites, and its email obfuscation
  // turns addresses into markup whose decoder never runs for HTML that
  // arrives through innerHTML.
  const headers: Record<string, string> = { ETag: etag, "Cache-Control": "no-store, no-transform" };
  if (oob) headers[OUT_OF_BAND_HEADER] = oob;
  if (matchesEtag(c.req.header("if-none-match"), etag)) return c.body(null, 304, headers);
  return c.body(html, 200, { ...headers, "Content-Type": "text/html; charset=UTF-8" });
}

export function createFragmentRoutes({ db, agents, presence, now = Date.now }: FragmentDeps): Hono<HonoEnv> {
  const frag = new Hono<HonoEnv>();

  frag.use("/fragments/*", async (c, next) => {
    if (!(c.req.header("accept") ?? "").includes(FRAGMENT_ACCEPT)) {
      return c.json({ error: "not_acceptable", hint: `send Accept: ${FRAGMENT_ACCEPT}` }, 406);
    }
    await next();
  });

  // --- Log, Messages tab ---
  frag.get("/fragments/log/messages", (c) => {
    const get = (key: string) => c.req.query(key);
    const routing = parseLogRouting(get("routing"));
    const query = { offset: readOffset(get), q: readText(get, "q"), agent: readText(get, "agent") };
    return respond(c,
      <LogMessagesSection
        messages={loadLogMessages(db, { ...query, routing: messageRoutingOf(routing) })}
        query={query.q}
        routing={routing}
        filterAgent={query.agent}
        // These two do nothing to messages; the pager links carry them.
        filterEntity={readText(get, "entity")}
        filterRange={parseActivityRange(get("range"))}
        agentRoles={roleIndex(agents.list())}
        now={now()}
      />,
    );
  });

  // --- Conversations: the list ---
  frag.get("/fragments/conversations/list", (c) => {
    const query = readConversationsQuery((key) => c.req.query(key));
    const result = loadConversationList(db, query);
    const clock = now();
    return respond(c,
      <ConversationListSection
        result={result}
        // The id is already the resolved thread id: the page put it there.
        openedId={query.id}
        query={query.q}
        filterAgent={query.agent}
        agentRoles={roleIndex(agents.list())}
        now={clock}
      />,
      { [COUNT_LINE_ID]: conversationCountLine(result, clock) },
    );
  });

  // --- Conversations: the open thread, pinned by id ---
  frag.get("/fragments/conversations/thread", (c) => {
    const { id } = readConversationsQuery((key) => c.req.query(key)); // read exactly like the page reads it
    const { opened, unknownId } = id
      ? loadOpenThread(db, { id }, { data: [], has_more: false, total: 0, limit: 0, offset: 0 })
      : { opened: null, unknownId: undefined };
    return respond(c,
      <ConversationThreadSection
        thread={opened}
        unknownId={unknownId}
        agentRoles={roleIndex(agents.list())}
        now={now()}
      />,
    );
  });

  // --- Home: the latest conversation card ---
  frag.get("/fragments/home/latest", async (c) => {
    const { thread, agents: roster } = await loadHomeLatest({ db, presence });
    return respond(c, <LatestConversationSection thread={thread} agents={roster} now={new Date(now())} />);
  });

  return frag;
}
