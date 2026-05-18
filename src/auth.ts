import crypto from "node:crypto";
import { createMiddleware } from "hono/factory";
import { getCookie } from "hono/cookie";
import type { Env, RequestAgent, AppVariables } from "./types";
import type { AgentService } from "./services/agent";
import type { ActivityService } from "./services/activity";
import type { PresenceService } from "./services/presence";

// --- Public paths (no auth required) ---
// /install.* + /cli/* are public by design: the served binary contains
// no secrets (the moshi token is supplied by the user at runtime), and a
// frictionless `curl … | sh` one-liner is the whole point.
const PUBLIC_EXACT = new Set(["/health", "/login", "/install.sh", "/install.ps1"]);
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

export function validateCsrfToken(token: string, secret: string): boolean {
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
            }
          }
        }
      }
    }

    // --- Auth resolved ---
    if (resolvedName && resolvedRole) {
      const agentCtx: RequestAgent = { name: resolvedName, role: resolvedRole };
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
