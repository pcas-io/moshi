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

## 3. Domain + TLS

Map the domain to the **`moshi`** service, container port **80**. Coolify
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

Deploy. Expected:

- `https://<domain>/health` → `ok`
- `https://<domain>/` → Soft Pastel login; log in with `MESH_ADMIN_TOKEN`
- Dashboard → register agents, mint per-agent tokens
- CLI: `moshi --url https://<domain>/mcp --token <bt_...> status`
  (or `export MESH_URL=https://<domain>/mcp`)

## CI / redeploy

`.github/workflows/ci.yml` runs `npm test` + `tsc --noEmit` on every push
to `main`. Enable Coolify's auto-deploy webhook for push-to-deploy.
Rollback = redeploy a previous commit from the Coolify deployments list.

## ⚠ Open decision — CLI default URL

`cli/main.go` `defaultURL` still points at `https://mesh.enki.run/mcp`
(the **old agent-mesh** deployment). Once moshi has its own domain, decide:
update `defaultURL` to the new domain and rebuild the 6 binaries, or keep
`--url`/`MESH_URL` mandatory. Not changed yet — no domain picked.
