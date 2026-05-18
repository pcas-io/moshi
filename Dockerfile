# ── Stage 1: cross-compile the static Go CLI binaries ──────────────
# Served by the app at /cli/* so users install without a repo checkout.
FROM golang:1.26-alpine AS gobuild
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
FROM node:22-alpine
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
EXPOSE 3000
CMD ["npx", "tsx", "src/index.tsx"]
