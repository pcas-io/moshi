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
- `src/mcp/` — MCP server + 7 tools (mesh_send, mesh_receive, mesh_get, mesh_reply, mesh_status, mesh_register, mesh_history); `catalog.ts` is the tool reference the dashboard palette renders (a test keeps it in sync)
- `src/services/inbox.ts` — JetStream pull logic (consumer info before fetch, shared limit); unit-tested with fake consumers
- `src/services/` — Business logic (nats, agent, message, ratelimit, activity)
- `src/views/` — Dashboard (Hono JSX, server-rendered)
- `src/auth.ts` — Bearer token + cookie auth
- `src/oauth.ts` — OAuth 2.1 + PKCE for interactive clients

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
- Tests: `tests/mcp/harness.ts` runs the real McpServer over an InMemoryTransport with fake NATS + in-memory SQLite.

## Commits
Conventional Commits: feat:, fix:, chore:, docs:, refactor:
