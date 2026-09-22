// Centralized configuration loading + validation.
//
// Closes code-review findings C2 and C3:
// - C2: empty MESH_ADMIN_TOKEN would silently enable an anonymous admin
//   bypass via hashToken("") === hashToken(adminToken="")
// - C3: OAuth/Cookie secret fallback chain collapsed three critical secrets
//   into a single env var
//
// Design:
// - Fail-fast on startup if required config is missing or invalid.
// - In production (NODE_ENV=production), require separate secrets for
//   admin token, cookie signing, and OAuth code signing.
// - In development, allow fallbacks with a loud warning.
// - Pure function: testable in isolation by passing a mock env.

import { resolveCommit } from "./version.js";
import { dirname, join } from "node:path";

const NODE_ENVS = ["production", "development", "test"];

export interface Config {
  meshAdminToken: string;
  meshAdminTokenPrevious?: string;
  meshCookieSecret: string;
  oauthSecret: string;
  natsUrl: string;
  databasePath: string;
  port: number;
  isProduction: boolean;
  /** The deployed commit, or "unknown". See `resolveCommit`. */
  commit: string;
  /** Content-Security-Policy: "report" (say what would be blocked, block
   *  nothing), "enforce", or "off". MESH_CSP, default "report". */
  cspMode: "enforce" | "report" | "off";
  /** Where the daily copies of the database go; null when it is not a file. */
  backupDir: string | null;
  /** How many daily copies stay. 0 switches backups off. */
  backupKeep: number;
  /** `Secure` on the session cookie. Follows `isProduction` unless
   *  MESH_COOKIE_SECURE says otherwise. */
  cookieSecure: boolean;
  /** Is there a proxy in front that appends its peer to X-Forwarded-For?
   *  MESH_BEHIND_PROXY, off unless set: without such a proxy the header is
   *  whatever the sender typed (src/services/client-ip.ts). */
  behindProxy: boolean;
}

export interface ConfigError {
  errors: string[];
}

