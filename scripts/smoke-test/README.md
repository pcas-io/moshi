# moshi.moshi — User-Flow Smoke Test

Wiederholbarer End-to-End-Smoke-Test über den vollen Agent-Mesh-User-Flow.
Läuft in <3 Minuten, non-destruktiv gegen lokale Dev-Instance + optionaler
read-only Live-Check gegen `moshi.enki.run`.

**Source of Truth (Design-Spec):** Plexus `entities:ctcv73b5vp78oy6bp3c0`

## Zweck

Beantwortet beim Deployment / Refactor / Code-Review in ~2 Minuten die Frage:
*"Funktioniert moshi.moshi end-to-end noch richtig?"*

Deckt ab:

- **Admin-CRUD** — Login, Agent anlegen, Revoke (deactivate), Reactivate, Reset-Token, Delete
- **MCP Bearer-Flow** — die Tools `mesh_register`, `mesh_status`, `mesh_send`, `mesh_receive`, `mesh_reply`, `mesh_history` + Broadcast-Pfad + Threading (`mesh_get` seit dem Top-5-Review zusaetzlich)
- **`moshi`** — Go-Binary inkl. Pipe-Mode (`echo ... | moshi send`)
- **Dashboard-Views** — Home, Messages, Conversations, Activity (curl + HTML-contains)
- **Revoke-Auth-Guard** — nach `revoke` muss der alte Token ein 401 bekommen
- **Live-Smoke** (optional) — `/health`, `/.well-known/oauth-authorization-server`, 1× `mesh_status` gegen `moshi.enki.run`

**Kein Ersatz für Unit-Tests.** Die 48 Unit-Tests in `tests/` decken Edge-Cases
ab (Rate-Limit, Payload-Size, OAuth PKCE, Message-Serialization). Der Smoke-Test
ist der Happy-Path-Check *über* alle Schichten zusammen.

## Voraussetzungen

- **Docker Compose** läuft lokal (oder `--fresh`-Flag nutzen)
- **Port-Mapping:** Das production-`docker-compose.yml` nutzt `expose: "80"` (kein
  Host-Port-Mapping, weil in Prod Traefik auf kai das macht). Für lokalen Smoke-Test
  brauchst du **eine einmalige `docker-compose.override.yml`** im Repo-Root:

  ```yaml
  # docker-compose.override.yml  (gitignored dev-only override)
  services:
    mesh:
      ports:
        - "8080:80"
  ```

  `docker compose up -d` lädt die `override.yml` automatisch. Danach ist Mesh auf
  `http://localhost:8080` erreichbar.

- **Env-Vars:**
  - `MESH_ADMIN_TOKEN` (**Pflicht**) — Admin-Token aus deiner `.env`
  - `MESH_LIVE_TOKEN` (optional) — Production-Bearer für Phase 6. Leer = Phase 6 wird übersprungen
  - `MESH_URL` (default `http://localhost:8080`)
  - `LIVE_URL` (default `https://moshi.enki.run`)

- **CLI-Tools:** `curl`, `jq`, `openssl`, `python3` (alle auf macOS vorinstalliert)

## Quick-Run

```bash
export MESH_ADMIN_TOKEN=$(grep ^MESH_ADMIN_TOKEN .env | cut -d= -f2)
./scripts/smoke-test/smoke-test.sh
```

Erwartet:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 PASS: 39   FAIL: 0
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Exit 0 bei all-green, Exit 1 bei min. 1 Fail, Exit 2 bei Preflight-Fehler.

## Flags

| Flag | Verhalten |
|---|---|
| *(default)* | Gegen existing local compose, self-cleanup der eigenen `uft-*`-Test-Agents via `trap EXIT` |
| `--fresh` | `docker compose down -v && up -d`, warten auf `/health`, dann Tests. **Destruktiv** — löscht lokale Dev-Daten |
| `--cleanup-stale` | Löscht alle Agents mit Präfix `uft-` (Rescue nach hartem Crash eines vorherigen Runs) |
| `--skip-live` | Überspringt Phase 6. Automatisch gesetzt wenn `MESH_LIVE_TOKEN` leer |

## Phasen-Übersicht

| # | Phase | Steps | Asserts |
|---|---|---|---|
| 0 | Preflight (Health, CSRF, Run-ID) | 0 | 2 |
| 1 | Admin-CRUD (Login, Create, List) | 1–4 | 7 |
| 2 | MCP Bearer-Flow (alle 6 Tools + Broadcast) | 5–13 | 11 |
| 3 | `moshi` Go-Binary | 14–17 | 5 |
| 4 | Dashboard-Visual (Home, Messages, Conv, Activity) | 18–21 | 5 |
| 5 | Lifecycle (Revoke, Reactivate, Reset, Delete) | 22–28 | 7 |
| 6 | Live-Smoke (optional, read-only) | 29–31 | 5 |
| 7 | **OAuth-Browser-Flow (manuell)** | 32–35 | — |

**Gesamt:** 39 Asserts bei lokalem Run (ohne Phase 6).
Mit Live-Smoke: 44.

## Phase 7 — Manueller OAuth-Browser-Flow

Phase 7 wird **nicht automatisch ausgeführt**, weil sie einen Browser braucht.
Abzuarbeiten beim Deployment-Smoke, nach OAuth-Code-Änderungen, oder jährlich.

### Schritt 1 — PKCE Code-Challenge generieren

```bash
VERIFIER=$(openssl rand -base64 32 | tr -d '=/+' | head -c 43)
CHALLENGE=$(printf '%s' "$VERIFIER" | openssl dgst -sha256 -binary | \
  openssl base64 -A | tr -- '+/' '-_' | tr -d '=')
echo "Verifier:  $VERIFIER"
echo "Challenge: $CHALLENGE"
```

### Schritt 2 — Browser öffnen

```
https://moshi.enki.run/oauth/authorize?redirect_uri=http://localhost:8080/cb&code_challenge=<CHALLENGE>&code_challenge_method=S256&state=xyz
```

Ersetze `<CHALLENGE>` durch den generierten Wert. Du siehst das Token-Entry-Formular.
Admin- oder Agent-Token eingeben → submit.

Browser redirected zu `http://localhost:8080/cb?code=...&state=xyz`. Die Seite
existiert nicht (kein Callback-Server läuft lokal) — das ist OK. Kopiere `code`
aus der URL-Leiste.

### Schritt 3 — Token-Exchange

```bash
CODE='<aus der URL kopiert>'
curl -sS -X POST https://moshi.enki.run/oauth/token \
  -H "Content-Type: application/json" \
  -d "{\"grant_type\":\"authorization_code\",\"code\":\"$CODE\",\"code_verifier\":\"$VERIFIER\"}"
```

Erwartet:
```json
{"access_token":"bt_...","token_type":"Bearer","expires_in":2592000}
```

### Schritt 4 — Access-Token verifizieren

```bash
ACCESS_TOKEN='<aus Response>'
curl -sS -X POST https://moshi.enki.run/mcp \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"mesh_status","arguments":{}}}' \
| jq '.result.content[0].text | fromjson'
```

Erwartet: JSON mit `agents`-Liste und `count`.

Wenn das alle 4 Steps erfolgreich sind, funktioniert der komplette OAuth 2.1
PKCE Flow inkl. der Härtung aus Commit `b6ec1e7`.

## Troubleshooting

| Symptom | Ursache | Fix |
|---|---|---|
| `Failed to connect to localhost port 8080` | `docker-compose.override.yml` fehlt | Datei anlegen (siehe oben unter Voraussetzungen) |
| `health endpoint returns 200 (got: 000)` | compose nicht up | `docker compose up -d` + 3s warten |
| `MESH_ADMIN_TOKEN: must be set` | Env-Var nicht exportiert | `export MESH_ADMIN_TOKEN=...` oder `source .env` |
| `alpha token starts with bt_` FAIL | Token-Regex veraltet (falls Token-Format sich änderte) | Regex in `smoke-test.sh` anpassen: `bt_[a-z0-9]{20,}` |
| `alpha id extracted` FAIL | HTML-Struktur der `AgentsPage` hat sich geändert | `extract_agent_id()` in `smoke-test.sh` an neue `src/views/agents.tsx` anpassen |
| `FAIL revoked alpha still has MCP access` | agent-ID Extract broken oder Token-Cache-Bug | `ALPHA_ID` debuggen, sonst `src/services/agent.ts` `clearTokenCache()` prüfen |
| `SKIP moshi binary not found` | Go-Binary für Plattform fehlt | `cd cli && CGO_ENABLED=0 GOOS=$(uname -s \| tr '[:upper:]' '[:lower:]') GOARCH=$(uname -m \| sed 's/x86_64/amd64/') go build -o moshi-...` |
| Zombie-`uft-*`-Agents nach Crash | Vorheriger Run Ctrl-C oder Hard-Fail | `./smoke-test.sh --cleanup-stale` |
| `Port 8080 belegt` | Anderer Service | `MESH_URL=http://localhost:9090 ./smoke-test.sh` (+ override anpassen) |

## Architektur-Notizen

- **Stateless MCP:** Das Script nutzt direkten JSON-RPC-POST an `/mcp` ohne Initialize-Handshake. Der Server läuft in `sessionIdGenerator: undefined` stateless mode (siehe `src/index.tsx:408`).
- **CSRF-Token:** Sind gebunden. Der Token aus `GET /login` passt zum `mesh_login`-Cookie im Cookie-Jar und gilt nur für `POST /login`. Nach dem Login holt das Script einen Token aus `/agents`; der gehört zur Session und gilt für alle Admin-POSTs (8 Stunden).
- **Token-Cache-Invalidation:** `revoke`/`delete` rufen `clearTokenCache()` in `src/services/agent.ts`. Der Smoke-Test verifiziert dass das tatsächlich wirkt (Phase 5 Step 23).
- **Self-Cleanup:** Der `trap EXIT` ruft `/agents/delete` für die Test-Agents egal ob das Script grün oder rot ended. IDs werden nach erfolgreichem Delete geleert, damit der Trap nicht doppelt löscht.

## Referenzen

- **Unit-Tests:** `tests/services/*.test.ts`, `tests/oauth.test.ts`
- **OAuth-Härtung (was Phase 5 Step 23 absichert):** Commit `b6ec1e7`, zugehörige Unit-Tests im Commit `824529c`
- **Conversations-View (Phase 4 Step 20):** Commit `e470e96`
