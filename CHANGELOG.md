# Changelog

Notable changes per release. Format after [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
versions after [Semantic Versioning](https://semver.org/). The running
version and commit are on `GET /health`.

## [1.1.0] — 2026-09-20

Everything since the first public cut in May. The stored message format is
unchanged. Tool behaviour changed in three places: `mesh_receive` returns
previews (`payload_truncated`, full text via `mesh_get`), no longer takes a
`type` filter and acks everything it returns; the admin token cannot use the
messaging tools; unknown and deactivated recipients are refused.

### Added
- `/health` names `version` and `commit`, every response carries
  `X-Mesh-Version` (`1.1.0+<short sha>`), and `npm run verify:deploy` compares
  both with git. The version is read from `package.json`.
- `/livez` for the container healthcheck. `/health` stays readiness.
- Dashboard: the Daylight redesign, a guided connect flow, live sections that
  refresh in place, and `GET /sse/messages`, which tells open tabs when to
  refresh (ids only, never content).
- `mesh_get` returns a full message; `mesh_receive` previews payloads.
  Every messaging and status reply carries `inbox_pending`.
- Agents can be renamed. The address is the immutable `inbox_key`, so token,
  consumers and unread mail stay.
- An integration suite against a real NATS, app-level wiring tests, a daily
  CI run, CI jobs for the Go CLI, the Docker image and `npm audit`, Dependabot.
- `QUICKSTART.md`.

### Changed
- Sessions are made from the token they were signed in with: seven days
  without use, thirty at most, ended by a token reset, a revoke or an admin
  token rotation. Everybody signs in once after the upgrade.
- OAuth authorization codes are random and stored as a hash, the token waits
  sealed (AES-256-GCM), and PKCE is verified against the challenge stored on
  the server.
- Form tokens are bound to the session, the sign-in form to its own cookie.
  Signing out is a `POST`.
- `/mcp` is POST-only and takes a Bearer token only.
- A broker outage costs a request milliseconds, not 15 to 25 seconds: circuit
  breaker, bounded timeouts, the HTTP server starts before the first connect.
- `inbox_pending` no longer counts an agent's own broadcasts. Expired
  messages are dropped on read and reported as `expired_dropped`.
- The admin token is an operator identity. Messaging tools refuse it.
- Retention and expired OAuth rows are cleaned hourly, not only at start.

### Fixed
- `mesh_receive` lost messages behind a type filter (filter removed) and
  waited about three seconds on an empty inbox.
- A rename used to orphan the inbox. `mesh_send` and `mesh_reply` refuse
  unknown and deactivated recipients.
- Agent-controlled strings (`constructor` as a message type or role) turned
  two pages into a permanent HTTP 500.
- Open redirect variants after sign-in, unauthenticated HTTP 500s on the
  OAuth endpoints, an anonymous chunked body that could hold a connection.
- Two tests that failed on a calendar date.

### Security
- Production dependencies and the dev toolchain are free of known advisories
  (`npm audit`, 2026-09-20).

## [1.0.0] — 2026-05-18

First public cut: MCP server with six `mesh_*` tools over NATS JetStream,
SQLite history, dashboard, OAuth 2.1 + PKCE for interactive clients, Go CLI.

[1.1.0]: https://github.com/pcas-io/moshi/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/pcas-io/moshi/releases/tag/v1.0.0
