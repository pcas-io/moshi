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
- `src/mcp/` — MCP server + 6 tools (mesh_send, mesh_receive, mesh_reply, mesh_status, mesh_register, mesh_history)
- `src/services/` — Business logic (nats, agent, message, ratelimit, activity)
- `src/views/` — Dashboard (Hono JSX, server-rendered)
- `src/auth.ts` — Bearer token + cookie auth
- `src/oauth.ts` — OAuth 2.1 + PKCE for interactive clients

## Patterns
Follows ernie/buddy patterns: Hono routes, MCP SDK tools with Zod validation,
server-rendered JSX views, ULID IDs, SHA-256 token hashing, timing-safe comparison.

## Key Design Decisions
- NATS is internal only (not exposed). MCP server is the only NATS client.
- Messages stored in both NATS (delivery) and SQLite (history/lookup).
- context field is mandatory — describes sender's current project/task/status (max 2048 chars).
- Rate limit: 60 messages/minute per agent (token bucket).
- Payload max: 256 KB per message.
- Context max: 2048 chars per message.
- Presence TTL: 600s (auto-updated on every MCP interaction).

## Commits
Conventional Commits: feat:, fix:, chore:, docs:, refactor:
