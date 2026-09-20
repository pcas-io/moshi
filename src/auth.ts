import crypto from "node:crypto";
import { createMiddleware } from "hono/factory";
import { getCookie, setCookie } from "hono/cookie";
import type { Context } from "hono";
import type { Env, RequestAgent, AppVariables, Agent } from "./types";
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

// --- Form tokens (CSRF) ---
// `nonce:timestamp.mac`, and the mac covers a BINDING: the session the page
// was rendered for, or the pre-session cookie of the sign-in page. A token
// used to be good for anybody who held one, in any session; fetching /login
// was enough to mint one.
export const CSRF_LOGIN_MAX_AGE_MS = 10 * 60_000;
/** Inside a session: a working day. The token is useless without the session
 *  it names, so it may outlive a coffee break. */
export const CSRF_SESSION_MAX_AGE_MS = 8 * 60 * 60_000;

const csrfMac = (binding: string, nonce: string, timestamp: string, secret: string): string =>
  hmacHex(JSON.stringify(["csrf", binding, nonce, timestamp]), secret);

export function generateCsrfToken(secret: string, binding: string, now: number = Date.now()): string {
  const nonce = crypto.randomBytes(8).toString("hex");
  const timestamp = now.toString();
  return `${nonce}:${timestamp}.${csrfMac(binding, nonce, timestamp, secret)}`;
}

export function validateCsrfToken(
  token: unknown,
  secret: string,
  binding: string,
  maxAgeMs: number = CSRF_LOGIN_MAX_AGE_MS,
  now: number = Date.now(),
): boolean {
  // Form fields arrive as string | File | array | undefined. Anything but a
  // non-empty string is simply not a valid token — it used to be a TypeError
  // and an HTTP 500 on every admin action.
  if (typeof token !== "string" || token.length === 0) return false;
  // No binding, no token: a route that forgot to say whose form this is
  // fails closed.
  if (!binding) return false;
  const match = /^([0-9a-f]{16}):(\d{1,15})\.([0-9a-f]{64})$/.exec(token);
  if (!match) return false;
  const [, nonce, timestamp, mac] = match;
  const age = now - Number(timestamp);
  if (age > maxAgeMs || age < 0) return false;
  return timingSafeEqual(mac, csrfMac(binding, nonce, timestamp, secret));
}

/**
 * Whether a POST comes from this dashboard's own pages, as far as the browser
 * says. The form token answers "was this form rendered for this session?".
 * It cannot answer "who posted it?" when a sibling host planted the cookie
 * the token is bound to, or when there is no session to bind to. The browser
 * can: `Sec-Fetch-Site` on every modern one (https and localhost), `Origin`
 * on every POST otherwise. A client that sends neither is not a browser and
 * carries no ambient authority.
 */
export function isSameOriginPost(req: { header: (name: string) => string | undefined }): boolean {
  const site = req.header("sec-fetch-site");
  if (site) return site === "same-origin" || site === "none";
  const origin = req.header("origin");
  if (!origin) return true;
  try {
    // Host only: TLS ends at the proxy, so the scheme seen here proves nothing.
    return new URL(origin).host === (req.header("host") ?? "");
  } catch {
    return false; // "null", or not a URL
  }
}

/** Whose form a session's pages carry. Stable while the cookie is renewed. */
export function csrfBindingOf(session: Pick<SessionClaims, "kind" | "id" | "fingerprint">): string {
  return `session:${session.kind}:${session.id}:${session.fingerprint}`;
}

