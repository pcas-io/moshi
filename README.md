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
| `mesh_send` | Nachricht an Agent oder Broadcast senden. `context` ist Pflicht, `type` optional (default `info`). |
| `mesh_receive` | Inbox abholen. Pull-basiert (MCP ist Request/Response); Lesen quittiert. Payloads > `preview_chars` (default 4000) kommen gekuerzt mit `payload_truncated: true`. |
| `mesh_get` | Eine Nachricht mit vollstaendiger Payload (nach gekuerzter Preview). |
| `mesh_reply` | Auf Nachricht antworten. Threading automatisch via correlation_id, `type` optional (default `reply`). |
| `mesh_status` | Alle Agents mit Online-Status, Rolle, Avatar, Working-on. |
| `mesh_register` | Rolle, Capabilities, aktuelle Aufgabe setzen. |
| `mesh_history` | Kompletten Thread abrufen — jede Message-ID des Threads reicht (Root oder Reply). |

### inbox_pending

Jede Tool-Antwort enthaelt `inbox_pending`: wie viele Nachrichten fuer den Aufrufer warten. Agents muessen `mesh_receive` nur noch aufrufen, wenn der Wert > 0 ist. Ein leerer `mesh_receive` antwortet sofort (kein Warten auf den Fetch-Timeout).

### Admin-Token ist kein Agent

Der Admin-Token (`MESH_ADMIN_TOKEN`) ist eine Operator-Identitaet fuer Dashboard und Verwaltung — ohne Inbox, nicht adressierbar, nicht in `mesh_status`. `mesh_send`, `mesh_receive`, `mesh_reply` und `mesh_register` lehnen ihn mit einem Hinweis ab; `mesh_status`, `mesh_history` und `mesh_get` funktionieren read-only. Fuer die Teilnahme am Mesh im Dashboard einen Agent anlegen und dessen `bt_`-Token in die MCP-Config eintragen.

### Context-Feld

Jede Nachricht braucht ein `context`-Feld das beschreibt woran der Sender arbeitet (Projekt, Aufgabe, Status). Empfaenger muessen den Context auswerten bevor sie handeln.

### Message-Typen (Convention)

`info` (default), `question`, `incident`, `task_update`, `deploy_request`, `deploy_status`, `review_request`, `review_result`, `script` — andere Werte werden angenommen, `mesh_send` gibt dann einen `hint` zurueck.

### Threading

Antworten via `mesh_reply` werden automatisch zu Threads verknuepft. `mesh_history` zeigt den kompletten Thread — mit der Root-ID oder einer beliebigen Reply-ID.

## moshi

Portables Go-Binary (6 MB, keine Dependencies). Fuer Menschen die ohne AI-Agent mit dem Mesh interagieren.

### Installation

One-liner — kein Repo-Checkout, keine Dependencies. Lädt das passende
Binary vom Server (OS/Arch werden erkannt):

```bash
curl -fsSL https://moshi.enki.run/install.sh | sh
export MESH_TOKEN="bt_your_token"
moshi status
```

Windows (PowerShell): `irm https://moshi.enki.run/install.ps1 | iex`

**Updaten** jederzeit ohne curl:

```bash
moshi self-update        # vergleicht SHA-256 gegen den Server-Build
moshi --version          # zeigt den eigenen Build-Hash
```

`MOSHI_BIN_DIR` überschreibt das Zielverzeichnis (default `/usr/local/bin`
falls beschreibbar, sonst `~/.local/bin`).

### Befehle

```bash
moshi status                          # Wer ist online? (+ wartende Nachrichten)
moshi send <agent> "nachricht"        # Nachricht senden (Typ: info)
moshi send <agent> "text" --type incident
moshi receive                         # Inbox (volle Payload + Reply-Befehl); Lesen quittiert
moshi get <msg_id>                    # Rohe Payload (pipebar!)
moshi reply <msg_id> "antwort"        # Antworten (--type optional)
moshi history <msg_id>                # Thread-Verlauf (jede ID des Threads)
moshi register --role ops             # Registrieren (--working-on, --capabilities)
```

### Piping

stdin wird automatisch erkannt — kein `-` Marker noetig. Der Typ kommt per
`--type`; als Kurzform darf bei gepipter Eingabe ein einzelnes Wort stehen,
das ein bekannter Typ ist:

```bash
docker logs app 2>&1 | moshi send ops --type incident
journalctl -u nginx --since 5min | moshi send ops incident     # Kurzform
(uname -a && free -h && df -h /) | moshi send ops
ss -tlnp | moshi send ops
cat error.log | moshi send reviewer
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
| Payload-Preview in `mesh_receive` | 4000 Zeichen (Parameter `preview_chars`, max 256 KB) |
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

Tests: `npm test` (vitest — Services, MCP-Tools ueber InMemoryTransport, Views)
TypeCheck: `npx tsc --noEmit`

## License

Apache-2.0
