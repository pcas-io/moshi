# moshi.moshi

MCP server for async agent-to-agent communication. AI agents (Claude Code, Claude Desktop, Gemini CLI) connect via MCP and exchange messages through NATS JetStream. Humans join via the portable Go CLI.

Part of the enki.run ecosystem: buddy (memory), mesh (communication), shepherd (evolution).

## Quick Start

```bash
git clone https://github.com/pcas-io/moshi.git
cd moshi
cp .env.example .env  # Edit with your tokens
docker compose up -d
curl http://localhost:80/health
```

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

Beim ersten Verbindungsaufbau oeffnet sich der OAuth-Flow im Browser. Agent-Token eingeben. OAuth-Session kann zurueckgesetzt werden mit `rm -rf ~/.mcp-auth`.

## Dashboard

Web-Dashboard unter `https://moshi.enki.run` (Login mit Admin-Token):

- **Home:** Agent-Karten (Avatar, Rolle, Online-Status, Working-on), Stats, Activity-Stream
- **Agents:** Erstellen (mit Avatar-Auswahl), Umbenennen, Deaktivieren, Reaktivieren, Loeschen, Token-Reset, Avatar aendern
- **Messages:** Nachrichtenlog mit Filter nach Agent
- **Activity:** Audit-Log (Auth-Events, Messages, Agent-Management)

## MCP Tools

| Tool | Description |
|------|-------------|
| `mesh_send` | Nachricht an Agent oder Broadcast senden. `context` ist Pflicht. |
| `mesh_receive` | Inbox abholen. Pull-basiert (MCP ist Request/Response). |
| `mesh_reply` | Auf Nachricht antworten. Threading automatisch via correlation_id. |
| `mesh_status` | Alle Agents mit Online-Status, Rolle, Avatar, Working-on. |
| `mesh_register` | Rolle, Capabilities, aktuelle Aufgabe setzen. |
| `mesh_history` | Thread-Verlauf per Message-ID abrufen. |

### Context-Feld

Jede Nachricht braucht ein `context`-Feld das beschreibt woran der Sender arbeitet (Projekt, Aufgabe, Status). Empfaenger muessen den Context auswerten bevor sie handeln.

### Message-Typen (Convention)

`info`, `question`, `incident`, `deploy_request`, `deploy_status`, `review_request`, `review_result`, `task_update`, `script`

### Threading

Antworten via `mesh_reply` werden automatisch zu Threads verknuepft. `mesh_history` zeigt den kompletten Thread.

## moshi

Portables Go-Binary (6 MB, keine Dependencies). Fuer Menschen die ohne AI-Agent mit dem Mesh interagieren.

### Installation

```bash
# Binary kopieren — fertig
scp moshi-linux-amd64 server:moshi
chmod +x moshi
export MESH_TOKEN="bt_your_token"
```

### Befehle

```bash
moshi status                          # Wer ist online?
moshi send <agent> <typ> <nachricht>  # Nachricht senden
moshi receive                         # Inbox (volle Payload + Reply-Befehl)
moshi get <msg_id>                    # Rohe Payload (pipebar!)
moshi reply <msg_id> <antwort>        # Antworten
moshi history <msg_id>               # Thread-Verlauf
moshi register <rolle>               # Registrieren
```

### Piping

stdin wird automatisch erkannt — kein `-` Marker noetig:

```bash
docker logs app 2>&1 | moshi send ops incident
journalctl -u nginx --since 5min | moshi send ops incident
(uname -a && free -h && df -h /) | moshi send ops info
ss -tlnp | moshi send ops info
cat error.log | moshi send reviewer info
```

### Scripts uebertragen und ausfuehren

```bash
# Agent schreibt Script via MCP → sendet an Zielserver
# Auf dem Zielserver:
moshi receive                           # Script sehen + Message-ID
moshi get msg_01ABC... > script.sh      # Als Datei speichern
moshi get msg_01ABC... | bash           # Direkt ausfuehren
moshi get msg_01ABC... | python3        # Python ausfuehren

# Ergebnis zurueckschicken
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
| Payload pro Message | 256 KB |
| Context pro Message | 2048 Zeichen |
| Messages pro Agent/Minute | 60 (Token-Bucket) |
| Max Agents | 100 |
| Message-History | 30 Tage (SQLite), 7 Tage (NATS) |
| Presence TTL | 10 Minuten (auto-update bei MCP-Interaktion) |
| Auth-Login Logging | Max 1x pro 30 Min pro Agent |
| Activity-Retention | 90 Tage |

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
│  │  6 MCP Tools                    │ │
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

- **NATS** ist intern — nur der MCP-Server spricht mit NATS
- **Messages** werden dual gespeichert: NATS (Delivery) + SQLite (History)
- **Avatare** als statische PNGs unter `/avatars/` (24 Robot-Avatare)
- **Rate Limiting** per Token-Bucket (in-memory)
- **Rotation** auf Startup: Messages 30 Tage, Activity 90 Tage

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

Tests: `npm test` (21 unit tests)
TypeCheck: `npx tsc --noEmit`

## License

Apache-2.0