/**
 * Load and validate configuration from the given environment.
 *
 * Returns a Config on success, or a ConfigError with a list of problems.
 * Callers (typically `start()`) decide how to handle errors — in production
 * code this should log + process.exit(1).
 *
 * @param env - The environment to load from. Defaults to `process.env`.
 *              Passing a mock object makes this function unit-testable.
 */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): Config | ConfigError {
  const errors: string[] = [];
  // Three names, nothing else. "prod" or "Production" used to mean
  // development: no required secrets, no Secure cookie, and nobody told.
  const nodeEnv = env.NODE_ENV ?? "";
  if (nodeEnv !== "" && !NODE_ENVS.includes(nodeEnv)) {
    errors.push(`NODE_ENV must be one of ${NODE_ENVS.join(", ")}, or unset (got "${nodeEnv}")`);
  }
  const isProduction = nodeEnv === "production";

  // Admin token is required in all modes. Must be at least 32 chars
  // to prevent the empty-token bypass (C2).
  const meshAdminToken = env.MESH_ADMIN_TOKEN ?? "";
  if (meshAdminToken.length < 32) {
    errors.push(
      `MESH_ADMIN_TOKEN must be set and at least 32 characters (got ${meshAdminToken.length})`,
    );
  }

  // In production, require separate secrets for cookie and OAuth.
  // Dev mode allows fallback to MESH_ADMIN_TOKEN with a warning (issued
  // when getCookieSecret / getOAuthSecret are actually called).
  const meshCookieSecret = env.MESH_COOKIE_SECRET ?? "";
  const oauthSecret = env.OAUTH_SECRET ?? "";

  if (isProduction) {
    if (!meshCookieSecret) {
      errors.push("MESH_COOKIE_SECRET is required in production");
    } else if (meshCookieSecret.length < 32) {
      errors.push(
        `MESH_COOKIE_SECRET must be at least 32 characters (got ${meshCookieSecret.length})`,
      );
    }
    if (!oauthSecret) {
      errors.push("OAUTH_SECRET is required in production");
    } else if (oauthSecret.length < 32) {
      errors.push(
        `OAUTH_SECRET must be at least 32 characters (got ${oauthSecret.length})`,
      );
    }
  }

  // The previous admin token is an admin credential for as long as it is
  // set, so it is held to the same length. Empty means "not set": that is
  // what `${MESH_ADMIN_TOKEN_PREVIOUS:-}` in the compose file passes.
  const previousRaw = (env.MESH_ADMIN_TOKEN_PREVIOUS ?? "").trim();
  const meshAdminTokenPrevious = previousRaw === "" ? undefined : previousRaw;
  if (meshAdminTokenPrevious !== undefined && meshAdminTokenPrevious.length < 32) {
    errors.push(`MESH_ADMIN_TOKEN_PREVIOUS must be at least 32 characters when set (got ${meshAdminTokenPrevious.length})`);
  }

  // Three secrets that are one secret are not three secrets: whoever reads a
  // session cookie's signing key would hold the admin token. Names only in
  // the message, never a value.
  if (isProduction) {
    const secrets: [string, string | undefined][] = [
      ["MESH_ADMIN_TOKEN", meshAdminToken],
      ["MESH_COOKIE_SECRET", meshCookieSecret],
      ["OAUTH_SECRET", oauthSecret],
      ["MESH_ADMIN_TOKEN_PREVIOUS", meshAdminTokenPrevious],
    ];
    for (let i = 0; i < secrets.length; i++) {
      for (let j = i + 1; j < secrets.length; j++) {
        const [a, va] = secrets[i];
        const [b, vb] = secrets[j];
        // Rotating the admin token to its own value is pointless, not unsafe.
        if (a === "MESH_ADMIN_TOKEN" && b === "MESH_ADMIN_TOKEN_PREVIOUS") continue;
        if (va && vb && va === vb) errors.push(`${b} must not have the same value as ${a}`);
      }
    }
  }

  // Backups: next to the database unless told otherwise. 0 switches them off.
  const databasePath = env.DATABASE_PATH ?? "./mesh.db";
  const isFileDatabase = databasePath !== ":memory:" && databasePath !== "";
  const backupDir = (env.BACKUP_DIR ?? "").trim() || (isFileDatabase ? join(dirname(databasePath), "backups") : null);
  const backupKeepRaw = (env.BACKUP_KEEP ?? "").trim();
  let backupKeep = 7;
  if (backupKeepRaw !== "") {
    if (/^\d{1,3}$/.test(backupKeepRaw) && Number(backupKeepRaw) <= 365) backupKeep = Number(backupKeepRaw);
    else errors.push(`BACKUP_KEEP must be a whole number from 0 to 365 (got "${backupKeepRaw}")`);
  }

  // Port parsing
  const portStr = env.PORT ?? "3000";
  const port = parseInt(portStr, 10);
  if (Number.isNaN(port) || port < 1 || port > 65535) {
    errors.push(`PORT must be a valid port number (got "${portStr}")`);
  }

  // Secure on the session cookie. A browser drops a Secure cookie that
  // arrives over plain http (Chrome and Firefox except http://localhost,
  // Safari not even there), so a production-mode stack served without TLS
  // would accept the sign-in and never see the cookie again. NODE_ENV alone cannot tell the two apart: the compose file pins
  // it to "production". Unset or empty means "follow NODE_ENV".
  const cookieSecureRaw = (env.MESH_COOKIE_SECURE ?? "").trim().toLowerCase();
  let cookieSecure = isProduction;
  if (cookieSecureRaw === "1" || cookieSecureRaw === "true") cookieSecure = true;
  else if (cookieSecureRaw === "0" || cookieSecureRaw === "false") cookieSecure = false;
  else if (cookieSecureRaw !== "") {
    errors.push(`MESH_COOKIE_SECURE must be 1, 0, true or false (got "${env.MESH_COOKIE_SECURE}")`);
  }

  // Whose address failed sign-ins are counted against. The compose file sets
  // this: there the container is reachable through Coolify's proxy only.
  const behindProxyRaw = (env.MESH_BEHIND_PROXY ?? "").trim().toLowerCase();
  const behindProxy = behindProxyRaw === "1" || behindProxyRaw === "true";
  if (behindProxyRaw !== "" && !behindProxy && behindProxyRaw !== "0" && behindProxyRaw !== "false") {
    errors.push(`MESH_BEHIND_PROXY must be 1, 0, true or false (got "${env.MESH_BEHIND_PROXY}")`);
  }
  // The switch an operator reaches for when a policy breaks a page: report
  // instead of block, without a code change.
  const cspRaw = (env.MESH_CSP ?? "").trim().toLowerCase();
  let cspMode: "enforce" | "report" | "off" = "report";
  if (cspRaw === "enforce" || cspRaw === "report" || cspRaw === "off") cspMode = cspRaw;
  else if (cspRaw !== "") errors.push(`MESH_CSP must be enforce, report or off (got "${env.MESH_CSP}")`);

  if (errors.length > 0) {
    return { errors };
  }

  return {
    meshAdminToken,
    meshAdminTokenPrevious,
    meshCookieSecret,
    oauthSecret,
    natsUrl: env.NATS_URL ?? "nats://localhost:4222",
    databasePath,
    backupDir: isFileDatabase ? backupDir : null,
    backupKeep,
    port,
    isProduction,
    cookieSecure,
    behindProxy,
    commit: resolveCommit(env),
    cspMode,
  };
}

/**
 * Type guard: true if loadConfig returned a ConfigError.
 */
export function isConfigError(
  result: Config | ConfigError,
): result is ConfigError {
  return "errors" in result;
}
