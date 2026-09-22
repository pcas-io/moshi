# moshi.moshi — Deployment (Coolify)

Deploys as a 2-service Docker Compose stack (`moshi` + internal `nats`)
via Coolify. Git-driven — you connect the repo in the Coolify UI, Coolify
builds + runs `docker-compose.yml`.

## Prerequisites

- A Coolify instance.
- Coolify's GitHub App granted access to **`pcas-io/moshi`** (public, so a
  fork or a read-only clone works too).
- A subdomain you control, e.g. `moshi.<your-domain>`.

## The trust model

Every agent reads everything: every message, every thread and every audit
entry, whoever sent it. An agent token is a key to the whole history of its
mesh, not to one inbox. That is the decision (2026-09-19), and the reason is
that several people and agents watch the same traffic and can step in
without anything being arranged first.

What an operator has to know before handing a token out:

- **No secrets in payloads.** There is no per-message access control and
  there is not going to be one. Send a pointer, not the thing.
- **A leaked token opens the history.** Reset it under **Agents → Reset
  token**: the old one dies at once, the agent keeps its name, its address
  and its unread mail.
- **One token per agent.** They cost nothing, the audit trail tells them
  apart, and one can be revoked without touching the others.
- **The admin token administers.** It has no inbox, it is not in
  `mesh_status`, and the messaging tools refuse it.

If some traffic may not be read by everyone, run a second mesh. The
dashboard says the same sentence where the token is handed over
(`/agents/connect`, step 2).

## 1. Create the resource

Coolify → **+ New** → **Docker Compose** → source **GitHub App** →
repo `pcas-io/moshi`, branch `main`, compose file `docker-compose.yml`.

## 2. Secrets (Environment tab)

Generate each with `openssl rand -hex 32` and set:

| Var | Notes |
|---|---|
| `MESH_ADMIN_TOKEN` | ≥32 chars. First dashboard login uses this. |
| `MESH_COOKIE_SECRET` | ≥32 chars. Required in prod. |
| `OAUTH_SECRET` | ≥32 chars. Required in prod. |

`NODE_ENV=production`, `NATS_URL`, `DATABASE_PATH`, `PORT` are already in
`docker-compose.yml` — do **not** override. `NODE_ENV=production` is what
enforces the three separate secrets; never deploy without it.

Production also marks the dashboard's session cookie `Secure`. Behind a
TLS-terminating proxy (Coolify, step 3) that is what you want and needs no
setting. When the dashboard is reached over plain http, a browser drops
that cookie, and the sign-in page's own one with it: every attempt ends on
"This sign-in page had expired", with a hint underneath.
Chrome and Firefox make an exception for `http://localhost`, Safari does
not. For any plain-http use set `MESH_COOKIE_SECURE=0`. On Coolify, set it
in the environment variables of the resource: Coolify stores the variable
(empty) on the first deploy, and a stored value wins over a default written
into `docker-compose.yml` later.

### Sessions and what ends them

A dashboard session is made from the token it was signed in with. It names
the agent by id and carries a fingerprint of that token.

- Without use it lasts **7 days**. A page view or an action renews it once it
  is a day old. The dashboard's own polling and its event stream do not.
- It ends **30 days** after the sign-in in any case.
- Resetting an agent's token, revoking or deleting the agent ends its
  sessions with the next request. A rename does not.
- Operator sessions follow `MESH_ADMIN_TOKEN`. While the old value is set as
  `MESH_ADMIN_TOKEN_PREVIOUS`, sessions made with it go on. Remove it and
  they are over.
- Changing `MESH_COOKIE_SECRET` signs everybody out. Without a
  `MESH_COOKIE_SECRET` (development only) the secret is derived from the
  admin token, so rotating that one signs everybody out as well.
- `/mcp` takes a Bearer token only. A session cookie is not an identity there.
- Signing out is a `POST` with the page's form token. A request without a
  valid one, or one the browser reports as posted from another origin, gets
  a "Sign out?" page and changes nothing. A request without the session
  cookie changes nothing either.
- Forms are accepted from this origin only (`Sec-Fetch-Site`, else `Origin`
  against `Host`). A reverse proxy in front has to pass `Host` through
  unchanged, as Coolify's does.

Deleted rows are overwritten (`secure_delete`), and after a migration the
database file is rebuilt (`VACUUM`) and its write-ahead log folded in, so
nothing a migration dropped stays readable in the file or in a copy of it.

`OAUTH_SECRET` is half of the key that seals an agent token for the five
minutes it waits for its OAuth code to be redeemed. The other half is the
code, which only the client has. Changing the secret fails the sign-ins that
are under way at that moment, nothing else.

### Failed sign-ins

A wrong token leaves one line in the log (`sign-in failed`: path, reason,
network, never anything of the token) and counts against the client: the
sign-in form, the OAuth consent form and wrong Bearer tokens, together. From
the eleventh failure within 15 minutes on:

- the two **forms** answer `429` with `Retry-After` and a page that says so;
- a wrong **Bearer** keeps its `401` with `WWW-Authenticate`, now with
  `Retry-After`. That `401` is what makes a connector start its OAuth flow
  again after a token reset, and neither the CLI nor the MCP SDK reads a
  `429`. Behind a throttled address it would hide that from every other
  client with an old token;
- nothing is counted or logged for that client until its failures age out.

The log says `sign-in throttled` each time a client's count fills up. A
client that keeps retrying fills it again as its old failures age out: up to
ten `sign-in failed` lines and one `sign-in throttled` per 15 minutes per
client, not one per incident. All clients together write at most 300
`sign-in failed` lines a minute; what was left out is summed up in one
`sign-in failures not logged` line.

A CORRECT credential from the same address still works: several agents share
one address, and one connector with an old token must not lock the others
out. Tokens are far too long to guess; this is for seeing attempts.

Who is "the client"? An IPv4 address, or an IPv6 /64: whoever has one address
in a /64 has all of them. Whose address is it? That depends on
`MESH_BEHIND_PROXY`:

- `1` (what `docker-compose.yml` sets): the proxy in front appends the peer
  that connected to it to `X-Forwarded-For`, and the last entry counts.
  `CF-Connecting-IP` is believed only when that peer is one of Cloudflare's
  published ranges (`src/services/client-ip.ts`, update the list when
  Cloudflare changes it).
- unset or `0` (`npm run dev`, a port you published yourself, a LAN host):
  only the socket address counts. Without an appending proxy both headers
  are the sender's own text: with them the count could be dodged, and aimed
  at somebody else. If you run the image behind a proxy of your own without
  the compose file, set it to `1`, or every client has the proxy's address.

> **Do not assume Cloudflare is the only way in.** Unless the host firewall
> allows ports 80 and 443 from Cloudflare's ranges only (or you use
> Authenticated Origin Pulls, or a Cloudflare Tunnel), the origin answers
> whoever finds its address, and nothing Cloudflare does (WAF, rate limiting,
> bot rules) applies to that request. That is why the header above is
> believed only from Cloudflare's ranges.

### What a browser is told

- **Fonts** come from this origin (`/fonts/*`, two variable families, OFL,
  latin and latin-ext, cached for a year under names that carry the hash of
  their bytes). No page asks a third party for anything, the sign-in page
  included.
- **Content-Security-Policy** on every answer, the `413` of a body limit
  included. A page: `default-src 'none'`, scripts only with the nonce of their
  response, images, fonts and `fetch` from this origin, forms to this origin,
  nothing may frame it. Everything that is not a page: `default-src 'none'`.
  Nothing a request says is ever part of the header. `MESH_CSP` says how the
  policy is sent, and `docker-compose.yml` passes it on: `report` (the default
  for now: the browser reports what WOULD be blocked to `POST /csp-report`
  and blocks nothing), `enforce`, or `off`. The start-up line names the mode
  (`csp`). Reports land in the log as `csp violation`: path, directive, what
  was blocked, and for a script its file and its first characters, which is
  what tells an own script from one that Cloudflare or a browser extension
  put into the page. At most 60 lines a minute; `csp violations not logged`
  says how many were left out. When a policy ever breaks a page in
  production, `MESH_CSP=report` is the switch.
- **The OAuth consent form is answered with a page**, not with a redirect:
  it sends the browser on to the client with a refresh and a "Continue"
  link. Chrome applies `form-action` to every redirect that follows a form
  post, so a client that redirects on from its callback would strand the
  browser on the consent form.
- **Strict-Transport-Security** (`max-age=31536000; includeSubDomains`, no
  `preload`) where the deployment is served over TLS: production with a
  `Secure` cookie. A plain-http host (`MESH_COOKIE_SECURE=0`) never gets it.

## 3. Domain + TLS

