import crypto from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import type Database from "better-sqlite3";
import { hashToken, timingSafeEqual, getCookieSecret } from "./auth.js";
import type { AgentService } from "./services/agent.js";
import type { Env, AppVariables } from "./types.js";

// OAuth 2.1 for MCP server
// Uses OAUTH_SECRET (fallback: MESH_ADMIN_TOKEN) for code signing
// PKCE (S256) is REQUIRED per OAuth 2.1
// Multi-user: accepts admin token OR personal agent tokens
// Token store: SQLite-backed (survives container restarts)

const OAUTH_CLIENT_ID = "moshi-mcp-client";
const CODE_EXPIRY_MS = 300_000; // 5 minutes

// RFC 7591 Dynamic Client Registration request schema.
// We accept extra fields via .passthrough() — the spec allows arbitrary
// metadata — but enforce strict limits on the fields we actually use.
const registerClientSchema = z
  .object({
    client_name: z.string().max(256).optional(),
    redirect_uris: z.array(z.string().url()).max(10).optional(),
  })
  .passthrough();

// --- SQLite-backed token store (survives container restarts) ---

export function storeToken(db: Database.Database, code: string, token: string): void {
  const expiresAt = Date.now() + CODE_EXPIRY_MS;
  db.prepare(
    "INSERT OR REPLACE INTO oauth_tokens (code, token, expires_at) VALUES (?, ?, ?)",
  ).run(code, token, expiresAt);
}

export function retrieveToken(db: Database.Database, code: string): string | null {
  const row = db
    .prepare("SELECT token, expires_at FROM oauth_tokens WHERE code = ?")
    .get(code) as { token: string; expires_at: number } | undefined;

  if (!row) return null;

  // Always delete after retrieval (one-time use)
  db.prepare("DELETE FROM oauth_tokens WHERE code = ?").run(code);

  if (Date.now() >= row.expires_at) return null;
  return row.token;
}

export function cleanupExpiredOAuthTokens(db: Database.Database): number {
  const result = db
    .prepare("DELETE FROM oauth_tokens WHERE expires_at < ?")
    .run(Date.now());
  return result.changes;
}

// --- Redirect URI validation ---
// Allowed targets: (1) localhost/loopback — local MCP clients (Claude
// Code/Desktop, mcp-remote); (2) Anthropic's first-party hosted connector
// domains claude.ai / claude.com over HTTPS only. This is a tight host
// allowlist, NOT an open redirect: an authorization code is only ever
// delivered to a local client or to Anthropic's own connector callback.
const HOSTED_REDIRECT_HOSTS = ["claude.ai", "claude.com"];
export function isAllowedRedirectUri(uri: string): boolean {
  try {
    const url = new URL(uri);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const h = url.hostname;
    if (
      h === "localhost" ||
      h === "127.0.0.1" ||
      h === "::1" ||
      h === "[::1]" ||
      h.endsWith(".localhost")
    ) {
      return true;
    }
    // Remote hosted connector: HTTPS only, exact host or subdomain.
    if (url.protocol !== "https:") return false;
    return HOSTED_REDIRECT_HOSTS.some((d) => h === d || h.endsWith("." + d));
  } catch {
    return false;
  }
}

// --- Resolve origin behind reverse proxy (Coolify/Traefik TLS termination) ---
function resolveOrigin(c: { req: { url: string; header: (name: string) => string | undefined } }): string {
  const url = new URL(c.req.url);
  const proto = c.req.header("x-forwarded-proto") ?? url.protocol.replace(":", "");
  return `${proto}://${url.host}`;
}

// --- OAuth secret: prefer OAUTH_SECRET, fall back to MESH_ADMIN_TOKEN ---
function getOAuthSecret(): string {
  return process.env.OAUTH_SECRET || process.env.MESH_ADMIN_TOKEN || "";
}

// --- HMAC signing (Node.js crypto) ---
function hmacSign(data: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(data).digest("hex");
}

