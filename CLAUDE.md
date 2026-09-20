# moshi.moshi

## What
MCP server for async agent-to-agent communication via NATS JetStream.
Agents (Claude Code, Claude Desktop, Gemini CLI) connect via MCP and exchange messages.

## Tech Stack
TypeScript, Hono, @hono/node-server, @modelcontextprotocol/sdk, nats.js, better-sqlite3

## Commands
- `npm run dev` — Dev server with hot reload (needs NATS running)
- `npm test` — Run tests (the integration suite skips itself)
- `npm run test:integration` — `tests/integration` against a throwaway NATS in Docker. Never point `MOSHI_TEST_NATS_URL` at a broker that holds data: every test deletes the stream first
- `npx tsc --noEmit` — Type check
- `docker compose up` — Full stack (mesh + NATS)

## Architecture
- `src/index.tsx` — process bootstrap only: config, services, `serve`, signals, hourly maintenance
- `src/app.tsx` — `createApp(deps)`: middleware order and mounts, no side effects; this is what `tests/app/` imports
- `src/routes/mcp.ts` — `POST /mcp` (stateless transport via `createStatelessTransport()`, body limit on the route)
- `src/routes/dashboard.tsx` — Home, Agents, Log, Conversations
- `src/routes/fragments.tsx` — `GET /fragments/<section>`: the inside of one live container, rendered by the same loader (`src/services/section-loaders.ts`) and the same component as the page; `src/views/v2/live-refresh.ts` is the browser script that swaps it in
- `src/routes/sse.ts` — `GET /sse/messages`: says WHEN to fetch the fragments (`{ id, thread_id, created_at }`, never content); `src/services/message-events.ts` is the in-process bus behind it, and its `listenerCount()` is the connection count
- `src/mcp/` — MCP server + 7 tools (mesh_send, mesh_receive, mesh_get, mesh_reply, mesh_status, mesh_register, mesh_history); `catalog.ts` is the tool reference the dashboard palette renders (a test keeps it in sync)
- `src/services/circuit-breaker.ts` — breaker in front of every broker call (pure, clock injected); `src/services/consumers.ts` — the two durables per agent, ensured once per process
- `src/services/inbox.ts` — JetStream pull logic (consumer info before fetch, shared limit); unit-tested with fake consumers
- `src/services/` — Business logic (nats, agent, message, ratelimit, activity)
- `src/views/` — Dashboard (Hono JSX, server-rendered)
- `src/auth.ts` — Bearer token + cookie auth, `safeNextPath` (checks run on the normalised target)
- `src/routes/session.ts` — sign-in / sign-out, mounted before the auth middleware
- `src/routes/form.ts` — `formString` (trimmed, typed fields) and `formRaw` (protocol values such as OAuth `state`); never cast `parseBody()` fields with `as string`
- `src/oauth.ts` — OAuth 2.1 + PKCE for interactive clients; the consent screen refuses the admin token
- `src/mcp/http-guard.ts` — `/mcp` is POST-only (405 for everything else), mounted before auth
- `src/middleware/security-headers.ts` — security headers, `Cache-Control: no-store` unless a route set its own
- `src/services/maintenance.ts` — hourly retention + expired OAuth rows (was: only at process start)
- `src/views/v2/role-index.ts` — name → role map without a prototype

## Patterns
Hono routes, MCP SDK tools with Zod validation, server-rendered JSX views,
ULID IDs, SHA-256 token hashing, timing-safe comparison.

## Key Design Decisions
- NATS is internal only (not exposed). MCP server is the only NATS client.
- Messages stored in both NATS (delivery) and SQLite (history/lookup).
- context field is mandatory — describes sender's current project/task/status (max 2048 chars).
- Rate limit: 60 messages/minute per agent (token bucket).
- Payload max: 256 KB per message.
- Context max: 2048 chars per message.
- Presence TTL: 600s (auto-updated on every MCP interaction). NATS KV holds only the liveness timestamp; role/capabilities/working_on live in SQLite. KV entries are read per agent (`kv.get`), never via `kv.keys()` (drops the latest writer).
- Every tool reply carries `inbox_pending`; `mesh_receive` acks on read, previews payloads (default 4000 chars) and has no type filter (it lost messages). `mesh_get` returns the full message.
- The admin token is an operator identity: messaging tools refuse it with an onboarding hint.
- An agent's name is a label, its `inbox_key` is the address. Subjects (`mesh.agents.<key>.inbox`) and durables (`agent-<key>`, `agent-<key>-broadcast`) derive from `agents.inbox_key`, never from `name`. The key is assigned at creation (lower-cased name, suffixed when taken) and never changes, so a rename keeps token, consumers and unread mail, and rewrites `from_agent`/`to_agent` in the history. `admin` and `broadcast` are reserved names. `mesh_send` and `mesh_reply` both refuse unknown or deactivated recipients.
- Tests: `tests/mcp/harness.ts` runs the real McpServer over an InMemoryTransport with fake NATS + in-memory SQLite. `tests/app/harness.ts` builds the whole Hono app on top of it (`app.request`).

