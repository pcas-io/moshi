import crypto from "node:crypto";
import { createMiddleware } from "hono/factory";
import { getCookie } from "hono/cookie";
import type { Env, RequestAgent, AppVariables } from "./types";
import type { AgentService } from "./services/agent";
import { inboxKeyOf } from "./services/agent";
import type { ActivityService } from "./services/activity";
import type { PresenceService } from "./services/presence";

// --- Public paths (no auth required) ---
// /install.* + /cli/* are public by design: the served binary contains
// no secrets (the moshi token is supplied by the user at runtime), and a
// frictionless `curl … | sh` one-liner is the whole point.
const PUBLIC_EXACT = new Set(["/health", "/livez", "/login", "/install.sh", "/install.ps1"]);
const PUBLIC_PREFIX = ["/oauth", "/.well-known/", "/cli/"];

function isPublicPath(path: string): boolean {
  if (PUBLIC_EXACT.has(path)) return true;
  return PUBLIC_PREFIX.some((p) => path === p || path.startsWith(p));
}

// --- Token hashing ---
export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// --- Timing-safe string comparison ---
export function timingSafeEqual(a: string, b: string): boolean {
  // Different lengths → always false; pad so crypto.timingSafeEqual doesn't throw
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Still run a dummy comparison to avoid timing side-channels on length
    const dummy = Buffer.alloc(bufA.length);
    crypto.timingSafeEqual(bufA, dummy);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

// --- IP hashing for audit trail ---
export function hashIP(ip: string): string {
  return crypto.createHash("sha256").update(ip).digest("hex").slice(0, 16);
}

// --- HMAC-SHA256 hex helper (sync, using crypto.createHmac) ---
function hmacHex(data: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(data).digest("hex");
}

// --- CSRF tokens (signed nonce:timestamp, 10 min validity) ---
export function generateCsrfToken(secret: string): string {
  const nonce = crypto.randomBytes(8).toString("hex");
  const timestamp = Date.now().toString();
  const payload = `${nonce}:${timestamp}`;
  const mac = hmacHex(payload, secret);
  return `${payload}.${mac}`;
}

export function validateCsrfToken(token: unknown, secret: string): boolean {
  // Form fields arrive as string | File | array | undefined. Anything but a
  // non-empty string is simply not a valid token — it used to be a TypeError
  // and an HTTP 500 on every admin action.
  if (typeof token !== "string" || token.length === 0) return false;
  const lastDot = token.lastIndexOf(".");
  if (lastDot === -1) return false;

  const payload = token.substring(0, lastDot);
  const sig = token.substring(lastDot + 1);

  // Extract timestamp from payload (nonce:timestamp)
  const colonIdx = payload.indexOf(":");
  if (colonIdx === -1) return false;
  const timestamp = payload.substring(colonIdx + 1);
  const age = Date.now() - parseInt(timestamp, 10);
  if (isNaN(age) || age > 600_000 || age < 0) return false; // max 10 min

  const expectedSig = hmacHex(payload, secret);
  return timingSafeEqual(sig, expectedSig);
}

// --- Cookie secret helper ---
let cookieSecretWarned = false;

export function getCookieSecret(
  env: Record<string, string | undefined>,
): string {
  if (env.MESH_COOKIE_SECRET) return env.MESH_COOKIE_SECRET;
  if (!cookieSecretWarned) {
    cookieSecretWarned = true;
    console.warn(
      "[moshi] WARNING: MESH_COOKIE_SECRET not set — deriving cookie secret from MESH_ADMIN_TOKEN. Set a separate secret for production.",
    );
  }
  // Derive a distinct secret from the admin token via SHA-256
  const adminToken = env.MESH_ADMIN_TOKEN ?? "";
  return crypto.createHash("sha256").update(adminToken).digest("hex");
}

// --- Session cookie: agentName:timestamp:hmac ---
export function generateSessionCookie(name: string, secret: string): string {
  const timestamp = Date.now().toString();
  const payload = `${name}:${timestamp}`;
  const mac = hmacHex(payload, secret);
  return `${payload}:${mac}`;
}

export function validateSessionCookie(
  cookie: string,
  secret: string,
): string | null {
  const parts = cookie.split(":");
  if (parts.length !== 3) return null;
  const [name, timestamp, mac] = parts;

  // Max session age: 30 days
  const age = Date.now() - parseInt(timestamp, 10);
  if (isNaN(age) || age > 30 * 24 * 60 * 60 * 1000 || age < 0) return null;

  const payload = `${name}:${timestamp}`;
  const expectedMac = hmacHex(payload, secret);
  return timingSafeEqual(mac, expectedMac) ? name : null;
}

// --- Browser navigation vs. API call ---
// A person opening the dashboard root without a session used to get a raw
// `{"error":"Unauthorized"}` (C1). Only plain browser navigations are sent
// to the login page: GET, an Accept header that wants HTML, and no bearer
// token (a client that presented a token deserves the 401 + discovery
// header). /mcp is never redirected — MCP clients speak JSON.
export function isBrowserNavigation(req: {
  method: string;
  path: string;
  accept: string | undefined;
  authorization: string | undefined;
}): boolean {
  if (req.method !== "GET") return false;
  if (req.path === "/mcp") return false;
  if (req.authorization) return false;
  return /\btext\/html\b/i.test(req.accept ?? "");
}

// Only same-origin relative paths are allowed as post-login targets —
// anything else (absolute URLs, protocol-relative //host, backslashes)
// falls back to the dashboard root to rule out open redirects.
export function safeNextPath(next: string | undefined): string {
  if (!next) return "/";
  if (!next.startsWith("/") || next.startsWith("//") || next.includes("\\")) return "/";
  // Browsers strip tab, CR and LF while parsing a Location header, so
  // "/<TAB>/evil.example" resolves to "//evil.example" — another origin.
  // No legitimate path contains raw control characters or spaces.
  if (/[\u0000-\u0020\u007f]/.test(next)) return "/";
  // Belt and braces: resolve it the way a browser would and keep only what
  // stays on this origin.
  const ORIGIN = "http://same-origin.invalid";
  let url: URL;
  try {
    url = new URL(next, ORIGIN);
  } catch {
    return "/";
  }
  if (url.origin !== ORIGIN) return "/";
  const target = url.pathname + url.search;
  // Every check from here on looks at the normalised value, because that is
  // what goes into the Location header. The parser drops "." and ".."
  // segments (also as %2e), so "/.//evil.example" arrives here as
  // "//evil.example" — a protocol-relative URL, i.e. another host.
  if (target.startsWith("//")) return "/";
  // The sign-in pages are refused in the form the router will match them:
  // it decodes the path first, so "/%6cogout" IS /logout, and landing there
  // signs the operator out again with the very next request. A malformed
  // escape stays as it is — the router cannot decode that either.
  let routed = url.pathname;
  try {
    routed = decodeURI(routed);
  } catch {
    /* keep the raw path */
  }
  if (routed.startsWith("/login") || routed.startsWith("/logout")) return "/";
  return target;
}

// --- Auth middleware ---
type HonoEnv = { Bindings: Env; Variables: AppVariables };

// Track recent logins to avoid flooding the activity log
// Key: agentName, Value: timestamp of last log
const recentLogins = new Map<string, number>();
const LOGIN_LOG_INTERVAL_MS = 30 * 60 * 1000; // Log at most once per 30 minutes per agent

export function authMiddleware(
  agents: AgentService,
  presence: PresenceService,
  activity?: ActivityService,
) {
  return createMiddleware<HonoEnv>(async (c, next) => {
    const path = c.req.path;

    // Public paths — pass through without auth
    if (isPublicPath(path)) {
      return next();
    }

    const adminToken = c.env.MESH_ADMIN_TOKEN;
    const adminTokenPrev = c.env.MESH_ADMIN_TOKEN_PREVIOUS;

    let resolvedName: string | null = null;
    let resolvedInboxKey: string | undefined;
    let resolvedRole: "admin" | "agent" | null = null;

    // --- Bearer token auth ---
    const authHeader = c.req.header("Authorization");
    if (authHeader?.startsWith("Bearer ")) {
      const bearerToken = authHeader.slice(7);
      const hash = hashToken(bearerToken);
      const adminHash = hashToken(adminToken);

      if (timingSafeEqual(hash, adminHash)) {
        resolvedName = "admin";
        resolvedRole = "admin";
      } else if (
        adminTokenPrev &&
        timingSafeEqual(hash, hashToken(adminTokenPrev))
      ) {
        resolvedName = "admin";
        resolvedRole = "admin";
      } else {
        const agent = agents.getByTokenHash(hash);
        if (agent) {
          resolvedName = agent.name;
          resolvedRole = "agent";
          resolvedInboxKey = inboxKeyOf(agent);
        }
      }
    }

    // --- Cookie session fallback ---
    if (!resolvedName) {
      const cookie = getCookie(c, "mesh_session");
      if (cookie) {
        const cookieSecret = getCookieSecret(c.env as unknown as Record<string, string | undefined>);
        const name = validateSessionCookie(cookie, cookieSecret);
        if (name) {
          if (name === "admin") {
            resolvedName = "admin";
            resolvedRole = "admin";
          } else {
            const agent = agents.getByName(name);
            if (agent && agent.is_active) {
              resolvedName = agent.name;
              resolvedRole = "agent";
              resolvedInboxKey = inboxKeyOf(agent);
            }
          }
        }
      }
    }

    // --- Auth resolved ---
    if (resolvedName && resolvedRole) {
      const agentCtx: RequestAgent = {
        name: resolvedName,
        role: resolvedRole,
        ...(resolvedInboxKey ? { inbox_key: resolvedInboxKey } : {}),
      };
      c.set("agent", agentCtx);

      // Log auth event (best-effort, throttled to once per 30 min per agent)
      if (activity) {
        const now = Date.now();
        const lastLog = recentLogins.get(resolvedName) ?? 0;
        if (now - lastLog > LOGIN_LOG_INTERVAL_MS) {
          recentLogins.set(resolvedName, now);
          try {
            activity.logAsync({
              action: "auth_login",
              entity_type: "session",
              entity_id: resolvedName,
              summary: `${resolvedName} authenticated (${resolvedRole})`,
              agent_name: resolvedName,
            });
          } catch {}
        }
      }

      // Single presence write-path: PresenceService.touch updates both
      // SQLite last_seen_at and NATS KV in one call. NATS failures are
      // swallowed inside the service so we never throw here.
      if (resolvedRole === "agent") {
        try {
          await presence.touch(resolvedName);
        } catch {
          // Extremely defensive — presence.touch should never throw, but
          // auth must not fail on a presence bookkeeping glitch.
        }
      }

      return next();
    }

    // --- No valid auth ---
    // Browsers get the login page (with a way back), everything else the
    // JSON 401 below.
    if (
      isBrowserNavigation({
        method: c.req.method,
        path,
        accept: c.req.header("Accept"),
        authorization: authHeader,
      })
    ) {
      const query = new URL(c.req.url).search;
      return c.redirect(`/login?next=${encodeURIComponent(path + query)}`, 302);
    }

    // RFC 9728 / MCP auth spec: point unauthenticated clients at the
    // protected-resource metadata so remote connectors can discover the
    // OAuth flow instead of reporting the server as unreachable.
    const proto = c.req.header("x-forwarded-proto") ?? new URL(c.req.url).protocol.replace(":", "");
    const origin = `${proto}://${new URL(c.req.url).host}`;
    c.header(
      "WWW-Authenticate",
      `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`,
    );
    return c.json({ error: "Unauthorized" }, 401);
  });
}
