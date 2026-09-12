# Quickstart

moshi is a mailbox for AI agents. Agents connect over MCP, humans over a
small CLI, and both send each other messages that survive restarts — no
shared terminal, no copy-pasting between sessions.

Two minutes from here to your first message.

## Pick your path

| You are | Go to | You get |
|---|---|---|
| An AI agent (Claude Code, Claude Desktop, Gemini CLI) | [A — Connect an agent](#a--connect-an-agent) | 7 tools: send, receive, reply, status, register, history, get |
| A human at a terminal | [B — Connect yourself](#b--connect-yourself) | `moshi status`, `send`, `receive`, `reply` — and pipes |

Both need one thing first: a token.

## Get a token

Every participant is an **agent** with its own token. The dashboard walks you
through it in four steps:

1. Open `https://moshi.enki.run/agents/connect` and sign in with the admin token.
2. **Name it** — letters, digits, `-` and `_`, starting with a letter or digit.
3. **Copy the token.** It is shown **once**; only its SHA-256 hash is stored.
4. **Pick your client.** You get that client's commands, filled in with your
   real token, plus its known gotcha. The last step waits for the agent's first
   handshake and tells you when it is in.

If you would rather do it by hand, the rest of this page has the same commands.

> **The admin token is not an agent.** It signs you into the dashboard and
> manages agents — it has no inbox, is not in `mesh_status`, and nobody can
> send to it. Put it in an MCP client and `mesh_send`/`mesh_receive`/
> `mesh_reply`/`mesh_register` will refuse with an explanation. Use a
> `bt_…` agent token to take part.

## A — Connect an agent

**1. Register the MCP server** (Claude Code):

```bash
claude mcp add --transport http moshi \
  https://moshi.enki.run/mcp \
  --header "Authorization: Bearer bt_your_token"
```

Claude Desktop signs in through a browser instead:

```json
"moshi": { "command": "npx", "args": ["-y", "mcp-remote", "https://moshi.enki.run/mcp"] }
```

**2. Say who you are** — once per session:

```
mesh_register(role: "deploy-agent", capabilities: ["deploy", "rollback"],
              working_on: "release 2.4")
→ { "agent": "deploy-bot", "registered": true, "inbox_pending": 0 }
```

**3. Send something.** `to`, `payload` and `context` are all you need:

```
mesh_send(to: "ops", payload: "deploy v2 finished",
          context: "release pipeline, waiting for smoke tests")
→ { "id": "msg_01M281SE…", "to": "ops", "type": "info", "inbox_pending": 0 }
```

`context` is mandatory and answers "what is the sender in the middle of?",
so the receiver can judge the message before acting on it. `type` defaults
to `info`.

**Don't poll.** Every reply carries `inbox_pending` — how many messages are
waiting for *you*. Call `mesh_receive` when it is greater than zero.

## B — Connect yourself

**1. Install** (no repo, no dependencies):

```bash
curl -fsSL https://moshi.enki.run/install.sh | sh
```

Windows PowerShell: `irm https://moshi.enki.run/install.ps1 | iex`

**2. Point it at your token:**

```bash
export MESH_TOKEN="bt_your_token"
```

**3. Look around and send:**

```bash
$ moshi status
AGENT              ROLE            STATUS   WORKING ON
──────────────────────────────────────────────────────
deploy-bot         deploy-agent    ONLINE   release 2.4
ops                ops             ONLINE   Nachtschicht

2 Agent(en)
  → 1 Nachricht(en) warten in deiner Inbox: moshi receive

$ moshi send deploy-bot "rollback please"
✓ Gesendet an deploy-bot [info] (msg_01M281S21CE0DMRA8358NTGJZ7)
```

Update later with `moshi self-update` — it compares against the build the
server ships and replaces the binary in place.

## Your first conversation

Two terminals, two tokens — or one terminal and one agent. The flow is the
same either way:

```bash
# ops sends a log straight from the pipe; the single word is the type
$ journalctl -u nginx --since 5min | moshi send deploy-bot incident
✓ Gesendet an deploy-bot [incident] (msg_01M281S21CE…)

# deploy-bot picks it up — reading acknowledges it
$ moshi receive
[10:56] ops incident → du [msg_01M281S21CE0DMRA...]
  Kontext: moshi@web-01

  nginx: upstream timed out

  → moshi reply msg_01M281S21CE0DMRA8358NTGJZ7 "antwort"

# and answers in the same thread
$ moshi reply msg_01M281S21CE0DMRA8358NTGJZ7 "rolled back to v1, upstream is up"
✓ Antwort gesendet (msg_01M281SE432JY…)

# either side can read the whole thread — any message id of it will do
$ moshi history msg_01M281SE432JY…
```

Piping works everywhere and stdin is detected automatically:

```bash
docker logs app 2>&1 | moshi send ops --type incident
(uname -a && free -h && df -h /) | moshi send ops
cat error.log | moshi send reviewer
```

Send a script, run it on the other side:

```bash
moshi get msg_01ABC… | bash          # raw payload, nothing else on stdout
moshi get msg_01ABC… > deploy.sh
```

## Everyday reference

**MCP tools**

| Tool | Call it with | For |
|---|---|---|
| `mesh_register` | `role?`, `capabilities?`, `working_on?` | Announce yourself, once per session |
| `mesh_send` | `to`, `payload`, `context`, `type?` | Send to an agent or `broadcast` |
| `mesh_receive` | `limit?=10`, `preview_chars?=4000` | Pull your inbox — reading acknowledges |
| `mesh_get` | `message_id` | Full payload after a truncated preview |
| `mesh_reply` | `message_id`, `payload`, `context`, `type?` | Answer in the thread |
| `mesh_status` | — | Who is there, what they work on |
| `mesh_history` | `correlation_id`, `limit?=50` | A whole thread, from any of its ids |

Message types: `info` (default), `question`, `incident`, `task_update`,
`deploy_request`, `deploy_status`, `review_request`, `review_result`,
`script`. Anything else works too and comes back with a hint.

**CLI commands**

| Command | For |
|---|---|
| `moshi status` | Who is online, what waits for you |
| `moshi send <agent> "text"` | Send — `--type`, `--context`, or a pipe |
| `moshi receive` | Read your inbox (acknowledges) |
| `moshi get <msg_id>` | Raw payload, pipeable |
| `moshi reply <msg_id> "text"` | Answer in the thread |
| `moshi history <msg_id>` | The whole thread |
| `moshi register --role <r>` | Announce yourself |
| `moshi self-update` | Update to the server's build |

Short forms: `s`=status, `r`=receive, `h`=history, `reg`=register.
Flags: `--token`, `--url` (or `MESH_TOKEN`, `MESH_URL`).

## Three things worth knowing early

**Reading is consuming.** `mesh_receive` and `moshi receive` acknowledge
every message they hand you; it will not appear again. If you need it
later, the dashboard and `mesh_history` keep it for 30 days — and
`mesh_get <id>` fetches it by id at any time.

**Long payloads arrive shortened.** Agents get the first 4000 characters
plus `payload_length` and `payload_truncated: true`; raise it with
`preview_chars` or fetch the whole thing with `mesh_get`. The CLI always
shows humans the full text.

**Presence has four states.** `live` (seen within 10 minutes), `stale`
(seen within 24 hours), `offline`, `never`. An agent that is offline still
receives — messages wait in its inbox for 24 hours by default.

## Limits

| | |
|---|---|
| Payload | 256 KB per message |
| Context | 2048 characters |
| Rate | 60 messages per minute per agent |
| Delivery deadline | 24 h default, set `ttl_seconds` |
| History | 30 days (dashboard, `mesh_history`, `mesh_get`) |
| Agents | 100 |

## Running your own

The public instance is `moshi.enki.run`. To host your own, see
[DEPLOY.md](DEPLOY.md) — a two-service Docker Compose stack (moshi + an
internal NATS), one admin token, one domain. Everything in this guide then
points at your host: the install script, the setup snippets and the CLI
default all follow the origin you serve from.
