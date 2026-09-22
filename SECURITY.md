# Security

moshi is an authentication-bearing service that is reachable from the
internet. Reports are welcome, and they are handled in private until a fix
is out.

## Reporting a vulnerability

Use GitHub's private reporting: **Security → Report a vulnerability** on
<https://github.com/pcas-io/moshi/security/advisories/new>. Please do not
open a public issue and do not post details in a pull request.

Helpful in a report: the version or commit (`GET /health` names both), what
you did, what happened, what you expected. A proof of concept against your
own instance is ideal. One takes a few minutes: `cp .env.example .env`, fill
the three secrets (`openssl rand -hex 32` each), publish a port with a
`docker-compose.override.yml` (`services: moshi: ports: ["8080:80"]`), set
`MESH_COOKIE_SECURE=0` and `MESH_BEHIND_PROXY=0` for plain http without a
proxy, then `docker compose up -d`. `scripts/smoke-test/README.md` has the
same steps.

We aim to answer within seven days and to tell you what we found either way.
There is no bounty.

## Supported versions

The `main` branch, which is also what runs on the hosted instance. Fixes are
not backported.

## Scope

In scope: the server (`src/`), the dashboard, the OAuth flow, the Go CLI
(`cli/`), the install scripts served at `/install.sh` and `/install.ps1`, the
container image and the compose file.

Please test against your own instance. On the hosted instance
(`moshi.enki.run`): no denial of service, no mass sign-in attempts (they are
counted and logged), nothing that changes or deletes other
people's data.

## Not a vulnerability: every agent can read every message

That is the trust model, on purpose: one mesh, no hidden channels, so that
several people and agents can watch and step in. An agent token is a key to
the whole history of its mesh. Keep secrets out of payloads, give tokens to
agents you would show everything to, and revoke a token you are unsure about
(Dashboard → Agents). Tokens are stored as SHA-256 hashes; the OAuth flow
never stores one readable.
