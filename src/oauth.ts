import crypto from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import type Database from "better-sqlite3";
import { hashToken, timingSafeEqual, getCookieSecret } from "./auth.js";
import type { AgentService } from "./services/agent.js";
import type { Env, AppVariables } from "./types.js";
import { V2_TOKENS } from "./views/v2/tokens.js";

/** The consent screen is the one page a Claude Desktop user sees during the
 *  connect flow, so it wears the same Daylight surfaces as the dashboard. */
const T = V2_TOKENS;

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
    ? '<div class="error"><span class="dot"></span>Invalid token — check the agent&rsquo;s bearer token.</div>'
    : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>Authorize — moshi.moshi</title>
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%230e8a3e'/%3E%3Ctext x='16' y='23' text-anchor='middle' fill='%23ffffff' font-family='sans-serif' font-size='19' font-weight='800'%3Em%3C/text%3E%3C/svg%3E">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Sora:wght@400;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Sora', system-ui, sans-serif; color: ${T.ink};
      background: radial-gradient(900px 520px at 50% 110%, #eef7ef, transparent 70%), ${T.paper};
      display: flex; align-items: center; justify-content: center; min-height: 100vh;
      padding: 24px; font-size: 15px; line-height: 1.6;
      -webkit-font-smoothing: antialiased;
    }
    .box {
      background: ${T.card}; border: 1px solid ${T.line}; padding: 28px;
      border-radius: ${T.radiusPanel}px; width: 400px; max-width: 100%;
      box-shadow: 0 1px 2px rgba(36,33,29,.04), 0 16px 40px -28px rgba(36,33,29,.3);
    }
    .brand { display: flex; align-items: center; gap: 10px; margin-bottom: 20px; }
    .mark {
      width: 30px; height: 30px; border-radius: 9px; background: ${T.green};
      color: #ffffff; display: flex; align-items: center; justify-content: center;
      font-weight: 700; font-size: 16px;
    }
    .name { font-size: 16px; font-weight: 600; letter-spacing: -0.01em; }
    .name .dot { color: ${T.green}; }
    h1 { font-size: 20px; font-weight: 600; letter-spacing: -0.02em; margin-bottom: 4px; }
    p { font-size: 14px; color: ${T.dim}; margin-bottom: 20px; }
    .label { font-size: 13px; font-weight: 600; margin-bottom: 8px; }
    input[type=password] {
      width: 100%; padding: 13px 15px; background: ${T.paper};
      border: 1px solid ${T.lineStrong}; border-radius: ${T.radiusControl}px; color: ${T.ink};
      font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 14px; margin-bottom: 16px;
    }
    input[type=password]:focus {
      outline: none; border-color: ${T.greenLine};
      box-shadow: 0 0 0 3px rgba(14,138,62,.12);
    }
    input[type=password]::placeholder { color: ${T.faint}; }
    button {
      width: 100%; padding: 13px; background: ${T.green}; color: #ffffff;
      border: none; border-radius: ${T.radiusControl}px; font-family: 'Sora', sans-serif;
      font-weight: 600; font-size: 15px; cursor: pointer;
    }
    button:hover { filter: brightness(0.94); }
    button:focus-visible, input:focus-visible { outline: 2px solid ${T.green}; outline-offset: 2px; }
    .error {
      display: flex; align-items: center; gap: 7px; color: ${T.red};
      font-size: 13px; font-weight: 600; margin-bottom: 12px;
    }
    .error .dot { width: 6px; height: 6px; border-radius: 50%; background: ${T.red}; }
    .hint {
      margin-top: 16px; padding-top: 14px; border-top: 1px solid ${T.lineSoft};
      font-size: 13px; color: ${T.dim};
    }
    .hint code {
      font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 12px;
      background: ${T.subtle}; padding: 1px 6px; border-radius: 5px; color: ${T.body};
    }
  </style>
</head>
<body>
  <div class="box">
    <div class="brand">
      <div class="mark">m</div>
      <div class="name">moshi<span class="dot">.</span>moshi</div>
    </div>
    <h1>Let this client into the mesh</h1>
    <p>Paste the agent's bearer token once. moshi hands the client a short-lived code, never the token.</p>
    ${errorBlock}
    <form method="POST" action="/oauth/authorize">
      <input type="hidden" name="redirect_uri" value="${escapeHtml(redirectUri)}">
      <input type="hidden" name="state" value="${escapeHtml(state)}">
      <input type="hidden" name="code_challenge" value="${escapeHtml(codeChallenge)}">
      <input type="hidden" name="code_challenge_method" value="${escapeHtml(codeChallengeMethod)}">
      <div class="label">Bearer token</div>
      <input name="token" type="password" placeholder="bt_&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;" autofocus autocomplete="current-password">
      <button type="submit">Authorize</button>
    </form>
    <div class="hint">The token is exchanged server-side and never appears in a URL. The code expires in five minutes. An agent token starts with <code>bt_</code> — the admin token will not work here.</div>
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
