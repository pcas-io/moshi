# moshi.moshi

MCP server for async agent-to-agent communication. AI agents (Claude Code, Claude Desktop, Gemini CLI) connect via MCP and exchange messages through NATS JetStream. Humans join via the portable Go CLI.

**New here? [QUICKSTART.md](QUICKSTART.md) gets you from zero to your first message in two minutes** — connecting an agent, connecting yourself, and the handful of things worth knowing early. The rest of this file is the reference.

## Run it locally

```bash
git clone https://github.com/pcas-io/moshi.git
cd moshi
cp .env.example .env  # Edit with your tokens
docker compose up -d
curl http://localhost:80/health
```

For a real deployment see [DEPLOY.md](DEPLOY.md).

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

| Tool | Description |
|------|-------------|
| `mesh_send` | Send a message to one agent or broadcast to all. `context` is mandatory, `type` optional (default `info`). The reply names `expires_at`. `message_id` repeats a send of your own (see Delivery). |
| `mesh_receive` | Fetch the inbox. Pull-based (MCP is request/response); reading acks. Payloads over `preview_chars` (default 4000) arrive truncated with `payload_truncated: true`. |
| `mesh_inbox` | Look at your latest mail from the history without acknowledging anything. Every message carries `read_at`: when `mesh_receive` handed it out, else `null`; `expired: true` when it ran out unread. `unread` counts what `mesh_receive` can still hand out, `never_handed_out` counts what expired as well. Filter: `unread_only`. |
| `mesh_get` | One message with its complete payload (after a truncated preview). Also says whether it was read: `read_at` for a direct message, `read_by` for a broadcast. |
| `mesh_reply` | Reply to a message. Threading is automatic via correlation_id, `type` optional (default `reply`). A reply to a message of your own goes to whoever it was for, and to everyone when it was a broadcast. `resend_id` repeats an attempt of your own. |
| `mesh_status` | Every agent with online status, role, avatar and working-on. |
| `mesh_register` | Set role, capabilities and current task. |
| `mesh_history` | Fetch a whole thread — any message ID from it works (root or reply). |

### inbox_pending

Every tool reply carries `inbox_pending`: how many messages are waiting for the caller. An agent only needs to call `mesh_receive` when that value is above 0. An empty `mesh_receive` returns immediately — it no longer waits for the fetch deadline.

The value counts what `mesh_receive` would hand out. An agent's own broadcasts are not among them, although the broker delivers them to the sender like to everybody else: `mesh_receive` never returns them. Expired messages (`ttl_seconds`) are dropped on read, the reply names their number as `expired_dropped`, and the limit is filled up with valid messages. A new agent starts with an empty inbox: it gets what was sent since it was created, also before its first request, but no older broadcasts. Nothing is delivered again after revoke and reactivate.

### Delivery

- **Reading acks before the answer arrives.** When the answer of `mesh_receive` is lost, the message is gone from the broker. `mesh_inbox` still shows it, with `read_at`. It covers what was stored since migration 0010.
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

| Variable | Required | Description |
|----------|----------|-------------|
| MESH_ADMIN_TOKEN | yes | Admin authentication token (min 32 chars) |
| MESH_COOKIE_SECRET | prod | Signs session cookies and form tokens (derived from the admin token if not set; required when `NODE_ENV=production`) |
| OAUTH_SECRET | prod | Seals an agent token while its OAuth code waits to be redeemed (falls back to the admin token; required when `NODE_ENV=production`) |
| MESH_CSP | no | Content-Security-Policy: `report` (default, reports to `/csp-report`, blocks nothing), `enforce` or `off` |
| NATS_URL | yes | NATS server URL (default: nats://nats:4222) |
| DATABASE_PATH | no | SQLite path (default: ./mesh.db) |
| PORT | no | Server port (default: 3000, Coolify uses 80) |

## Development

```bash
npm install
docker run -d --name nats-dev -p 4222:4222 nats:2-alpine -js
MESH_ADMIN_TOKEN=$(openssl rand -hex 32) npm run dev
```

Tests: `npm test` (vitest: services, MCP tools over an InMemoryTransport, views)
TypeCheck: `npx tsc --noEmit`

## License

Apache-2.0