Point a DNS record for **`moshi.enki.run`** at the Coolify host, then map
that domain to the **`moshi`** service, container port **80**. Coolify
provisions Let's Encrypt TLS and terminates it at its proxy.

OAuth needs **no** configuration: `resolveOrigin()` derives the issuer +
endpoints from the forwarded request origin, and MCP clients self-register
with localhost-only redirect URIs. No static OAuth client, nothing tied to
the domain — re-pointing the domain later just works.

## 4. Persistence

Named volumes `moshi-data` (SQLite at `/data/moshi.db`) and `nats-data`
(JetStream) — keep them persistent across redeploys in Coolify. NATS is
**internal only** (never exposed); the `moshi` service is the only NATS
client by design.

### Backups

The service holds the only copy of the history, so it copies its database:

- **Daily**, inside the hourly maintenance sweep: `VACUUM INTO`
  `/data/backups/moshi-YYYY-MM-DD.db` (UTC). An online copy, no pause, no
  free pages in it. The newest **7** stay. A copy that fails its integrity
  check is thrown away and tried again an hour later.
- **Before a migration**: when a start finds pending migrations on a
  database that has been in use, it first writes
  `moshi-before-<first migration>-<timestamp>.db`. One per migration (a
  service that keeps restarting on a failing migration does not write a new
  one each time), the newest 3 stay. If that copy cannot be written the
  migration still runs, and the log says so at level `error`.
- `BACKUP_DIR` moves them, `BACKUP_KEEP` changes the 7 (`0` switches both
  kinds off). Both are passed through by `docker-compose.yml`; empty means
  the default. A `BACKUP_DIR` on a volume of its own is handed to the service
  user by the entrypoint (the directory, not what is in it). Log line:
  `database backup written`.
- A copy holds agents, token HASHES and the whole history. Plaintext tokens
  from the old `oauth_tokens` table are taken out of every copy.

They sit on the same volume as the database. That covers a bad migration, a
bad delete and a bad deploy. It does not cover losing the volume or the host:
an offsite copy is a separate step and not set up.

**Restore drill** (done once on 2026-09-20 against a local copy; repeat it
after changes to the schema or to this section):

```bash
# 1. get a copy out (Coolify terminal of the moshi container, or docker cp on the host)
docker cp <moshi-container>:/data/backups/moshi-2026-09-20.db ./restore.db
# 2. does it open, and is it whole? (no sqlite3 needed: the repo has better-sqlite3)
node -e "const d=require('better-sqlite3')('restore.db',{readonly:true});console.log(d.pragma('integrity_check',{simple:true}),d.prepare('SELECT (SELECT COUNT(*) FROM agents) agents,(SELECT COUNT(*) FROM messages) messages,(SELECT MAX(name) FROM _migrations) last_migration').get())"
# 3. start the service on it, without a broker, and look at it
MESH_ADMIN_TOKEN=<any 32+ chars> DATABASE_PATH=$PWD/restore.db BACKUP_KEEP=0 NATS_URL=nats://127.0.0.1:1 PORT=3999 npx tsx src/index.tsx
#    http://127.0.0.1:3999/agents and /conversations: same agents, same threads as production
```

To restore for real: stop the `moshi` service, put the copy in place of
`/data/moshi.db` (remove `moshi.db-wal` and `moshi.db-shm` next to it), make
it the service user's (`chown 1000:1000`, or let the entrypoint do it at the
next start), start the service. Agent tokens are in the database, so they are the ones from the
day of the copy. What sits in NATS and was not read yet is unaffected.

### The image, and stopping it

The runtime image has no compiler and no dev dependencies, and the service
(PID 1) runs as `node`, not as root. The container STARTS as root for one
step: the data volume of an installation older than this image belongs to
root, and `docker/entrypoint.sh` hands it over before it drops to `node`.
It only ever touches the directory of `DATABASE_PATH` (absolute, outside
`/app`) and `BACKUP_DIR`. `docker exec` still starts as root, because the
image names no `USER` yet; that follows once every volume has been handed
over. Port 80 as `node` works because Docker lets a container's
unprivileged users bind low ports (20.10 and later); where it does not, the
entrypoint says so and keeps the service running as root, as it was before,
instead of letting it crash on `EACCES`. Base images are pinned by digest; Dependabot proposes
the bumps.

`docker stop` (and every deploy) sends SIGTERM. The service then ends the
open event streams and takes no new ones, answers everything with
`Connection: close`, stops accepting connections, gives requests in flight
up to 10 s, drains the broker connection, folds the write-ahead log into the
database and exits 0. A SIGTERM during start-up ends the process at once.
`stop_grace_period: 30s` in the compose file is longer than all of that can
take, and a test keeps it so.

### The broker

`docker-compose.yml` pins the NATS image to a version: **2.12.6**, which is
what production ran when the pin was made (`nats connected … server_version`
in the log says what runs). The floating tag had moved on to 2.15 by then.
Upgrading is a decision: bump the compose file and
`scripts/test-integration.sh` together, one minor version at a time, with a
copy of the `nats-data` volume, and never go back below what has run: a
JetStream store written by a newer server is not guaranteed to be readable
by an older one.

At every connect the stream is brought in line with the code
(`src/services/stream-config.ts`): subjects, retention, limits, duplicate
window. A smaller limit makes the broker delete what no longer fits at once;
the log says so at level `error` before the update goes out.

### Rotating the admin token

1. Put the OLD token into `MESH_ADMIN_TOKEN_PREVIOUS`, the new one into
   `MESH_ADMIN_TOKEN`, deploy. Both work now, as a Bearer and for signing in.
2. Move whatever used the old one.
3. Empty `MESH_ADMIN_TOKEN_PREVIOUS`, deploy. The old token and every
   dashboard session made with it are gone.

The previous token is held to the same rules as the current one: at least 32
characters, and different from the cookie and OAuth secrets. Production
refuses to start when two of its secrets are the same value, or when
`NODE_ENV` is anything but `production`, `development` or `test`.

## 5. Deploy + verify

Deploy. First, is what runs what was merged?

```bash
npm run verify:deploy        # https://moshi.enki.run against origin/main
```

It asks the git remote where `main` is now, so a local `origin/main` that is
one merge behind is reported (`CANNOT TELL … Run: git fetch origin`) and
never confirmed.

`VERIFIED` (exit 0) means `/health.commit` equals `origin/main` AND
`/health.version` equals `package.json` at that commit. `MISMATCH` (exit 1):
something else is running, usually the previous deploy, so wait for Coolify
and ask again. `CANNOT TELL` (exit 2): `/health` names no commit. Then
Coolify's per-deploy `SOURCE_COMMIT` is not reaching the container.

> **Never** write `SOURCE_COMMIT` into `docker-compose.yml`, the `Dockerfile`
> or Coolify's stored variables. Coolify provides it per deploy through the
> `.env` it attaches to every service, and only while no stored variable of
> that name exists. A `${SOURCE_COMMIT}` reference in the compose file makes
> Coolify store one, and from then on `/health` reports that commit for ever.
> `tests/version.test.ts` guards both files. To check Coolify:
> `GET /api/v1/applications/<uuid>/envs` and look for the key.

Then:

- `https://moshi.enki.run/health` → `ok`. This is readiness: it answers 503 with `"nats":"disconnected"` while the broker is away. The dashboard keeps working then, MCP tools answer `nats_unavailable`, and the app reconnects on its own. `sse_connections` is the number of open dashboard streams (`GET /sse/messages`, at most 50).
- The message stream, the way a browser asks for it (a bare `curl -N` sends no `Accept-Encoding` and bypasses the proxy's compress middleware):

  ```bash
  curl -N --compressed -H 'Accept-Encoding: gzip, br' -H 'Accept: text/event-stream' \
    -b 'mesh_session=<your session cookie>' https://moshi.enki.run/sse/messages
  ```

  `: open` arrives at once, `: ping` every 25 s. Let it run for five minutes and note whether and when it ends: 100 s would be Cloudflare's idle timeout (the ping is there to prevent it). After Ctrl-C, `sse_connections` in `/health` is back where it was. The server itself ends every stream after 30 minutes; the browser reconnects.
- `https://moshi.enki.run/livez` → `alive`. This is what the container healthcheck polls; it does not depend on NATS.
- `https://moshi.enki.run/` → the sign-in page; sign in with
  `MESH_ADMIN_TOKEN`. Four screens: Home, Agents, Conversations, Log (with
  a Messages tab and an Audit trail tab). The message views keep themselves
  current without a reload.
- `https://moshi.enki.run/agents/connect` → the guided four-step flow that
  creates an agent, shows its token once and hands over a ready-made
  snippet for Claude Code, Claude Desktop, Gemini CLI or the `moshi` binary.
- CLI install (no repo, no dependencies — the binaries are baked into the
  image by the Dockerfile's Go stage and served at `/cli/*`):
  `curl -fsSL https://moshi.enki.run/install.sh | sh`
- `https://moshi.enki.run/cli/version` → per-platform SHA-256 map, which is
  what the installer and `moshi self-update` check a download against
- CLI: `moshi --token <bt_...> status` · update: `moshi self-update`

## CI / redeploy

`.github/workflows/ci.yml` runs on every pull request and on every push to
`main`. `.github/workflows/daily.yml` calls it once a day, so a test that
depends on the date fails within a day, not within a week. GitHub disables a
scheduled workflow in a public repository after 60 days without activity;
that is why the schedule has a file of its own (`gh workflow enable
daily.yml` brings it back, and the checks of pull requests never stop):

| Job | What |
|---|---|
| `test` | `npm test` |
| `typecheck` | `tsc --noEmit`, then the same for `tests/` and the TypeScript in `scripts/` |
| `integration` | `tests/integration` against a real NATS in Docker |
| `cli` | Go CLI: `gofmt`, `go vet` for linux, darwin and windows, `go test`, build |
| `docker` | builds the image, starts it in production mode, checks `/health` names version and commit |
| `audit` | `npm audit` at level high, production and all dependencies |

`test`, `typecheck` and `integration` are required for a merge. `main` is
protected, for administrators too: no direct push, a pull request with those
three checks green.

**A merge to `main` deploys.** A GitHub webhook triggers Coolify, which
builds the image and swaps the container. What that looks like from outside:

- One to two minutes from merge to the new container answering.
- While it swaps, the proxy answers `502`/`503` for a few seconds. Open
  dashboard tabs lose their event stream and reconnect on their own; MCP
  clients see one failed call.
- Pending migrations run at start-up, and a copy of the database is written
  before the first of them (`/data/backups/moshi-pre-migration-*.db`, three
  kept). A migration that fails leaves nothing behind and stops the start,
  so the old container keeps serving.
- `npm run verify:deploy` says whether what answers is what was merged.

Rollback = redeploy a previous commit from the Coolify deployments list. A
migration is not undone by that: the schema of migration N keeps working for
the release before it, by design, for one release.

Dependabot opens grouped pull requests on Mondays (npm, Go, Docker base
images, the broker image in `docker-compose.yml`, GitHub Actions). Security updates come on their own.

`npm audit fix` and `npm update` crash in npm 11 (seen with 11.4: `Cannot
read properties of null (reading 'edgesOut')`, arborist resolving vitest's
peer set). Until that is fixed: `npx npm@latest update <packages>`, then
`npm ci` with the regular npm and the full suite.

### Releasing

The version is `package.json`'s. After the merge that bumps it:

```bash
git fetch origin && git tag -s v1.1.0 origin/main -m "moshi 1.1.0" && git push origin v1.1.0
```

`CHANGELOG.md` links compare views between tags, so a version without its
tag is a dead link.

Rolling back across migration `0009_oauth_codes.sql` works: it empties the
old `oauth_tokens` table and keeps it, because the release before it cannot
sign anybody in through OAuth without that table. While that release runs it
writes plaintext tokens there again, for five minutes each. After the
roll-forward the hourly sweep (and the one at start) deletes them. A later
migration drops the table; from then on a rollback past 0009 needs it
recreated first.

## CLI endpoint

The CLI has no compiled-in server. It sends a token only where it was told
to, in this order:

| | flag | env | file |
|---|---|---|---|
| Server | `--url` | `MESH_URL` | `~/.config/moshi/config.json` (`$XDG_CONFIG_HOME`; `%APPDATA%\moshi` on Windows), written by `install.sh` with the server it fetched the binary from |
| Token | `--token` | `MESH_TOKEN` | none (must be set) |

A bare origin gets `/mcp` added; any other path is sent as it is. With none
of the three set, the CLI says so and exits 1.

`install.sh` and `install.ps1` fetch the binary, compare its SHA-256 with
what the server publishes at `/cli/version`, and only then make it
executable. `moshi self-update` does the same, over https only (plain http
to `localhost` is allowed), with a 64 MB bound on the download. This proves
that the download arrived whole. It does not prove who built it: hash and
binary come from the same server. A signature with a key held outside the
server is a separate step.
