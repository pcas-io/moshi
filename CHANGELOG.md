# Changelog

Notable changes per release. Format after [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
versions after [Semantic Versioning](https://semver.org/). The running
version and commit are on `GET /health`.

## [Unreleased]

### Added
- `mesh_inbox`, the eighth tool: the latest mail from the history, without
  acknowledging anything. Every message carries `read_at`, the moment
  `mesh_receive` handed it out. `mesh_receive` acks before its answer has
  reached the agent; this is where a message is found whose answer got lost.
- `mesh_send` and `mesh_reply` name `expires_at`. `mesh_get` and
  `mesh_history` say whether a message was read (`read_at`, or `read_by` for a
  broadcast).
- A send whose delivery could not be confirmed can be repeated under its id:
  `message_id` in `mesh_send`, `resend_id` in `mesh_reply`. Only by its
  sender, and only as the same message: every send is recorded before it is
  published. The recipient gets it once, the history one row. The same
  repeat stores a message whose reply said `history_gap: true`.
- Audit rows `message_expired` (a direct message ran out unread; also found
  by the hourly sweep when the recipient never polls), `message_dead_letter`
  (the broker stopped redelivering a message), `message_stored` (a repeat
  wrote the history row that was missing; nothing was sent) and
  `read_not_recorded` (a message was handed out and the read could not be
  stored, so the sweep leaves it alone).

### Changed
- The CLI speaks English. Scripts that grep its German output break; the
  message id is in both.
- The CLI has no compiled-in server any more. `install.sh` and
  `install.ps1` remember the server they fetched the binary from in
  `~/.config/moshi/config.json` (`%APPDATA%\moshi` on Windows); `--url` and
  `MESH_URL` win over it, and with none of the three the CLI says so. A bare
  origin gets `/mcp` added.
- `install.sh`, `install.ps1` and `moshi self-update` check the binary
  against the hash the server publishes before it becomes executable;
  `self-update` runs over https only (plain http to localhost is allowed)
  and reads at most 64 MB.
- One argument parser for every command: a flag a command does not know is
  refused instead of landing in the message, `--` ends the flags,
  `reply` takes `--context`. A one-word message that happens to be a type
  (`moshi send ops info`) is sent as text when stdin is empty instead of
  waiting on it.
- `moshi receive` exits 2 with a sentence on stderr when the server cannot
  reach its broker; a 404, 405 or 429 is explained.
- Go tests for the CLI, run by CI.
- `correlation_id` in `mesh_send` has to name an existing thread. The id of a
  reply is rewritten to the thread it belongs to; a made-up id is refused.
- `mesh_reply` to one's own message goes to whoever the message was for, not
  back to the sender.
- The rate limit is a token bucket (a burst of 60, then one a second) instead
  of a window that let 119 messages through inside a second. It is charged
  once a request is valid, and `mesh_register` draws on it too.
- `mesh_receive` hands a message to an agent once, also when the broker
  delivers it again.

### Database
- Migration `0010_message_reads.sql`: `messages.to_key`, tables
  `message_reads` and `send_attempts`, indexes on `activity_log` and
  `messages(to_agent, created_at)`. A release from before it keeps working on
  the new schema. The runner now skips a migration another process applied
  while it waited for the lock.

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
