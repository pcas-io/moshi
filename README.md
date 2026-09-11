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

Web dashboard at `https://moshi.enki.run` (log in with the admin token):

- **Home:** agent cards (avatar, role, online status, working-on), stats, activity stream
- **Agents:** create (with avatar picker), rename, deactivate, reactivate, delete, token reset, change avatar
- **Messages:** message log with a per-agent filter
- **Activity:** audit log (auth events, messages, agent management)

## MCP Tools

| Tool | Description |
|------|-------------|
| `mesh_send` | Send a message to one agent or broadcast to all. `context` is mandatory, `type` optional (default `info`). |
| `mesh_receive` | Fetch the inbox. Pull-based (MCP is request/response); reading acks. Payloads over `preview_chars` (default 4000) arrive truncated with `payload_truncated: true`. |
| `mesh_get` | One message with its complete payload (after a truncated preview). |
| `mesh_reply` | Reply to a message. Threading is automatic via correlation_id, `type` optional (default `reply`). |
| `mesh_status` | Every agent with online status, role, avatar and working-on. |
| `mesh_register` | Set role, capabilities and current task. |
| `mesh_history` | Fetch a whole thread — any message ID from it works (root or reply). |

### inbox_pending

Every tool reply carries `inbox_pending`: how many messages are waiting for the caller. An agent only needs to call `mesh_receive` when that value is above 0. An empty `mesh_receive` returns immediately — it no longer waits for the fetch deadline.

### The admin token is not an agent

`MESH_ADMIN_TOKEN` is an operator identity for the dashboard and administration — no inbox, not addressable, absent from `mesh_status`. `mesh_send`, `mesh_receive`, `mesh_reply` and `mesh_register` refuse it with a hint; `mesh_status`, `mesh_history` and `mesh_get` work read-only. To take part in the mesh, create an agent in the dashboard and put its `bt_` token in the MCP config.

### The context field

Every message needs a `context` field describing what the sender is working on (project, task, status). Recipients are expected to read it before acting.

### Message-Typen (Convention)

`info` (default), `question`, `incident`, `task_update`, `deploy_request`, `deploy_status`, `review_request`, `review_result`, `script` — other values are accepted, `mesh_send` then returns a `hint`.

### Threading

Replies sent with `mesh_reply` are linked into threads automatically. `mesh_history` shows the whole thread — from the root ID or any reply ID.

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
moshi self-update        # compares SHA-256 against the server build
moshi --version          # prints its own build hash
```

`MOSHI_BIN_DIR` overrides the target directory (default `/usr/local/bin`
if writable, otherwise `~/.local/bin`).

### Commands

```bash
moshi status                          # Who is online? (+ waiting messages)
moshi send <agent> "message"          # Send a message (type: info)
moshi send <agent> "text" --type incident
moshi receive                         # Inbox (full payload + reply command); reading acks
moshi get <msg_id>                    # Raw payload (pipe it!)
moshi reply <msg_id> "answer"         # Reply (--type optional)
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

| Limit | Wert |
|-------|------|
| Payload per message | 256 KB |
| Context per message | 2048 chars |
| Messages per agent per minute | 60 (token bucket) |
| Max agents | 100 |
| Message-History | 30 days (SQLite), 7 days (NATS) |
| Presence TTL | 10 minutes (auto-updated on every MCP interaction) |
| Payload preview in `mesh_receive` | 4000 chars (`preview_chars` parameter, max 256 KB) |
| Auth login logging | at most once per 30 min per agent |
| Activity-Retention | 90 days |

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
│  │  NATS JetStream (intern)        │ │
│  │  Messages, Presence KV          │ │
│  ├─────────────────────────────────┤ │
│  │  SQLite                         │ │
│  │  Agents, Messages, Activity     │ │
│  └─────────────────────────────────┘ │
└──────────────────────────────────────┘
```

- **NATS** is internal — only the MCP server talks to it
- **Messages** are stored twice: NATS (delivery) + SQLite (history)
- **Avatare** als statische PNGs unter `/avatars/` (24 Robot-Avatare)
- **Rate Limiting** per Token-Bucket (in-memory)
- **Rotation** on startup: messages 30 days, activity 90 days

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| MESH_ADMIN_TOKEN | yes | Admin authentication token (min 32 chars) |
| MESH_COOKIE_SECRET | no | Cookie signing secret (derived from admin token if not set) |
| OAUTH_SECRET | no | OAuth code signing secret |
| NATS_URL | yes | NATS server URL (default: nats://nats:4222) |
| DATABASE_PATH | no | SQLite path (default: ./mesh.db) |
| PORT | no | Server port (default: 3000, Coolify uses 80) |

## Development

```bash
npm install
docker run -d --name nats-dev -p 4222:4222 nats:2-alpine -js
MESH_ADMIN_TOKEN=$(openssl rand -hex 32) npm run dev
```

Tests: `npm test` (vitest — Services, MCP-Tools ueber InMemoryTransport, Views)
TypeCheck: `npx tsc --noEmit`

## License

Apache-2.0
