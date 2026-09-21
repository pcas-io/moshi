# Base images are pinned by digest: a tag can be pushed again, a digest cannot.
# Dependabot (docker ecosystem) proposes the bumps.

# ── Stage 1: cross-compile the static Go CLI binaries ──────────────
# Served by the app at /cli/* so users install without a repo checkout.
FROM golang:1.26-alpine@sha256:51a7c389a5ddaf82f527191a1e9bff9928655130a44e4975dd1d7e0acf59f1ae AS gobuild
WORKDIR /src/cli
COPY cli/ ./
RUN set -eux; \
    CGO_ENABLED=0 GOOS=linux   GOARCH=amd64 go build -ldflags="-s -w" -o /cli-dist/moshi-linux-amd64 . ; \
    CGO_ENABLED=0 GOOS=linux   GOARCH=arm64 go build -ldflags="-s -w" -o /cli-dist/moshi-linux-arm64 . ; \
    CGO_ENABLED=0 GOOS=darwin  GOARCH=amd64 go build -ldflags="-s -w" -o /cli-dist/moshi-darwin-amd64 . ; \
    CGO_ENABLED=0 GOOS=darwin  GOARCH=arm64 go build -ldflags="-s -w" -o /cli-dist/moshi-darwin-arm64 . ; \
    CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -ldflags="-s -w" -o /cli-dist/moshi-windows-amd64.exe . ; \
    CGO_ENABLED=0 GOOS=windows GOARCH=arm64 go build -ldflags="-s -w" -o /cli-dist/moshi-windows-arm64.exe .

# ── Stage 2: production dependencies ───────────────────────────────
# The compiler lives here and only here: better-sqlite3 builds its native
# module when no prebuilt binary fits. Nothing of this stage but node_modules
# reaches the runtime image.
FROM node:22-alpine@sha256:b6f26b36c8ff49624cfdac716b8ea1138d606df02586a77d364bb5536a634f85 AS deps
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# ── Stage 3: runtime ───────────────────────────────────────────────
# No compiler, no dev dependencies, and the service does not run as root.
FROM node:22-alpine@sha256:b6f26b36c8ff49624cfdac716b8ea1138d606df02586a77d364bb5536a634f85
RUN apk add --no-cache su-exec
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package*.json tsconfig.json ./
# Copy app files (invalidates cache on any code change)
COPY src ./src
COPY migrations ./migrations
COPY public ./public
COPY --from=gobuild /cli-dist ./cli-dist
COPY docker/early-signals.mjs ./docker/early-signals.mjs
COPY docker/entrypoint.sh /usr/local/bin/moshi-entrypoint
RUN chmod 0555 /usr/local/bin/moshi-entrypoint && mkdir -p /data && chown node:node /data
# The same default in the entrypoint and in the app. Without it the app fell
# back to ./mesh.db inside a root-owned /app and did not start.
ENV DATABASE_PATH=/data/moshi.db
# The commit of a build outside Coolify (CI: --build-arg MOSHI_COMMIT=<sha>).
# Last on purpose: a new value must not invalidate the layers above.
# On Coolify this stays empty and the app reads the per-deploy SOURCE_COMMIT
# from its environment. Never add SOURCE_COMMIT here or in docker-compose.yml
# (src/version.ts says why).
ARG MOSHI_COMMIT=""
ENV MOSHI_COMMIT=${MOSHI_COMMIT}
EXPOSE 3000
# The entrypoint fixes the data volume's owner and drops to `node`.
ENTRYPOINT ["moshi-entrypoint"]
# One process, PID 1, so SIGTERM reaches the service and its shutdown runs.
# `npx tsx` put two wrappers in between.
CMD ["node", "--import", "./docker/early-signals.mjs", "--import", "tsx", "src/index.tsx"]