## Pitfalls
- Agent-controlled strings (message `type`, agent `role`, agent names from history rows) are never used as keys of a plain object: use `Object.hasOwn`, a `Map`, or `roleIndex()`. "constructor" once turned two pages into a permanent HTTP 500.
- `/mcp` order is guard → auth → body limit. hono's `bodyLimit` drains a chunked body before `next()`, so it must not sit in front of auth.
- Free-text tool fields are bounded by `FIELD_LIMITS` in `src/types.ts`; tests pin both the rejecting and the accepting side.
- Presence is refreshed by tool calls only. An idle but connected client decays to `stale` after 10 minutes; the old 1 Hz GET reconnect loop that kept it `live` is gone on purpose.
- The session cookie is `Secure` when `NODE_ENV=production`; `MESH_COOKIE_SECURE=0` is the opt-out for plain-http hosts.
- Middleware order is behaviour and is pinned by `tests/app/wiring.test.ts` against the real app. Change `src/app.tsx` and those tests together, never the order alone.

- NATS outages: every broker call goes through `NatsService.guarded()`. JetStream calls time out after 1.5 s, the first outage error opens the breaker for 5 s, a `disconnect` holds it open until `reconnect`. Never add a bare `catch` around a broker call: "not found" is an answer, a timeout is not. `presence.touch` waits at most 300 ms for its KV write.
- `/livez` is liveness (container healthcheck), `/health` is readiness (reports NATS). The HTTP server starts before the first NATS connect, which retries in the background for as long as it takes.

- Live sections (Log messages, Conversations list and open thread, Home's latest conversation): the page renders a container with `data-live` + `data-live-src`, the fragment returns exactly that container's children. One component per section, used by both, and `tests/app/fragments.test.ts` compares them byte for byte with a pinned clock. Never build a second renderer in the browser: the old SSE bubble builder drifted from the server twice.
- Fragment rules: `Accept: text/x-moshi-fragment` is required (406 otherwise) and must never contain `text/html`, or an expired session turns into a redirect that `fetch` follows into the login page. ETag over the rendered HTML plus the out-of-band text; the script sends `If-None-Match` itself because pages are `no-store`, the server compares weakly and past a proxy's `-gzip` suffix (`matchesEtag`), and a 200 that brings the markup a section already shows replaces nothing. No entrance animation (`m-rise`) inside a live container, no new `@keyframes`. Thread fragments pin the thread id. Text for elements outside the container travels in the `X-Moshi-Oob` header and is written as `textContent`.
- `getThread(db, id)`: a THREAD id wins over a message id. `mesh_send` accepts any `correlation_id`, also the id of someone's reply, so one string can name a thread and a message of another thread. Every link the dashboard builds carries a thread id. `createMessage` stores a correlation id trimmed, and none when nothing is left (migration 0006 did the same to old rows): an empty one used to collect every such message in one thread that no link could name. Home's card finds its thread with `newestThreadId` (index), never with the grouped list.
- Swap rules in the script: not while `:focus-visible` is inside or a selection REACHES into the container (`range.intersectsNode`, every range; a caret does not count). Row ids live in a prototype-free object. `data-live-follow="bottom"` keeps a scroller at the bottom until the reader scrolls up. New rows are announced in `#d-live-status` (`role=status`, in the layout); live containers never get `aria-live`, a swap replaces their whole subtree.
- The message stream only triggers, it never renders: an event makes the script fetch the same fragments the timer fetches, so page, fragment and stream cannot disagree. Never put a payload, a sender or a context into an event. At most 50 connections (`SSE_MAX_CONNECTIONS`), 503 beyond; `EventSource` does not retry a non-200 by itself (that includes the proxy's 503 during a deploy), so the script reconnects (30 s, doubling to 5 min). Timer: 5 s without a stream, 60 s with one, 10 s while a lost one reconnects; only a CHANGE of stream state moves the timers, because the browser reports an error on every failed retry. A hidden tab closes its stream: it would hold one of six HTTP/1.1 connections per origin. The route answers GET only: hono runs a GET handler for HEAD and drops the body uncancelled, so a subscription made there stays for ever (50 x `curl -I` took every place). No connection lives for ever either: 256 events waiting for a reader that does not read, or 30 minutes, end it; the session is only checked when a stream opens. `/sse/*` and `/fragments/*` never refresh an agent's presence. The `updating live` pill is rendered `hidden` on a wrapper (an inline `display` beats `[hidden]`) and shown by the script while the stream is open; this replaces the design handoff's rule that the pill follows the thread's last activity.
- Thread order is `created_at, rowid`. Party order (first sender, first recipient, then whoever joins) decides titles and bubble sides; list and open thread share `partiesInOrder`. Never cut a payload in SQL before `previewPayload` has parsed it.

## Commits
Conventional Commits: feat:, fix:, chore:, docs:, refactor:
