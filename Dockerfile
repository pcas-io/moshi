# ── Stage 1: cross-compile the static Go CLI binaries ──────────────
# Served by the app at /cli/* so users install without a repo checkout.
FROM golang:1.27-alpine AS gobuild
WORKDIR /src/cli
COPY cli/ ./
RUN set -eux; \
    CGO_ENABLED=0 GOOS=linux   GOARCH=amd64 go build -ldflags="-s -w" -o /cli-dist/moshi-linux-amd64 . ; \
    CGO_ENABLED=0 GOOS=linux   GOARCH=arm64 go build -ldflags="-s -w" -o /cli-dist/moshi-linux-arm64 . ; \
    CGO_ENABLED=0 GOOS=darwin  GOARCH=amd64 go build -ldflags="-s -w" -o /cli-dist/moshi-darwin-amd64 . ; \
    CGO_ENABLED=0 GOOS=darwin  GOARCH=arm64 go build -ldflags="-s -w" -o /cli-dist/moshi-darwin-arm64 . ; \
    CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -ldflags="-s -w" -o /cli-dist/moshi-windows-amd64.exe . ; \
    CGO_ENABLED=0 GOOS=windows GOARCH=arm64 go build -ldflags="-s -w" -o /cli-dist/moshi-windows-arm64.exe .

# ── Stage 2: app runtime ───────────────────────────────────────────
FROM node:26-alpine
RUN apk add --no-cache wget python3 make g++
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
# Copy app files (invalidates cache on any code change)
COPY src ./src
COPY migrations ./migrations
COPY public ./public
COPY --from=gobuild /cli-dist ./cli-dist
# The commit of a build outside Coolify (CI: --build-arg MOSHI_COMMIT=<sha>).
# Last on purpose: a new value must not invalidate the layers above.
# On Coolify this stays empty and the app reads the per-deploy SOURCE_COMMIT
# from its environment. Never add SOURCE_COMMIT here or in docker-compose.yml
# (src/version.ts says why).
ARG MOSHI_COMMIT=""
ENV MOSHI_COMMIT=${MOSHI_COMMIT}
EXPOSE 3000
CMD ["npx", "tsx", "src/index.tsx"]