/** The sign-in page's binding: the pre-session cookie. Empty without one. */
export function loginCsrfBinding(nonce: string | undefined): string {
  return nonce ? `login:${nonce}` : "";
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

// --- Session cookie: v2:kind:id:createdAt:issuedAt:fingerprint:mac ---
// The cookie used to be `name:timestamp:mac`, good for 30 days. It named an
// agent by its NAME (a label that can pass to another agent) and it knew
// nothing of the token it was made from: a reset or a rotation left every
// old session standing.
//
// Now it names the agent by id and carries a fingerprint of the token hash.
// Every request compares that with the token the record holds today.
export const SESSION_COOKIE = "mesh_session";
export const LOGIN_COOKIE = "mesh_login";
/** Without use: seven days. */
export const SESSION_IDLE_MS = 7 * 24 * 60 * 60 * 1000;
/** With use: thirty days after the sign-in, which is what it always was. */
export const SESSION_ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1000;
/** A page view renews the cookie once it is this old. */
export const SESSION_RENEW_AFTER_MS = 24 * 60 * 60 * 1000;
export const SESSION_MAX_AGE_SECONDS = SESSION_IDLE_MS / 1000;

export interface SessionClaims {
  kind: "admin" | "agent";
  /** The agent's id; empty for the operator. */
  id: string;
  /** The sign-in. Renewals keep it. */
  createdAt: number;
  /** This cookie. */
  issuedAt: number;
  fingerprint: string;
}

/** Ties a session to a token without putting the token's hash in a cookie. */
export function sessionFingerprint(tokenHash: string, secret: string): string {
  return hmacHex(`session-fingerprint:${tokenHash}`, secret).slice(0, 32);
}

export function sessionCookieAttributes(secure: boolean) {
  return { httpOnly: true, sameSite: "Lax", path: "/", secure } as const;
}

export function generateSessionCookie(
  who: { kind: "admin" | "agent"; id: string; tokenHash: string; createdAt?: number },
  secret: string,
  now: number = Date.now(),
): string {
  const payload = ["v2", who.kind, who.id, who.createdAt ?? now, now, sessionFingerprint(who.tokenHash, secret)].join(":");
  return `${payload}:${hmacHex(payload, secret)}`;
}

/** The claims of a cookie that is genuine and in time, or null. Whether the
 *  fingerprint still matches a token is the caller's question. */
export function readSessionCookie(cookie: string, secret: string, now: number = Date.now()): SessionClaims | null {
  const parts = cookie.split(":");
  if (parts.length !== 7 || parts[0] !== "v2") return null;
  const [, kind, id, created, issued, fingerprint, mac] = parts;
  if (kind !== "admin" && kind !== "agent") return null;
  if (!/^\d{1,15}$/.test(created) || !/^\d{1,15}$/.test(issued)) return null;
  if (!timingSafeEqual(mac, hmacHex(parts.slice(0, 6).join(":"), secret))) return null;

  const createdAt = Number(created);
  const issuedAt = Number(issued);
  if (issuedAt < createdAt || now < issuedAt) return null;
  if (now - issuedAt > SESSION_IDLE_MS || now - createdAt > SESSION_ABSOLUTE_MS) return null;
  return { kind, id, createdAt, issuedAt, fingerprint };
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

/** A browser submitting a form: POST, wants HTML, presents no token. */
export function isBrowserFormPost(req: {
  method: string;
  path: string;
  accept: string | undefined;
  authorization: string | undefined;
}): boolean {
  if (req.method !== "POST") return false;
  if (req.path === "/mcp") return false;
  if (req.authorization) return false;
  return /\btext\/html\b/i.test(req.accept ?? "");
}

/** Path and query of the Referer when it is a page of this host, else "/".
 *  Goes through safeNextPath like every other way back. */
function sameOriginRefererPath(req: { header: (name: string) => string | undefined }): string {
  const referer = req.header("referer");
  if (!referer) return "/";
  try {
    const url = new URL(referer);
    if (url.host !== (req.header("host") ?? "")) return "/";
    return safeNextPath(url.pathname + url.search);
  } catch {
    return "/";
  }
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

export interface AuthOptions {
  /** `Secure` on a renewed session cookie — `config.cookieSecure`, the same
   *  value the sign-in route sets it with. */
  secureCookie?: boolean;
}

export function authMiddleware(
  agents: AgentService,
  presence: PresenceService,
  activity?: ActivityService,
  { secureCookie = false }: AuthOptions = {},
) {
  return createMiddleware<HonoEnv>(async (c, next) => {
    const path = c.req.path;

    // Public paths — pass through without auth
    if (isPublicPath(path)) {
      return next();
    }

    const adminToken = c.env.MESH_ADMIN_TOKEN;
    const adminTokenPrev = c.env.MESH_ADMIN_TOKEN_PREVIOUS;

    const cookieSecret = getCookieSecret(c.env as unknown as Record<string, string | undefined>);

    let who: RequestAgent | null = null;
    // Whose forms this request may submit: the same value for a session and
    // for a Bearer call with the token that session was made from.
    let csrfBinding = "";
    // Set when the request came in on a cookie that is due for renewal.
    let renew: { kind: "admin" | "agent"; id: string; tokenHash: string; createdAt: number } | null = null;

    const OPERATOR: RequestAgent = { name: "admin", role: "admin" };
    const asAgent = (agent: Agent): RequestAgent => ({
      name: agent.name,
      role: "agent",
      inbox_key: inboxKeyOf(agent),
      ...(agent.inbox_since ? { inbox_since: agent.inbox_since } : {}),
    });

    // --- Bearer token auth ---
    const authHeader = c.req.header("Authorization");
    if (authHeader?.startsWith("Bearer ")) {
      const bearerToken = authHeader.slice(7);
      const hash = hashToken(bearerToken);
      const adminHash = hashToken(adminToken);

      if (timingSafeEqual(hash, adminHash) || (adminTokenPrev && timingSafeEqual(hash, hashToken(adminTokenPrev)))) {
        who = OPERATOR;
        csrfBinding = csrfBindingOf({ kind: "admin", id: "", fingerprint: sessionFingerprint(hash, cookieSecret) });
      } else {
        const agent = agents.getByTokenHash(hash);
        if (agent) {
          who = asAgent(agent);
          csrfBinding = csrfBindingOf({ kind: "agent", id: agent.id, fingerprint: sessionFingerprint(hash, cookieSecret) });
        }
      }
    }

    // --- Cookie session fallback ---
    // Not on /mcp. A cookie is what a browser sends along by itself; the MCP
    // endpoint is for clients that present a token on purpose. No client
    // depends on the cookie there, so it is not an identity there.
    if (!who && path !== "/mcp") {
      const cookie = getCookie(c, SESSION_COOKIE);
      const claims = cookie ? readSessionCookie(cookie, cookieSecret) : null;
      if (claims) {
        // The session stands as long as the token it was made from does.
        let tokenHash: string | null = null;
        if (claims.kind === "admin") {
          const candidates = [hashToken(adminToken), ...(adminTokenPrev ? [hashToken(adminTokenPrev)] : [])];
          tokenHash = candidates.find((h) => timingSafeEqual(claims.fingerprint, sessionFingerprint(h, cookieSecret))) ?? null;
          if (tokenHash) who = OPERATOR;
        } else {
          const agent = agents.getById(claims.id);
          if (agent && agent.is_active && timingSafeEqual(claims.fingerprint, sessionFingerprint(agent.token_hash, cookieSecret))) {
            tokenHash = agent.token_hash;
            who = asAgent(agent);
          }
        }
        if (tokenHash) {
          csrfBinding = csrfBindingOf(claims);
          if (Date.now() - claims.issuedAt > SESSION_RENEW_AFTER_MS) {
            renew = { kind: claims.kind, id: claims.id, tokenHash, createdAt: claims.createdAt };
          }
        }
      }
    }

    // --- Auth resolved ---
    if (who) {
      const { name: resolvedName, role: resolvedRole } = who;
      c.set("agent", who);
      c.set("csrfBinding", csrfBinding);

      // What an open tab does by itself: /fragments/* is a tab asking every
      // few seconds whether anything changed, /sse/* is the same tab
      // (re)connecting its stream. Neither is a sign-in, and neither is the
      // agent being around.
      const tabOnItsOwn = path.startsWith("/fragments/") || path.startsWith("/sse/");

      // Seven days, sliding: a real page view or action renews the cookie
      // once it is a day old. A tab polling by itself does not, or a browser
      // left open would stay signed in for the full thirty days.
      if (renew && !tabOnItsOwn) {
        // Never longer than the session has left: thirty days after the
        // sign-in it ends, whatever the browser was told.
        const left = Math.floor((renew.createdAt + SESSION_ABSOLUTE_MS - Date.now()) / 1000);
        setCookie(c, SESSION_COOKIE, generateSessionCookie(renew, cookieSecret), {
          ...sessionCookieAttributes(secureCookie),
          maxAge: Math.max(1, Math.min(SESSION_MAX_AGE_SECONDS, left)),
        });
      }

      // Log auth event (best-effort, throttled to once per 30 min per agent).
      // Not for a poll: an open tab would write one every half hour, for ever.
      if (activity && !tabOnItsOwn) {
        const now = Date.now();
        // Keyed by who it is, not by what it is called: a session outlives a
        // rename, and a new agent under an old name is somebody else.
        const throttleKey = who.role === "admin" ? "admin" : `agent:${who.inbox_key ?? resolvedName}`;
        const lastLog = recentLogins.get(throttleKey) ?? 0;
        if (now - lastLog > LOGIN_LOG_INTERVAL_MS) {
          recentLogins.set(throttleKey, now);
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
      // Not for the dashboard's own polling either: it would keep an agent
      // "live" for as long as somebody leaves a tab open.
      if (resolvedRole === "agent" && !tabOnItsOwn) {
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

    // A form of the dashboard, posted after its session ended. That is what
    // the first click after a deploy looks like on a page that does not poll,
    // and the answer used to be `{"error":"Unauthorized"}` as the whole page.
    // Back to the sign-in page, and from there to the page the form was on.
    if (isBrowserFormPost({ method: c.req.method, path, accept: c.req.header("Accept"), authorization: authHeader })) {
      return c.redirect(`/login?next=${encodeURIComponent(sameOriginRefererPath(c.req))}`, 303);
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

// --- Form tokens for a request that went through the middleware ---
/** A token for the forms of the page being rendered. */
export function issueCsrf(c: Context<HonoEnv>): string {
  const secret = getCookieSecret(c.env as unknown as Record<string, string | undefined>);
  return generateCsrfToken(secret, c.get("csrfBinding") ?? "");
}

/** Whether `token` was issued for the session (or Bearer identity) of `c`,
 *  and the form was posted from this dashboard. */
export function csrfOk(c: Context<HonoEnv>, token: unknown): boolean {
  if (!isSameOriginPost(c.req)) return false;
  const secret = getCookieSecret(c.env as unknown as Record<string, string | undefined>);
  return validateCsrfToken(token, secret, c.get("csrfBinding") ?? "", CSRF_SESSION_MAX_AGE_MS);
}
