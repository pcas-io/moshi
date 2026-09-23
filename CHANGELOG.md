# Changelog

Notable changes per release. Format after [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
versions after [Semantic Versioning](https://semver.org/). The running
version and commit are on `GET /health`.

## [Unreleased]

### Added
- `MESH_PUBLIC_URL`: the origin this deployment calls itself. It addresses
  everything the dashboard hands out to be pasted into a shell — the two
  install scripts and the connect snippets. Unset, the request's own `Host`
  is used, which is a header and therefore the client's to choose.
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
- `moshi receive` names what it dropped in the mixed case too. The count
  was printed only when the batch was empty, and the pull tops its limit up
  with valid messages, so the case where something expired AND something
  arrived is the designed one — and the one where the count went missing.
- `--context ""` is refused instead of sent. The server's schema has no
  minimum length, so an empty context was stored, and a recipient is told to
  read the context before acting.
- A server URL with no scheme no longer ends the "no token" message halfway
  through: `baseURL` hands back what it cannot parse instead of exiting, and
  the error that follows names the right problem.
- One argument parser for every command, `status`, `get` and `history`
  included: a flag a command does not know is refused instead of landing in
  the message or in a message id, `--` ends the flags, `reply` takes
  `--context`. A one-word message that happens to be a type
  (`moshi send ops info`) is sent as text when stdin is at EOF, instead of
  failing with "empty message". An open but silent stdin still waits, as it
  did before.
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

### Fixed
- Conversations on a narrow screen. The two panes used to WRAP inside a split
  of a fixed height with `overflow: hidden`, and a wrapped flex line is not
  bounded by its container: below 850 px the thread pane kept its content
  height — 17 836 px with a long thread on a 320 px screen — its own scroller
  never scrolled, and every message past the first screenful was unreachable
  by wheel, by page scroll and by keyboard. The panes now divide the split by
  `flex-direction`, each from a zero flex basis, so both scroll inside it.
  Measured in Chromium at 320, 360, 390, 414, 768, 790, 843, 849, 850, 900,
  1280 and 1920 px: the last message is reachable at every one, and the thread
  list stays reachable with it.
- The breakpoint sat at 790 px, 54 px before the panes actually stopped
  stacking, so between 790 and 843 px one of the two was pushed out of the
  clipped split entirely. Direction leaves nothing for a wrap point to
  disagree with; the switch is at 850 px, where the two flex bases fit.
- Home's card and the attention band linked to a conversation without
  `#thread`, the Conversations rows with it, so which entry point a reader had
  followed decided where the tap landed. One `threadHref` for all three.
- On a 320 px screen the open thread's own header and footer took 366 of its
  383 px and left one line to read in. Stacked, the footer keeps its headline
  and its reply command, and the meta line stops after two lines.
- `mesh_inbox`'s `never_handed_out` counts the whole inbox again, not the
  page it just returned. `limit` moved a number that the tool's own
  description, the README and CLAUDE.md all call a property of the inbox: 17
  unsent messages with the default limit answered `never_handed_out: 10`
  against `unread: 17` — smaller than `unread`, which is impossible under
  that reading, so an agent that trusts the wording concludes seven were
  already handed to it. It is a bounded count beside `unread` now, stops at
  100 the same way, and stays a superset of it.
- `mesh_get` and `mesh_history` say that `read_at` and `read_by` are ABSENT,
  not `null`, for a message stored before migration 0010. About those rows
  nothing is known, and `null` says the opposite — "never delivered" — for
  every message of the 30 days before that deploy.
- The local compose file binds its port to `127.0.0.1`. It also turns the
  `Secure` flag off, so on a laptop on an office network a bare port offered
  the dashboard and its sign-in form to the whole LAN in cleartext — from a
  file whose first line says "reachable from this machine".
- `PORT` takes digits and nothing else. `parseInt` stops at the first
  character that is not one, so `PORT="8080 # behind the proxy"` was read as
  8080 with the comment silently discarded, and `80abc` as 80 — the one value
  the README's promise ("refuses to start on a value it cannot make sense
  of") did not hold for.
- The README's quickstart waits for the app. Compose waits for the NATS
  healthcheck only, and moshi's own has a 30 s interval and no
  `start_period`, so the `curl` on the next line of the same block fired
  before anything was listening.

### Documentation
- `OAUTH_SECRET` does not follow "the same rules as above": outside
  production it may be left out, and `MESH_ADMIN_TOKEN` is then used as it
  is, unhashed and without the warning the cookie secret prints.
- `BACKUP_DIR` and `BACKUP_KEEP` govern the copy written before a migration
  as well as the daily ones, `BACKUP_KEEP=0` included.
- `MOSHI_COMMIT` and `SOURCE_COMMIT` are in the table.
- A browser keeps a `Secure` cookie on `http://localhost` — the exception the
  quickstart relies on. The LAN address a colleague would use is not covered.
- Resetting an agent's token ends its dashboard sessions with their next
  request; the README said nothing else was disturbed, DEPLOY.md said the
  opposite three lines further on.

### Security
- `--` now ends the global `--url` and `--token` flags too. The scan for
  those two ran over every argument and knew nothing about the marker, so a
  message that contained `--url http://elsewhere` sent the real bearer token
  to that host — and the CLI printed `✓ Sent to <agent>` and exited 0. One
  forwarded word was enough: a ticket body, a log line, an agent relaying
  text. `--token` the same way, under an identity the sender did not choose.
- `moshi self-update` keeps its transport across redirects. `secureURL` ran
  once, on the configured URL, and Go's default client then followed up to
  ten redirects to any host and any scheme. A redirect on `/cli/version` and
  one on the binary moved BOTH onto plain http, where the integrity check
  compared the attacker's bytes against the attacker's hash and passed. The
  check is on the scheme, not on the host: an https server may still serve
  its binaries from somewhere else.
- `install.sh` and `install.ps1` no longer reflect a request header into
  their own source. `x-forwarded-proto` is free text, it was interpolated
  unescaped, and a crafted value produced a `BASE=` line that ran a command
  when the served script was run the way the documentation says to. The
  header is now either `http` or discarded, a `Host` must be a plain host,
  and both sinks are single-quoted.
- The served installer follows the scheme it was actually spoken to. It fell
  back to `https` whatever the request had been, so an instance served over
  plain http handed out an `install.sh` that fetched from `https://` its own
  host and died on TLS.
- A relative `XDG_CONFIG_HOME` is ignored, as the XDG spec says it must be.
  It was joined as it came, so `XDG_CONFIG_HOME=relcfg moshi status` read
  `./relcfg/moshi/config.json`: same binary, same environment, and the
  working directory decided which server received the bearer token.

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
