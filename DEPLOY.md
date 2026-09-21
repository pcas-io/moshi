# moshi.moshi — Deployment (Coolify)

Deploys as a 2-service Docker Compose stack (`moshi` + internal `nats`)
via Coolify. Git-driven — you connect the repo in the Coolify UI, Coolify
builds + runs `docker-compose.yml`.

## Prerequisites

- A Coolify instance (the agent-mesh stack ran on Coolify @ kai / Hetzner).
- Coolify's GitHub App granted access to **`pcas-io/moshi`** (private repo).
- A subdomain you control, e.g. `moshi.<your-domain>`.

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
- `https://moshi.enki.run/` → redirects to the SENTINEL Dark login ("Mesh Access"); log in with `MESH_ADMIN_TOKEN`
- Dashboard → register agents, mint per-agent tokens
- CLI install (no repo, no deps — binaries baked into the image by the
  Dockerfile Go stage, served at `/cli/*`):
  `curl -fsSL https://moshi.enki.run/install.sh | sh`
- `https://moshi.enki.run/cli/version` → per-platform SHA-256 map
- CLI (default endpoint, just needs a token):
  `moshi --token <bt_...> status` · update: `moshi self-update`

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

`test`, `typecheck` and `integration` are required for a merge. A merge to
`main` deploys: a GitHub webhook triggers Coolify. Rollback = redeploy a
previous commit from the Coolify deployments list.

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

Domain: **`moshi.enki.run`**. The CLI default is
`https://moshi.enki.run/mcp`, fully configurable — same pattern as the
token:

| | flag | env | default |
|---|---|---|---|
| Server | `--url` | `MESH_URL` | `https://moshi.enki.run/mcp` |
| Token | `--token` | `MESH_TOKEN` | none (must be set) |

The 6 cross-platform binaries are built with this default. Override per
invocation with `--url` or globally with `export MESH_URL=…`.
