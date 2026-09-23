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

let cliDist = resolve(process.cwd(), "cli-dist");

/** Tests point this at a directory of their own. Empties the cache. */
export function __setCliDistForTest(dir: string | null): void {
  cliDist = dir ?? resolve(process.cwd(), "cli-dist");
  cache = null;
}
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
  if (existsSync(cliDist)) {
    for (const name of readdirSync(cliDist)) {
      if (!ASSET_RE.test(name)) continue;
      const p = resolve(cliDist, name);
      if (!statSync(p).isFile()) continue;
      const bytes = Uint8Array.from(readFileSync(p));
      m.set(name, {
        bytes,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
  } else {
    log("warn", "cli-dist not present — /cli routes will 404 (dev build?)", {
      dir: cliDist,
    });
  }
  cache = m;
  return m;
}

// "moshi-linux-amd64" / "moshi-windows-amd64.exe" → "linux-amd64"
function platformKey(name: string): string {
  return name.replace(/^moshi-/, "").replace(/\.exe$/, "");
}

/** The fallback when neither MESH_PUBLIC_URL nor a usable Host says
 *  otherwise. `DEFAULT_LOGIN_HOST` in views/login.tsx is the same value. */
export const DEFAULT_ORIGIN = "https://moshi.enki.run";

/** A host is a name or an address, optionally with a port, and nothing else.
 *  Everything this value reaches is a document someone pastes into a shell. */
const HOST_RULE = /^(?:[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/;

/**
 * Public origin of this deployment as seen by the client.
 *
 * In order: MESH_PUBLIC_URL, which the operator sets and nobody else can
 * reach; then the request's own scheme and Host; then DEFAULT_ORIGIN.
 *
 * "The request's own scheme" is `x-forwarded-proto` where a proxy set it,
 * else the scheme this process was actually spoken to. It used to fall back
 * to https unconditionally, so an instance served over plain http — which
 * QUICKSTART now names as a way to run moshi — handed out an install.sh that
 * fetched from https://127.0.0.1:8080 and died on TLS.
 *
 * Both headers are VALIDATED, because this value is interpolated into the
 * install scripts and into the setup snippets. `x-forwarded-proto` is free
 * text that any proxy may append to, and a value of
 * `http"; touch /tmp/x; :; x="` produced a `BASE=` line in install.sh that
 * ran that command when the served script was run the way the docs say to.
 * Anything but a bare `http` or `https`, and anything but a plain host, is
 * discarded rather than repaired.
 */
export function requestOrigin(c: {
  req: { header: (n: string) => string | undefined; url?: string };
  env?: { MESH_PUBLIC_URL?: string };
}): string {
  const configured = c.env?.MESH_PUBLIC_URL;
  if (configured) return configured;
  const host = c.req.header("host");
  if (!host || host.length > 255 || !HOST_RULE.test(host)) return DEFAULT_ORIGIN;
  return `${requestProto(c)}://${host}`;
}

function requestProto(c: { req: { header: (n: string) => string | undefined; url?: string } }): "http" | "https" {
  const forwarded = c.req.header("x-forwarded-proto");
  if (forwarded === "http" || forwarded === "https") return forwarded;
  if (forwarded !== undefined) return "https"; // anything else: not a scheme
  try {
    return c.req.url && new URL(c.req.url).protocol === "http:" ? "http" : "https";
  } catch {
    return "https";
  }
}

function installSh(base: string): string {
  return `#!/bin/sh
# moshi.moshi CLI installer.  Re-run any time to update.
#   curl -fsSL ${base}/install.sh | sh
#
# The binary is checked against the SHA-256 the server publishes at
# /cli/version before it is made executable, and the server is remembered in
# $XDG_CONFIG_HOME/moshi/config.json (~/.config/moshi/config.json), so that
# the CLI needs no MESH_URL. Hash and binary come from the same server: this
# proves the download arrived whole, not who built it.
set -eu
# Single quotes: this value comes from a request header unless the operator
# set MESH_PUBLIC_URL. requestOrigin already refuses everything that is not a
# scheme and a bare host, and a quote cannot survive both.
BASE='${base}'
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

# The hash the server publishes for this platform: 64 hex characters after the key.
want=$(curl -fsSL "$BASE/cli/version" | tr -d ' \\n' | sed -n "s/.*\\"$os-$arch\\":\\"\\([0-9a-f]\\{64\\}\\)\\".*/\\1/p")
if [ -z "$want" ]; then
  echo "moshi: the server has no build for $os-$arch (see $BASE/cli/version)" >&2; exit 1
fi

tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
echo "↓ $BASE/cli/$asset"
curl -fsSL --max-filesize 67108864 "$BASE/cli/$asset" -o "$tmp"
if command -v sha256sum >/dev/null 2>&1; then got=$(sha256sum "$tmp" | cut -d' ' -f1)
else got=$(shasum -a 256 "$tmp" | cut -d' ' -f1); fi
if [ "$got" != "$want" ]; then
  echo "moshi: integrity check failed — the downloaded binary does not match the hash the server published. Nothing was installed." >&2
  exit 1
fi

mkdir -p "$dest"
chmod +x "$tmp"
mv "$tmp" "$dest/moshi"
trap - EXIT
echo "✓ installed: $dest/moshi (sha256 $(echo "$got" | cut -c1-12))"

# Remember the server. The CLI reads it when neither --url nor MESH_URL is set.
cfgdir="\${XDG_CONFIG_HOME:-$HOME/.config}/moshi"
mkdir -p "$cfgdir"
printf '{"url":"%s"}\n' "$BASE" > "$cfgdir/config.json"
echo "✓ server remembered in $cfgdir/config.json"

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
# The binary is checked against the SHA-256 the server publishes at
# /cli/version, and the server is remembered in %APPDATA%\\moshi\\config.json.
$ErrorActionPreference = "Stop"
$base = '${base}'
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "amd64" }
$key = "windows-$arch"
$asset = "moshi-windows-$arch.exe"
$dest = if ($env:MOSHI_BIN_DIR) { $env:MOSHI_BIN_DIR } else { "$env:LOCALAPPDATA\\Programs\\moshi" }
$version = Invoke-RestMethod -Uri "$base/cli/version"
$want = $version.platforms.$key
if (-not $want) { throw "moshi: the server has no build for $key (see $base/cli/version)" }
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("moshi-" + [System.IO.Path]::GetRandomFileName() + ".exe")
Write-Host "↓ $base/cli/$asset"
Invoke-WebRequest -Uri "$base/cli/$asset" -OutFile $tmp
$got = (Get-FileHash -Algorithm SHA256 $tmp).Hash.ToLower()
if ($got -ne $want) {
  Remove-Item $tmp -Force
  throw "moshi: integrity check failed - the downloaded binary does not match the hash the server published. Nothing was installed."
}
New-Item -ItemType Directory -Force -Path $dest | Out-Null
$out = Join-Path $dest "moshi.exe"
Move-Item -Force $tmp $out
Write-Host "✓ installed: $out (sha256 $($got.Substring(0, 12)))"
$cfgdir = Join-Path $env:APPDATA "moshi"
New-Item -ItemType Directory -Force -Path $cfgdir | Out-Null
Set-Content -Path (Join-Path $cfgdir "config.json") -Value ('{"url":"' + $base + '"}')
Write-Host "✓ server remembered in $cfgdir\\config.json"
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
    c.body(installSh(requestOrigin(c)), 200, {
      "Content-Type": "text/x-shellscript; charset=utf-8",
      "Cache-Control": "no-cache",
    }),
  );

  app.get("/install.ps1", (c) =>
    c.body(installPs1(requestOrigin(c)), 200, {
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