// --- Stateless authorization code: timestamp.sig ---
export function generateCode(secret: string): string {
  const timestamp = Date.now().toString();
  const sig = hmacSign(`code:${timestamp}`, secret);
  return `${timestamp}.${sig}`;
}

export function verifyCode(code: string, secret: string): boolean {
  const parts = code.split(".");
  if (parts.length !== 2) return false;
  const [timestamp, sig] = parts;
  const age = Date.now() - parseInt(timestamp, 10);
  if (isNaN(age) || age > CODE_EXPIRY_MS || age < 0) return false;
  const expected = hmacSign(`code:${timestamp}`, secret);
  return timingSafeEqual(sig, expected);
}

// --- HTML escape ---
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// --- Authorize page HTML ---
function authorizePageHTML(params: {
  redirectUri: string;
  state: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  error?: boolean;
}): string {
  const { redirectUri, state, codeChallenge, codeChallengeMethod, error } =
    params;
  const errorBlock = error
    ? '<div class="error">Ungültiger Token</div>'
    : "";
  return `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>moshi — Authorize</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Inter', system-ui, sans-serif; background: #fafafa; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .box { background: #fff; border: 1px solid #e0e0e0; padding: 32px; border-radius: 8px; width: 340px; box-shadow: 0 12px 32px rgba(0,0,0,0.06); }
    h1 { font-family: 'JetBrains Mono', monospace; font-size: 18px; margin-bottom: 8px; }
    p { font-size: 13px; color: #666; margin-bottom: 20px; }
    input { width: 100%; padding: 9px 12px; border: 1px solid #e0e0e0; border-radius: 6px; font-family: 'JetBrains Mono', monospace; font-size: 13px; margin-bottom: 14px; }
    input:focus { outline: none; border-color: #444; }
    button { width: 100%; padding: 9px; background: #111; color: #fff; border: none; border-radius: 6px; font-weight: 600; font-size: 12px; cursor: pointer; }
    button:hover { background: #222; }
    .error { color: #904040; font-size: 12px; background: #fdf5f5; padding: 6px; border-radius: 6px; border: 1px solid #c08080; margin-bottom: 12px; text-align: center; }
  </style>
</head>
<body>
  <div class="box">
    <h1>moshi</h1>
    <p>MCP-Zugriff autorisieren</p>
    ${errorBlock}
    <form method="POST" action="/oauth/authorize">
      <input type="hidden" name="redirect_uri" value="${escapeHtml(redirectUri)}">
      <input type="hidden" name="state" value="${escapeHtml(state)}">
      <input type="hidden" name="code_challenge" value="${escapeHtml(codeChallenge)}">
      <input type="hidden" name="code_challenge_method" value="${escapeHtml(codeChallengeMethod)}">
      <input name="token" type="password" placeholder="Token eingeben..." autofocus autocomplete="current-password">
      <button type="submit">Autorisieren</button>
    </form>
  </div>
</body>
</html>`;
}

// --- Resolve user from token ---
// Returns true if the token is valid (admin or active agent)
function resolveUser(
  token: string,
  agents: AgentService,
  adminToken: string,
  adminTokenPrev: string | undefined,
): boolean {
  const hash = hashToken(token);
  const adminHash = hashToken(adminToken);

  if (timingSafeEqual(hash, adminHash)) return true;
  if (adminTokenPrev && timingSafeEqual(hash, hashToken(adminTokenPrev))) {
    return true;
  }

  const agent = agents.getByTokenHash(hash);
  return agent !== null && agent.is_active === 1;
}

// --- OAuth sub-app ---
type HonoEnv = { Bindings: Env; Variables: AppVariables };

export function createOAuthRoutes(agents: AgentService, db: Database.Database) {
  const oauth = new Hono<HonoEnv>();

  // RFC 8414 — OAuth Authorization Server Metadata
  oauth.get("/.well-known/oauth-authorization-server", (c) => {
    const origin = resolveOrigin(c);
    return c.json({
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
      code_challenge_methods_supported: ["S256"],
    });
  });

  // RFC 9728 — OAuth Protected Resource Metadata. The MCP auth spec
  // requires this so a remote client (hit with a 401 +
  // WWW-Authenticate: Bearer resource_metadata=…) can discover which
  // authorization server protects /mcp. Without it, connectors report
  // the server as unreachable. Served on the bare path and the
  // resource-suffixed variant some clients probe.
  const protectedResource = (c: Parameters<typeof resolveOrigin>[0]) => {
    const origin = resolveOrigin(c);
    return {
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
      bearer_methods_supported: ["header"],
      scopes_supported: [] as string[],
    };
  };
  oauth.get("/.well-known/oauth-protected-resource", (c) =>
    c.json(protectedResource(c)),
  );
  oauth.get("/.well-known/oauth-protected-resource/mcp", (c) =>
    c.json(protectedResource(c)),
  );

  // Dynamic Client Registration (RFC 7591, MCP spec requires this)
  // SECURITY (C6): Validate input with Zod. An unbounded `await c.req.json()`
  // with no schema allowed trivial DoS via oversized payloads
  // (e.g. `{"client_name": "A".repeat(10_000_000)}`).
  // SECURITY: Never return real tokens — client_secret is a placeholder.
  // Users authenticate via the /oauth/authorize form with their personal token.
  oauth.post("/oauth/register", async (c) => {
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json(
        { error: "invalid_request", error_description: "Body must be valid JSON" },
        400,
      );
    }
    const parsed = registerClientSchema.safeParse(rawBody);
    if (!parsed.success) {
      return c.json(
        {
          error: "invalid_request",
          error_description: parsed.error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; "),
        },
        400,
      );
    }
    // Validate every redirect_uri against our localhost-only allowlist.
    for (const uri of parsed.data.redirect_uris ?? []) {
      if (!isAllowedRedirectUri(uri)) {
        return c.json(
          {
            error: "invalid_redirect_uri",
            error_description: `redirect_uri must be localhost/loopback (got: ${uri})`,
          },
          400,
        );
      }
    }
    return c.json(
      {
        client_id: OAUTH_CLIENT_ID,
        client_secret: OAUTH_CLIENT_ID,
        client_name: parsed.data.client_name ?? "MCP Client",
        redirect_uris: parsed.data.redirect_uris ?? [],
      },
      201,
    );
  });

  // Authorization endpoint — shows token-entry form, issues code
  oauth.get("/oauth/authorize", async (c) => {
    const redirectUri = c.req.query("redirect_uri");
    const state = c.req.query("state") ?? "";
    const codeChallenge = c.req.query("code_challenge") ?? "";
    const codeChallengeMethod = c.req.query("code_challenge_method") ?? "";

    if (!redirectUri) {
      return c.text("Missing redirect_uri", 400);
    }

    if (!isAllowedRedirectUri(redirectUri)) {
      return c.json(
        {
          error: "invalid_request",
          error_description: `redirect_uri must be localhost (got: ${redirectUri})`,
        },
        400,
      );
    }

    // OAuth 2.1: PKCE S256 is REQUIRED
    if (!codeChallenge || codeChallengeMethod !== "S256") {
      return c.json(
        {
          error: "invalid_request",
          error_description:
            "PKCE is required. Provide code_challenge with code_challenge_method=S256",
        },
        400,
      );
    }

    return c.html(
      authorizePageHTML({
        redirectUri,
        state,
        codeChallenge,
        codeChallengeMethod,
      }),
    );
  });

  oauth.post("/oauth/authorize", async (c) => {
    const body = await c.req.parseBody();
    const token = body["token"] as string;
    const redirectUri = body["redirect_uri"] as string;
    const state = body["state"] as string;
    const codeChallenge = body["code_challenge"] as string;
    const codeChallengeMethod = body["code_challenge_method"] as string;

    if (!isAllowedRedirectUri(redirectUri)) {
      return c.json(
        {
          error: "invalid_request",
          error_description: `redirect_uri must be localhost (got: ${redirectUri})`,
        },
        400,
      );
    }

    // OAuth 2.1: PKCE S256 is REQUIRED
    if (!codeChallenge || codeChallengeMethod !== "S256") {
      return c.json(
        {
          error: "invalid_request",
          error_description:
            "PKCE is required. Provide code_challenge with code_challenge_method=S256",
        },
        400,
      );
    }

    const adminToken = process.env.MESH_ADMIN_TOKEN ?? "";
    const adminTokenPrev = process.env.MESH_ADMIN_TOKEN_PREVIOUS;

    const valid = resolveUser(token, agents, adminToken, adminTokenPrev);

    if (!valid) {
      return c.html(
        authorizePageHTML({
          redirectUri,
          state,
          codeChallenge,
          codeChallengeMethod,
          error: true,
        }),
        401,
      );
    }

    // Generate authorization code (stateless, HMAC-signed with OAUTH_SECRET)
    const oauthSecret = getOAuthSecret();
    const code = generateCode(oauthSecret);

    // SECURITY: Store token server-side in SQLite (5min TTL), never in the URL.
    // The token exchange retrieves it by code key.
    const fullCode = `${code}:${codeChallenge}`;
    storeToken(db, code, token);

    const url = new URL(redirectUri);
    url.searchParams.set("code", fullCode);
    if (state) url.searchParams.set("state", state);

    return c.redirect(url.toString());
  });

  // Token endpoint — exchanges code for access token
  oauth.post("/oauth/token", async (c) => {
    const contentType = c.req.header("content-type") ?? "";
    let grantType: string;
    let code: string;
    let codeVerifier: string;

    if (contentType.includes("application/json")) {
      const body = await c.req.json();
      grantType = body.grant_type;
      code = body.code;
      codeVerifier = body.code_verifier;
    } else {
      const body = await c.req.parseBody();
      grantType = body["grant_type"] as string;
      code = body["code"] as string;
      codeVerifier = body["code_verifier"] as string;
    }

    if (grantType !== "authorization_code") {
      return c.json({ error: "unsupported_grant_type" }, 400);
    }

    if (!code) {
      return c.json(
        { error: "invalid_grant", error_description: "Missing code" },
        400,
      );
    }

    // Extract code and code_challenge from format: timestamp.sig:challenge
    const colonIdx = code.lastIndexOf(":");
    let actualCode = code;
    let storedChallenge = "";

    if (colonIdx !== -1) {
      actualCode = code.substring(0, colonIdx);
      storedChallenge = code.substring(colonIdx + 1);
    }

    const oauthSecret = getOAuthSecret();

    const valid = verifyCode(actualCode, oauthSecret);
    if (!valid) {
      return c.json(
        {
          error: "invalid_grant",
          error_description: "Invalid or expired code",
        },
        400,
      );
    }

    // OAuth 2.1: PKCE verification is REQUIRED
    if (!storedChallenge || !codeVerifier) {
      return c.json(
        {
          error: "invalid_grant",
          error_description: "PKCE code_verifier is required",
        },
        400,
      );
    }

    // Verify PKCE S256: SHA256(code_verifier) base64url === stored challenge
    const digest = crypto
      .createHash("sha256")
      .update(codeVerifier)
      .digest();
    const computed = digest
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    if (computed !== storedChallenge) {
      return c.json(
        {
          error: "invalid_grant",
          error_description: "PKCE verification failed",
        },
        400,
      );
    }

    // Retrieve the user's token from SQLite store (stored during authorize step)
    // SECURITY: Token is never exposed in URLs — only stored server-side.
    // SECURITY: No fallback — if the token is gone, the exchange fails.
    const storedToken = retrieveToken(db, actualCode);
    if (!storedToken) {
      return c.json(
        {
          error: "invalid_grant",
          error_description:
            "Token exchange failed — authorization may have expired or been consumed. Please re-authorize.",
        },
        400,
      );
    }

    return c.json({
      access_token: storedToken,
      token_type: "Bearer",
      expires_in: 2592000, // 30 days
    });
  });

  return oauth;
}
