// Serves the prebuilt static `moshi` CLI binaries + an install/update
// script, so users get the CLI without checking out the repo:
//
//   curl -fsSL https://moshi.enki.run/install.sh | sh
//
// Binaries are baked into the image by the Dockerfile's Go build stage
// into ./cli-dist. All routes here are public (see auth.ts allowlist) —
// the binary holds no secrets; the moshi token is supplied at runtime.

import type { Hono } from "hono";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { Env, AppVariables } from "../types.js";
import { log } from "./logger.js";

type App = Hono<{ Bindings: Env; Variables: AppVariables }>;

const CLI_DIST = resolve(process.cwd(), "cli-dist");
const ASSET_RE = /^moshi-(linux|darwin|windows)-(amd64|arm64)(\.exe)?$/;

interface Asset {
  bytes: Uint8Array;
  sha256: string;
}

// Lazy, process-lifetime cache (binaries are immutable per image build).
let cache: Map<string, Asset> | null = null;

function load(): Map<string, Asset> {
  if (cache) return cache;
  const m = new Map<string, Asset>();
  if (existsSync(CLI_DIST)) {
    for (const name of readdirSync(CLI_DIST)) {
      if (!ASSET_RE.test(name)) continue;
      const p = resolve(CLI_DIST, name);
      if (!statSync(p).isFile()) continue;
      const bytes = Uint8Array.from(readFileSync(p));
      m.set(name, {
        bytes,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
  } else {
    log("warn", "cli-dist not present — /cli routes will 404 (dev build?)", {
      dir: CLI_DIST,
    });
  }
  cache = m;
  return m;
}

// "moshi-linux-amd64" / "moshi-windows-amd64.exe" → "linux-amd64"
function platformKey(name: string): string {
  return name.replace(/^moshi-/, "").replace(/\.exe$/, "");
}

function origin(c: { req: { header: (n: string) => string | undefined } }): string {
  const proto = c.req.header("x-forwarded-proto") ?? "https";
  const host = c.req.header("host") ?? "moshi.enki.run";
  return `${proto}://${host}`;
}

function installSh(base: string): string {
  return `#!/bin/sh
# moshi.moshi CLI installer.  Re-run any time to update.
#   curl -fsSL ${base}/install.sh | sh
set -eu
BASE="${base}"
os=$(uname -s | tr '[:upper:]' '[:lower:]')
arch=$(uname -m)
case "$os" in
  linux) os=linux ;;
  darwin) os=darwin ;;
  *) echo "moshi: unsupported OS '$os' — see ${base}/cli/" >&2; exit 1 ;;
esac
case "$arch" in
  x86_64|amd64) arch=amd64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) echo "moshi: unsupported arch '$arch'" >&2; exit 1 ;;
esac
asset="moshi-$os-$arch"

dest="\${MOSHI_BIN_DIR:-}"
if [ -z "$dest" ]; then
  if [ -w /usr/local/bin ] 2>/dev/null; then dest=/usr/local/bin
  else dest="$HOME/.local/bin"; fi
fi
mkdir -p "$dest"
tmp=$(mktemp)
echo "↓ $BASE/cli/$asset"
curl -fsSL "$BASE/cli/$asset" -o "$tmp"
chmod +x "$tmp"
mv "$tmp" "$dest/moshi"
echo "✓ installed: $dest/moshi"
case ":$PATH:" in
  *":$dest:"*) ;;
  *) echo "⚠ $dest is not on PATH — add:  export PATH=\\"$dest:\\$PATH\\"" ;;
esac
"$dest/moshi" --version 2>/dev/null || true
echo "Next:  moshi --token <bt_...> status   ·   update later:  moshi self-update"
`;
}

function installPs1(base: string): string {
  return `# moshi.moshi CLI installer (Windows PowerShell). Re-run to update.
#   irm ${base}/install.ps1 | iex
$ErrorActionPreference = "Stop"
$base = "${base}"
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "amd64" }
$asset = "moshi-windows-$arch.exe"
$dest = if ($env:MOSHI_BIN_DIR) { $env:MOSHI_BIN_DIR } else { "$env:LOCALAPPDATA\\Programs\\moshi" }
New-Item -ItemType Directory -Force -Path $dest | Out-Null
$out = Join-Path $dest "moshi.exe"
Write-Host "↓ $base/cli/$asset"
Invoke-WebRequest -Uri "$base/cli/$asset" -OutFile $out
Write-Host "✓ installed: $out"
Write-Host "Add to PATH if needed:  $dest"
& $out --version
`;
}

export function registerCliRoutes(app: App): void {
  // Per-platform hashes — lets `moshi self-update` decide if it's stale.
  app.get("/cli/version", (c) => {
    const platforms: Record<string, string> = {};
    for (const [name, a] of load()) platforms[platformKey(name)] = a.sha256;
    return c.json({ platforms, count: Object.keys(platforms).length });
  });

  app.get("/install.sh", (c) =>
    c.body(installSh(origin(c)), 200, {
      "Content-Type": "text/x-shellscript; charset=utf-8",
      "Cache-Control": "no-cache",
    }),
  );

  app.get("/install.ps1", (c) =>
    c.body(installPs1(origin(c)), 200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache",
    }),
  );

  app.get("/cli/:file", (c) => {
    const file = c.req.param("file");
    if (!ASSET_RE.test(file)) {
      return c.json({ error: "not_found" }, 404);
    }
    const asset = load().get(file);
    if (!asset) {
      return c.json(
        { error: "not_found", hint: "see /cli/version for available builds" },
        404,
      );
    }
    return new Response(asset.bytes, {
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${file}"`,
        "Content-Length": String(asset.bytes.length),
        "X-Moshi-Sha256": asset.sha256,
        "Cache-Control": "no-cache",
      },
    });
  });
}
