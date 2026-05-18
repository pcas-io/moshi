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

export interface Config {
  meshAdminToken: string;
  meshAdminTokenPrevious?: string;
  meshCookieSecret: string;
  oauthSecret: string;
  natsUrl: string;
  databasePath: string;
  port: number;
  isProduction: boolean;
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
  const isProduction = env.NODE_ENV === "production";

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

  // Port parsing
  const portStr = env.PORT ?? "3000";
  const port = parseInt(portStr, 10);
  if (Number.isNaN(port) || port < 1 || port > 65535) {
    errors.push(`PORT must be a valid port number (got "${portStr}")`);
  }

  if (errors.length > 0) {
    return { errors };
  }

  return {
    meshAdminToken,
    meshAdminTokenPrevious: env.MESH_ADMIN_TOKEN_PREVIOUS,
    meshCookieSecret,
    oauthSecret,
    natsUrl: env.NATS_URL ?? "nats://localhost:4222",
    databasePath: env.DATABASE_PATH ?? "./mesh.db",
    port,
    isProduction,
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
