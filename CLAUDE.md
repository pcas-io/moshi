# moshi.moshi

## What
MCP server for async agent-to-agent communication via NATS JetStream.
Agents (Claude Code, Claude Desktop, Gemini CLI) connect via MCP and exchange messages.

## Tech Stack
TypeScript, Hono, @hono/node-server, @modelcontextprotocol/sdk, nats.js, better-sqlite3

## Commands
- `npm run dev` — Dev server with hot reload (needs NATS running)
- `npm test` — Run tests
- `npx tsc --noEmit` — Type check
- `docker compose up` — Full stack (mesh + NATS)

## Architecture
- `src/index.tsx` — process bootstrap only: config, services, `serve`, signals, hourly maintenance
- `src/app.tsx` — `createApp(deps)`: middleware order and mounts, no side effects; this is what `tests/app/` imports
- `src/routes/mcp.ts` — `POST /mcp` (stateless transport via `createStatelessTransport()`, body limit on the route)
- `src/routes/dashboard.tsx` — Home, thread SSE, Agents, Log, Conversations
- `src/mcp/` — MCP server + 7 tools (mesh_send, mesh_receive, mesh_get, mesh_reply, mesh_status, mesh_register, mesh_history); `catalog.ts` is the tool reference the dashboard palette renders (a test keeps it in sync)
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

## Commits
Conventional Commits: feat:, fix:, chore:, docs:, refactor:
