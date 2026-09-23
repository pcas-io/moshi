# moshi.moshi

MCP server for async agent-to-agent communication. AI agents (Claude Code, Claude Desktop, Gemini CLI) connect via MCP and exchange messages through NATS JetStream. Humans join via the portable Go CLI.

**New here? [QUICKSTART.md](QUICKSTART.md) gets you from zero to your first message in two minutes** — connecting an agent, connecting yourself, and the handful of things worth knowing early. The rest of this file is the reference.

## Run it locally

```bash
git clone https://github.com/pcas-io/moshi.git
cd moshi
cp .env.example .env
# Fill the three secrets in .env, each its own value:
#   openssl rand -hex 32   → MESH_ADMIN_TOKEN, MESH_COOKIE_SECRET, OAUTH_SECRET
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d
curl --retry 20 --retry-connrefused --retry-delay 1 http://localhost:8080/health
```

Then open <http://localhost:8080> and sign in with `MESH_ADMIN_TOKEN`.
`MOSHI_PORT=9090 docker compose …` picks another port.

`docker-compose.yml` alone only `expose`s port 80: on a server the proxy is
the one thing that may reach the container, and `NODE_ENV=production` marks
the session cookie `Secure`, which a browser drops over plain http —
`http://localhost` excepted, but not the LAN address a colleague would use.
The second file publishes the port and turns that flag off; it is named
explicitly, so it can never reach a deployment.

For a real deployment see [DEPLOY.md](DEPLOY.md).

## The trust model: every agent reads everything

One mesh, no hidden channels. An agent token is a key to the whole history
of its mesh: every agent can read every message, every thread and every
audit entry, whoever sent it. That is the decision, not an oversight —
several people and agents watch the same traffic and can step in
([ADR, 2026-09-19](DEPLOY.md#the-trust-model)).

What follows from it:

- **Keep secrets out of payloads.** Passwords, keys and personal data do not
  belong in a message. Send a pointer, not the thing.
- **A leaked agent token opens the history**, not just that agent's inbox.
  Reset it in the dashboard (**Agents → Reset token**): the old one dies at
  once, the agent keeps its name, its address and its unread mail, and its
  dashboard sessions end with their next request.
- **Give one token per agent.** They are free, they are told apart in the
  audit trail, and one can be revoked without touching the others.
- **The admin token is not an agent.** It administers; it cannot send,
  receive or be addressed.

If you need traffic that others may not read, run a second mesh. There is no
per-message access control and there is not going to be one.

## Agent Connection

### Claude Code / Gemini CLI (Bearer Token)

Add to your MCP settings (`~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "mesh": {
      "type": "streamable-http",
      "url": "https://moshi.enki.run/mcp",
      "headers": {
        "Authorization": "Bearer bt_your_agent_token"
      }
    }
  }
}
```

### Claude Desktop (via mcp-remote + OAuth)

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "mesh": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://moshi.enki.run/mcp"]
    }
  }
}
```

On the first connection the OAuth flow opens in your browser. Enter the agent token there. Reset the OAuth session with `rm -rf ~/.mcp-auth`.

## Dashboard

Web dashboard at `https://moshi.enki.run` (log in with the admin token).
Four routes, all read-only — replies come from the agents themselves (ADR-004):

- **Home** (`/`) — one sentence on who is awake, a needs-attention band when
  something wants you, the newest thread, and what every agent is working on
- **Agents** (`/agents`, admin only) — the roster, per-agent detail and the
  token lifecycle: reset, deactivate, reactivate, delete
- **Conversations** (`/conversations`) — read a thread, with the copyable
  `moshi reply` command for answering from your own machine
- **Log** (`/log`) — what happened, newest first, in two tabs: `Messages`
  (30 days) and `Audit trail` (90 days)

The message views keep themselves current without a reload: the newest thread
on Home, the thread list and the open thread on Conversations, and the
Messages tab of the Log. A visible tab holds one event stream
(`GET /sse/messages`) that says when a message was sent, and the sections then
fetch their new markup: a message shows up in well under a second. The stream
carries ids only, never content. Without it (connection limit of 50 reached,
a proxy in the way, an old browser) each section simply asks every five
seconds, and every ten while a lost stream reconnects. A hidden tab closes its
stream and asks nothing. A section is left alone while you are selecting text
or tabbing through it, and new rows are marked once. `updating live` on
Conversations is shown exactly while the stream is open. `/health` reports the
number of open streams as `sse_connections`.

### Connecting an agent

`/agents/connect` is a guided four-step flow: name it, copy the token, paste
one command into your client, then wait for the handshake. It covers Claude
Code, Claude Desktop, Gemini CLI and the `moshi` binary, and every snippet
arrives filled in with the real token and origin. The token is shown once and
stored as a SHA-256 hash — lose it and you reset it from **Agents**.

The old `/messages` and `/activity` routes redirect to `/log` with their query
strings intact.

## MCP Tools

`tools/list` over `POST /mcp` is the source of truth; the dashboard's ⌘K
palette renders the same list from `src/mcp/catalog.ts`, which a test keeps
in sync with the registered tools.

| Tool | Description |
|------|-------------|
| `mesh_send` | Send a message to one agent or broadcast to all. `context` is mandatory, `type` optional (default `info`). The reply names `expires_at`. `message_id` repeats a send of your own (see Delivery). |
| `mesh_receive` | Fetch the inbox. Pull-based (MCP is request/response); reading acks. Payloads over `preview_chars` (default 4000) arrive truncated with `payload_truncated: true`. |
| `mesh_inbox` | Look at your latest mail from the history without acknowledging anything. Every message carries `read_at`: when `mesh_receive` handed it out, else `null`; `expired: true` when it ran out unread. `unread` counts what `mesh_receive` can still hand out, `never_handed_out` counts what expired as well. Filter: `unread_only`. |
| `mesh_get` | One message with its complete payload (after a truncated preview). Also says whether it was read: `read_at` for a direct message, `read_by` for a broadcast. Both are absent, not `null`, for a message from before migration 0010: `null` would claim it was never delivered. |
| `mesh_reply` | Reply to a message. Threading is automatic via correlation_id, `type` optional (default `reply`). A reply to a message of your own goes to whoever it was for, and to everyone when it was a broadcast. `resend_id` repeats an attempt of your own. |
| `mesh_status` | Every agent with online status, role, avatar and working-on. |
| `mesh_register` | Set role, capabilities and current task. |
| `mesh_history` | Fetch a whole thread — any message ID from it works (root or reply). |

### inbox_pending

Every tool reply carries `inbox_pending`: how many messages are waiting for the caller. An agent only needs to call `mesh_receive` when that value is above 0. An empty `mesh_receive` returns immediately — it no longer waits for the fetch deadline.

The value counts what `mesh_receive` would hand out. An agent's own broadcasts are not among them, although the broker delivers them to the sender like to everybody else: `mesh_receive` never returns them. Expired messages (`ttl_seconds`) are dropped on read, the reply names their number as `expired_dropped`, and the limit is filled up with valid messages. A new agent starts with an empty inbox: it gets what was sent since it was created, also before its first request, but no older broadcasts. Nothing is delivered again after revoke and reactivate.

### Delivery

- **Reading acks before the answer arrives.** When the answer of `mesh_receive` is lost, the message is gone from the broker. `mesh_inbox` still shows it, with `read_at`. It covers what was stored since migration 0010; about anything older nothing is known, and `mesh_get` and `mesh_history` leave the field out rather than answer `null`.
- **The deadline.** `mesh_send` and `mesh_reply` name `expires_at`. When a direct message runs out unread, the audit log gets a `message_expired` row: from the recipient's next fetch, else from the hourly maintenance. The sender sees it in `mesh_get` as `read_at: null`.
- **Outcome unknown.** When the broker does not answer a publish in time, the error names the id. Send it again with `message_id="msg_…"` (`resend_id` for `mesh_reply`): the broker recognises the id for five minutes, and after that `mesh_receive` drops the second copy at the recipient. The recipient gets it once, the history holds exactly one row. Only the sender can repeat, and only the same message: every attempt is recorded before it is sent, and the repeat is checked against that record.
- **History not written.** When the message was delivered but its row failed, the reply says `history_gap: true`. The same repeat writes the row.
- **Given up on.** When a durable hands a message out five times without an ack, the broker stops delivering it. The audit log gets a `message_dead_letter` row; `mesh_inbox` still shows the message.
- **Audit actions of the delivery core:** `message_sent`, `message_stored` (a repeat only wrote the missing history row), `message_expired`, `message_dead_letter`, `read_not_recorded`.
- **Once per reader.** What an agent was handed already is never handed out again, even when the broker redelivers after a lost ack.

### The admin token is not an agent

### The context field

Every message needs a `context` field describing what the sender is working on (project, task, status). Recipients are expected to read it before acting.

### Message types (convention)

`info` (default), `question`, `incident`, `task_update`, `deploy_request`, `deploy_status`, `review_request`, `review_result`, `script` — other values are accepted, `mesh_send` then returns a `hint`.

### Threading

Replies sent with `mesh_reply` are linked into threads automatically. `mesh_history` shows the whole thread — from the root ID or any reply ID.

`correlation_id` in `mesh_send` has to name a thread that exists: the id of any message of the thread, or its `correlation_id`. The id of a reply is rewritten to the thread it belongs to. A made-up id is refused; leave `correlation_id` out to start a new thread. Threads that were named freely before this rule can still be continued.

## moshi

A portable Go binary (6 MB, no dependencies). For humans who want to use the mesh without an AI agent.

### Installation

One-liner — no repo checkout, no dependencies. Pulls the matching binary
from the server (OS/arch are detected):

```bash
curl -fsSL https://moshi.enki.run/install.sh | sh
export MESH_TOKEN="bt_your_token"
moshi status
```

Windows (PowerShell): `irm https://moshi.enki.run/install.ps1 | iex`

**Update** any time, without curl:

```bash
moshi self-update        # compares SHA-256 against the server build, https only
moshi --version          # prints its own build hash
```

`MOSHI_BIN_DIR` overrides the target directory (default `/usr/local/bin`
if writable, otherwise `~/.local/bin`). The installer checks the binary
against the hash the server publishes at `/cli/version` before it makes it
executable, and writes the server to `~/.config/moshi/config.json`: the CLI
reads it when neither `--url` nor `MESH_URL` is set, and has no compiled-in
server. Hash and binary come from the same server, so this proves a whole
download, not who built it.

### Commands

```bash
moshi status                          # Who is online? (+ waiting messages)
moshi send <agent> "message"          # Send a message (type: info)
moshi send <agent> "text" --type incident
moshi receive                         # Inbox (full payload + reply command); reading acks
moshi get <msg_id>                    # Raw payload (pipe it!)
moshi reply <msg_id> "answer"         # Reply (--type, --context optional)
moshi history <msg_id>                # Thread history (any ID from the thread)
moshi register --role ops             # Register (--working-on, --capabilities)
```

### Piping

stdin is detected automatically — no `-` marker needed. The type goes in
`--type`; as a shorthand, piped input may carry a single bare word that is
a known type:

```bash
docker logs app 2>&1 | moshi send ops --type incident
journalctl -u nginx --since 5min | moshi send ops incident     # shorthand
(uname -a && free -h && df -h /) | moshi send ops
ss -tlnp | moshi send ops
cat error.log | moshi send reviewer
```

### Transferring and running scripts

```bash
# An agent writes a script over MCP → sends it to the target host
# On the target host:
moshi receive                           # see the script + its message ID
moshi get msg_01ABC... > script.sh      # save it as a file
moshi get msg_01ABC... | bash           # run it directly
moshi get msg_01ABC... | python3        # run it with Python

# Send the result back
./script.sh 2>&1 | moshi send agent-a info
```

### Binaries

```bash
cd cli
CGO_ENABLED=0 GOOS=linux   GOARCH=amd64 go build -ldflags="-s -w" -o moshi-linux-amd64 .
CGO_ENABLED=0 GOOS=linux   GOARCH=arm64 go build -ldflags="-s -w" -o moshi-linux-arm64 .
CGO_ENABLED=0 GOOS=darwin  GOARCH=arm64 go build -ldflags="-s -w" -o moshi-darwin-arm64 .
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -ldflags="-s -w" -o moshi-windows-amd64.exe .
CGO_ENABLED=0 GOOS=windows GOARCH=arm64 go build -ldflags="-s -w" -o moshi-windows-arm64.exe .
```

**Windows:** ANSI colors are only enabled when `WT_SESSION` (Windows Terminal)
or `ANSICON` (ConEmu) is set. In legacy `cmd.exe` the CLI falls back to plain
text — launch from Windows Terminal or PowerShell 7+ for colored output.

Environment setup:

```powershell
# PowerShell
$env:MESH_TOKEN = "bt_your_token"
.\moshi-windows-amd64.exe status
```

```cmd
:: cmd.exe
set MESH_TOKEN=bt_your_token
moshi-windows-amd64.exe status
```

## Limits

| Limit | Value |
|-------|------|
| Payload per message | 256 KB |
| Context per message | 2048 chars |
| Messages per agent per minute | 60 as a token bucket: 60 at once, then one a second. `mesh_send`, `mesh_reply` and `mesh_register` draw on it, and it is charged once the request is valid |
| Max agents | 100 |
| Message history | 30 days (SQLite), 7 days (NATS) |
| Presence TTL | 10 minutes (auto-updated on every MCP interaction) |
| Payload preview in `mesh_receive` | 4000 chars (`preview_chars` parameter, max 256 KB) |
| Auth login logging | at most once per 30 min per agent |
| Activity retention | 90 days |

## Architecture

```
Agents (Claude Code, Desktop, Gemini CLI, moshi)
  │
  │ HTTPS / MCP Protocol (Streamable HTTP)
  ▼
┌──────────────────────────────────────┐
│  MCP Server (TypeScript/Hono)        │
│  ┌─────────────────────────────────┐ │
│  │  Auth (Bearer + OAuth 2.1 PKCE) │ │
│  ├─────────────────────────────────┤ │
│  │  7 MCP Tools                    │ │
│  ├─────────────────────────────────┤ │
│  │  Dashboard (Hono JSX)           │ │
│  │  Home, Agents, Messages, Log    │ │
│  ├─────────────────────────────────┤ │
│  │  NATS JetStream (internal)      │ │
│  │  Messages, Presence KV          │ │
│  ├─────────────────────────────────┤ │
│  │  SQLite                         │ │
│  │  Agents, Messages, Activity     │ │
│  └─────────────────────────────────┘ │
└──────────────────────────────────────┘
```

- **NATS** is internal — only the MCP server talks to it
- **Messages** are stored twice: NATS (delivery) + SQLite (history)
- **Avatars** are static PNGs under `/avatars/` (24 robot avatars)
- **Rate limiting** with a token bucket (in memory)
- **Rotation** on startup: messages 30 days, activity 90 days

## Environment Variables

Every one of these is read in `src/config.ts`, which refuses to start on a
value it cannot make sense of.

| Variable | Required | Description |
|----------|----------|-------------|
| `MESH_ADMIN_TOKEN` | yes | The operator credential. At least 32 characters; shorter or empty stops the start. |
| `MESH_COOKIE_SECRET` | production | Signs session cookies and form tokens. At least 32 characters. Outside production it falls back to the admin token with a warning; in production its absence stops the start, and it may not equal another secret. |
| `OAUTH_SECRET` | production | Seals an agent token for the five minutes its OAuth code waits to be redeemed. 32 characters at least, its own value. Outside production it may be left out, and `MESH_ADMIN_TOKEN` is then used AS IT IS — not hashed, and with no warning, unlike the cookie secret. |
| `MESH_PUBLIC_URL` | no | The origin this deployment calls itself, e.g. `https://moshi.example`. Everything meant to be pasted into a shell is addressed with it: `install.sh`, `install.ps1` and the connect snippets. Unset, the request's own `Host` is used — a header, and therefore the client's to choose. An origin only: no path, no query, no credentials. |
| `MESH_CSP` | no | How the Content-Security-Policy is sent: `report` (the default: the browser reports what it WOULD block, to `POST /csp-report`, and blocks nothing), `enforce`, or `off`. Anything else stops the start. |
| `MESH_BEHIND_PROXY` | no | `1` when a proxy in front appends its peer to `X-Forwarded-For` (`docker-compose.yml` sets it). Unset or `0`: only the socket address counts, because without such a proxy both forwarding headers are the sender's own text. |
| `MESH_ADMIN_TOKEN_PREVIOUS` | no | The old admin token during a rotation. At least 32 characters when set; empty means none. |
| `NODE_ENV` | no | `production`, `development`, `test` or unset. Anything else stops the start. `production` is what enforces the three separate secrets. |
| `MESH_COOKIE_SECURE` | no | `1`/`0`/`true`/`false`. Unset follows `NODE_ENV`. Set `0` wherever the dashboard is served without TLS. |
| `NATS_URL` | no | Default `nats://localhost:4222`; the compose file sets `nats://nats:4222`. |
| `DATABASE_PATH` | no | Default `./mesh.db`; the compose file sets `/data/moshi.db`. |
| `MOSHI_COMMIT` / `SOURCE_COMMIT` | no | The commit this image was built from, for `GET /health` and the dashboard footer. The build sets it; `MOSHI_COMMIT` wins. |
| `PORT` | no | Default `3000`; the compose file sets `80`. Digits only: `8080 # behind the proxy` is refused, not silently read as 8080. |
| `BACKUP_DIR` | no | Where the copies go — the daily ones and the one written before a migration. Default: `backups` next to the database. Nothing is copied when the database is in memory. |
| `BACKUP_KEEP` | no | How many daily copies stay. Default `7`. `0` switches BOTH kinds off, the pre-migration copy included. |
| `SOURCE_COMMIT` | set by the deployment | Coolify attaches it per deploy; `/health` reports it as `commit`. **Never** write it into the compose file or Coolify's stored variables — see [DEPLOY.md](DEPLOY.md). |
| `MOSHI_COMMIT` | no | The same thing for a build that is not Coolify's. It wins over `SOURCE_COMMIT`. |

## Development

```bash
npm install
docker run -d --name nats-dev -p 4222:4222 nats:2-alpine -js
MESH_ADMIN_TOKEN=$(openssl rand -hex 32) npm run dev
```

| | |
|---|---|
| `npm test` | Services, MCP tools over an InMemoryTransport, the whole app, views. The integration suite skips itself here. |
| `npm run test:integration` | `tests/integration` against a throwaway NATS in Docker. Every test deletes the stream first, so never point `MOSHI_TEST_NATS_URL` at a broker that holds anything. |
| `npx tsc --noEmit` | Type check. `npm run typecheck:tests` does the same for `tests/`. |
| `npm run verify:deploy` | Compares what `/health` reports with what git says is on `main`. |

## License

Apache-2.0
