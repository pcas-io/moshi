import { describe, it, expect } from "vitest";
import { loadConfig, isConfigError } from "../src/config";

// Minimal valid env — used as a base for tests that need "almost valid".
const VALID_DEV_ENV: NodeJS.ProcessEnv = {
  MESH_ADMIN_TOKEN: "a".repeat(32), // exactly 32 chars
  NATS_URL: "nats://localhost:4222",
  DATABASE_PATH: "./test.db",
  PORT: "3000",
};

const VALID_PROD_ENV: NodeJS.ProcessEnv = {
  ...VALID_DEV_ENV,
  NODE_ENV: "production",
  MESH_COOKIE_SECRET: "b".repeat(32),
  OAUTH_SECRET: "c".repeat(32),
};

describe("loadConfig", () => {
  describe("valid cases", () => {
    it("accepts a complete dev environment", () => {
      const result = loadConfig(VALID_DEV_ENV);
      expect(isConfigError(result)).toBe(false);
      if (!isConfigError(result)) {
        expect(result.meshAdminToken).toBe("a".repeat(32));
        expect(result.port).toBe(3000);
        expect(result.isProduction).toBe(false);
      }
    });

    it("accepts a complete production environment", () => {
      const result = loadConfig(VALID_PROD_ENV);
      expect(isConfigError(result)).toBe(false);
      if (!isConfigError(result)) {
        expect(result.isProduction).toBe(true);
        expect(result.meshCookieSecret).toBe("b".repeat(32));
        expect(result.oauthSecret).toBe("c".repeat(32));
      }
    });

    // The session cookie's Secure flag. It follows NODE_ENV unless said
    // otherwise, because the compose file pins NODE_ENV=production and that
    // same stack is also run on plain http://localhost.
    it("derives cookieSecure from NODE_ENV and lets MESH_COOKIE_SECURE override it", () => {
      const secure = (env: NodeJS.ProcessEnv) => {
        const result = loadConfig(env);
        if (isConfigError(result)) throw new Error(result.errors.join("; "));
        return result.cookieSecure;
      };
      expect(secure(VALID_DEV_ENV)).toBe(false);
      expect(secure(VALID_PROD_ENV)).toBe(true);
      expect(secure({ ...VALID_PROD_ENV, MESH_COOKIE_SECURE: "" })).toBe(true); // compose passes "" when unset
      for (const off of ["0", "false", "FALSE"]) expect(secure({ ...VALID_PROD_ENV, MESH_COOKIE_SECURE: off }), off).toBe(false);
      for (const on of ["1", "true", "True"]) expect(secure({ ...VALID_DEV_ENV, MESH_COOKIE_SECURE: on }), on).toBe(true);
    });

    it("refuses a MESH_COOKIE_SECURE it cannot read, instead of guessing", () => {
      const result = loadConfig({ ...VALID_PROD_ENV, MESH_COOKIE_SECURE: "maybe" });
      expect(isConfigError(result)).toBe(true);
      if (isConfigError(result)) expect(result.errors.join(" ")).toContain("MESH_COOKIE_SECURE");
    });

    // Whose address a failed sign-in is counted against. Only a proxy that
    // appends its peer makes X-Forwarded-For worth reading.
    it("believes forwarding headers only when MESH_BEHIND_PROXY says there is a proxy", () => {
      const behind = (env: NodeJS.ProcessEnv) => {
        const result = loadConfig(env);
        if (isConfigError(result)) throw new Error(result.errors.join("; "));
        return result.behindProxy;
      };
      expect(behind(VALID_DEV_ENV)).toBe(false);
      expect(behind(VALID_PROD_ENV)).toBe(false); // production alone does not say how it is reached
      expect(behind({ ...VALID_PROD_ENV, MESH_BEHIND_PROXY: "" })).toBe(false);
      for (const on of ["1", "true", " TRUE "]) expect(behind({ ...VALID_PROD_ENV, MESH_BEHIND_PROXY: on }), on).toBe(true);
      for (const off of ["0", "false", "False"]) expect(behind({ ...VALID_PROD_ENV, MESH_BEHIND_PROXY: off }), off).toBe(false);
    });

    it("refuses a MESH_BEHIND_PROXY it cannot read, instead of guessing", () => {
      const result = loadConfig({ ...VALID_PROD_ENV, MESH_BEHIND_PROXY: "traefik" });
      expect(isConfigError(result)).toBe(true);
      if (isConfigError(result)) expect(result.errors.join(" ")).toContain("MESH_BEHIND_PROXY");
    });

    // Content-Security-Policy: report first, enforce when told to.
    it("reads MESH_CSP: report unless said otherwise, trimmed and in any case", () => {
      const mode = (env: NodeJS.ProcessEnv) => {
        const result = loadConfig(env);
        if (isConfigError(result)) throw new Error(result.errors.join("; "));
        return result.cspMode;
      };
      expect(mode(VALID_PROD_ENV)).toBe("report");
      expect(mode({ ...VALID_PROD_ENV, MESH_CSP: "" })).toBe("report"); // compose passes "" when unset
      expect(mode({ ...VALID_PROD_ENV, MESH_CSP: " Enforce " })).toBe("enforce");
      expect(mode({ ...VALID_PROD_ENV, MESH_CSP: "REPORT" })).toBe("report");
      expect(mode({ ...VALID_DEV_ENV, MESH_CSP: "off" })).toBe("off");
    });

    it("refuses a MESH_CSP it cannot read: 'enforced' must not quietly mean report", () => {
      for (const bad of ["enforced", "block", "1"]) {
        const result = loadConfig({ ...VALID_PROD_ENV, MESH_CSP: bad });
        expect(isConfigError(result), bad).toBe(true);
        if (isConfigError(result)) expect(result.errors.join(" ")).toContain(`MESH_CSP must be enforce, report or off (got "${bad}")`);
      }
    });

    // The origin everything meant for a shell is addressed with. Unset, the
    // request's Host is used — and a Host is the client's to choose.
    it("reads MESH_PUBLIC_URL as an origin, and nothing else", () => {
      const origin = (env: NodeJS.ProcessEnv) => {
        const result = loadConfig(env);
        if (isConfigError(result)) throw new Error(result.errors.join("; "));
        return result.publicUrl;
      };
      expect(origin(VALID_PROD_ENV)).toBe("");
      expect(origin({ ...VALID_PROD_ENV, MESH_PUBLIC_URL: "" })).toBe("");
      expect(origin({ ...VALID_PROD_ENV, MESH_PUBLIC_URL: " https://moshi.example " })).toBe("https://moshi.example");
      expect(origin({ ...VALID_PROD_ENV, MESH_PUBLIC_URL: "https://moshi.example/" })).toBe("https://moshi.example");
      expect(origin({ ...VALID_PROD_ENV, MESH_PUBLIC_URL: "http://localhost:8080" })).toBe("http://localhost:8080");
    });

    it("refuses a MESH_PUBLIC_URL that is not an origin", () => {
      for (const bad of ["moshi.example", "ftp://moshi.example", "https://moshi.example/install.sh",
        "https://user:pw@moshi.example", "https://moshi.example?x=1", "not a url"]) {
        const result = loadConfig({ ...VALID_PROD_ENV, MESH_PUBLIC_URL: bad });
        expect(isConfigError(result), bad).toBe(true);
        if (isConfigError(result)) expect(result.errors.join(" ")).toContain("MESH_PUBLIC_URL");
      }
    });

    // parseInt stops at the first character that is not a digit, so
    // `PORT="8080 # behind the proxy"` was read as 8080 and the comment
    // silently discarded — the one value the section's promise ("refuses to
    // start on a value it cannot make sense of") did not hold for.
    it("refuses a PORT that is not digits alone", () => {
      for (const bad of ["80abc", "3000.9", "8080 # behind the proxy", "", " ", "-1", "0x50", "80800"]) {
        const result = loadConfig({ ...VALID_PROD_ENV, PORT: bad });
        expect(isConfigError(result), bad).toBe(true);
        if (isConfigError(result)) expect(result.errors.join(" ")).toContain("PORT must be a valid port number");
      }
      const good = loadConfig({ ...VALID_PROD_ENV, PORT: " 8080 " });
      expect(isConfigError(good)).toBe(false);
      if (!isConfigError(good)) expect(good.port).toBe(8080);
    });

    it("applies defaults for NATS_URL, DATABASE_PATH, and PORT", () => {
      const minimal: NodeJS.ProcessEnv = { MESH_ADMIN_TOKEN: "a".repeat(32) };
      const result = loadConfig(minimal);
      expect(isConfigError(result)).toBe(false);
      if (!isConfigError(result)) {
        expect(result.natsUrl).toBe("nats://localhost:4222");
        expect(result.databasePath).toBe("./mesh.db");
        expect(result.port).toBe(3000);
      }
    });

    it("preserves MESH_ADMIN_TOKEN_PREVIOUS when set", () => {
      const env = { ...VALID_DEV_ENV, MESH_ADMIN_TOKEN_PREVIOUS: "z".repeat(32) };
      const result = loadConfig(env);
      expect(isConfigError(result)).toBe(false);
      if (!isConfigError(result)) {
        expect(result.meshAdminTokenPrevious).toBe("z".repeat(32));
      }
    });
  });

  describe("C2: empty MESH_ADMIN_TOKEN is rejected", () => {
    it("rejects missing MESH_ADMIN_TOKEN", () => {
      const result = loadConfig({});
      expect(isConfigError(result)).toBe(true);
      if (isConfigError(result)) {
        expect(result.errors.some((e) => e.includes("MESH_ADMIN_TOKEN"))).toBe(true);
      }
    });

    it("rejects empty MESH_ADMIN_TOKEN", () => {
      const result = loadConfig({ MESH_ADMIN_TOKEN: "" });
      expect(isConfigError(result)).toBe(true);
      if (isConfigError(result)) {
        expect(result.errors.some((e) => e.includes("MESH_ADMIN_TOKEN"))).toBe(true);
      }
    });

    it("rejects MESH_ADMIN_TOKEN shorter than 32 chars", () => {
      const result = loadConfig({ MESH_ADMIN_TOKEN: "short" });
      expect(isConfigError(result)).toBe(true);
      if (isConfigError(result)) {
        expect(result.errors[0]).toContain("32 characters");
      }
    });

    it("accepts MESH_ADMIN_TOKEN of exactly 32 chars", () => {
      const result = loadConfig({ MESH_ADMIN_TOKEN: "x".repeat(32) });
      expect(isConfigError(result)).toBe(false);
    });
  });

  describe("C3: production requires separate secrets", () => {
    it("rejects production without MESH_COOKIE_SECRET", () => {
      const env = { ...VALID_PROD_ENV, MESH_COOKIE_SECRET: undefined };
      const result = loadConfig(env);
      expect(isConfigError(result)).toBe(true);
      if (isConfigError(result)) {
        expect(result.errors.some((e) => e.includes("MESH_COOKIE_SECRET"))).toBe(true);
      }
    });

    it("rejects production without OAUTH_SECRET", () => {
      const env = { ...VALID_PROD_ENV, OAUTH_SECRET: undefined };
      const result = loadConfig(env);
      expect(isConfigError(result)).toBe(true);
      if (isConfigError(result)) {
        expect(result.errors.some((e) => e.includes("OAUTH_SECRET"))).toBe(true);
      }
    });

    it("rejects production with short MESH_COOKIE_SECRET", () => {
      const env = { ...VALID_PROD_ENV, MESH_COOKIE_SECRET: "short" };
      const result = loadConfig(env);
      expect(isConfigError(result)).toBe(true);
    });

    it("rejects production with short OAUTH_SECRET", () => {
      const env = { ...VALID_PROD_ENV, OAUTH_SECRET: "short" };
      const result = loadConfig(env);
      expect(isConfigError(result)).toBe(true);
    });

    it("allows dev mode without separate secrets (fallback behavior)", () => {
      // Dev mode does NOT require MESH_COOKIE_SECRET or OAUTH_SECRET.
      // The actual fallback to MESH_ADMIN_TOKEN happens at call sites
      // (getCookieSecret, getOAuthSecret) with a warning.
      const result = loadConfig(VALID_DEV_ENV);
      expect(isConfigError(result)).toBe(false);
    });

    it("reports all production secret errors at once", () => {
      const env: NodeJS.ProcessEnv = {
        MESH_ADMIN_TOKEN: "a".repeat(32),
        NODE_ENV: "production",
        // No cookie secret, no oauth secret
      };
      const result = loadConfig(env);
      expect(isConfigError(result)).toBe(true);
      if (isConfigError(result)) {
        expect(result.errors).toHaveLength(2);
      }
    });
  });

  describe("PORT validation", () => {
    it("rejects non-numeric PORT", () => {
      const env = { ...VALID_DEV_ENV, PORT: "not-a-number" };
      const result = loadConfig(env);
      expect(isConfigError(result)).toBe(true);
      if (isConfigError(result)) {
        expect(result.errors.some((e) => e.includes("PORT"))).toBe(true);
      }
    });

    it("rejects PORT=0", () => {
      const env = { ...VALID_DEV_ENV, PORT: "0" };
      const result = loadConfig(env);
      expect(isConfigError(result)).toBe(true);
    });

    it("rejects PORT above 65535", () => {
      const env = { ...VALID_DEV_ENV, PORT: "99999" };
      const result = loadConfig(env);
      expect(isConfigError(result)).toBe(true);
    });

    it("accepts PORT=80", () => {
      const env = { ...VALID_DEV_ENV, PORT: "80" };
      const result = loadConfig(env);
      expect(isConfigError(result)).toBe(false);
    });
  });
});

// --- Betrieb B: a typo must not pick the development fallbacks, and three
// secrets that are one secret are not three secrets. ---
describe("loadConfig — stricter validation", () => {
  const A = "a".repeat(40);
  const B = "b".repeat(40);
  const C = "c".repeat(40);
  const prod = (over: Record<string, string | undefined> = {}) =>
    loadConfig({ NODE_ENV: "production", MESH_ADMIN_TOKEN: A, MESH_COOKIE_SECRET: B, OAUTH_SECRET: C, ...over });
  const errorsOf = (r: ReturnType<typeof loadConfig>) => (isConfigError(r) ? r.errors.join(" | ") : "");

  it("knows three environments and refuses everything else instead of falling back to development", () => {
    for (const ok of ["production", "development", "test", undefined, ""]) {
      expect(isConfigError(loadConfig({ NODE_ENV: ok, MESH_ADMIN_TOKEN: A, MESH_COOKIE_SECRET: B, OAUTH_SECRET: C })), String(ok)).toBe(false);
    }
    for (const typo of ["prod", "Production", "PRODUCTION", "production ", "staging", "live"]) {
      const r = loadConfig({ NODE_ENV: typo, MESH_ADMIN_TOKEN: A, MESH_COOKIE_SECRET: B, OAUTH_SECRET: C });
      expect(errorsOf(r), typo).toContain("NODE_ENV");
    }
  });

  it("refuses production secrets that are the same secret", () => {
    expect(errorsOf(prod({ MESH_COOKIE_SECRET: A }))).toContain("MESH_COOKIE_SECRET");
    expect(errorsOf(prod({ OAUTH_SECRET: A }))).toContain("OAUTH_SECRET");
    expect(errorsOf(prod({ OAUTH_SECRET: B }))).toMatch(/OAUTH_SECRET.*MESH_COOKIE_SECRET|MESH_COOKIE_SECRET.*OAUTH_SECRET/);
    expect(isConfigError(prod())).toBe(false);
  });

  it("never prints a secret in an error", () => {
    const r = prod({ MESH_COOKIE_SECRET: A, OAUTH_SECRET: A, MESH_ADMIN_TOKEN_PREVIOUS: "short-previous" });
    expect(errorsOf(r)).not.toContain(A);
    expect(errorsOf(r)).not.toContain("short-previous");
  });

  it("holds the previous admin token to the same length: it is an admin credential too", () => {
    expect(errorsOf(prod({ MESH_ADMIN_TOKEN_PREVIOUS: "x" }))).toContain("MESH_ADMIN_TOKEN_PREVIOUS");
    expect(errorsOf(loadConfig({ MESH_ADMIN_TOKEN: A, MESH_ADMIN_TOKEN_PREVIOUS: "x".repeat(31) }))).toContain("MESH_ADMIN_TOKEN_PREVIOUS");
    const ok = prod({ MESH_ADMIN_TOKEN_PREVIOUS: "p".repeat(40) });
    expect(isConfigError(ok)).toBe(false);
    if (!isConfigError(ok)) expect(ok.meshAdminTokenPrevious).toBe("p".repeat(40));
  });

  it("reads an empty previous token as none: that is what the compose file passes when it is not set", () => {
    for (const blank of ["", "   "]) {
      const r = prod({ MESH_ADMIN_TOKEN_PREVIOUS: blank });
      expect(isConfigError(r)).toBe(false);
      if (!isConfigError(r)) expect(r.meshAdminTokenPrevious).toBeUndefined();
    }
  });

  it("refuses a previous token that is one of the other secrets", () => {
    expect(errorsOf(prod({ MESH_ADMIN_TOKEN_PREVIOUS: B }))).toContain("MESH_ADMIN_TOKEN_PREVIOUS");
    expect(errorsOf(prod({ MESH_ADMIN_TOKEN_PREVIOUS: C }))).toContain("MESH_ADMIN_TOKEN_PREVIOUS");
  });

  it("puts the backups next to the database, seven of them, unless told otherwise", () => {
    const r = loadConfig({ MESH_ADMIN_TOKEN: A, DATABASE_PATH: "/data/moshi.db" });
    if (isConfigError(r)) throw new Error(errorsOf(r));
    expect(r.backupDir).toBe("/data/backups");
    expect(r.backupKeep).toBe(7);

    const custom = loadConfig({ MESH_ADMIN_TOKEN: A, DATABASE_PATH: "/data/moshi.db", BACKUP_DIR: "/mnt/copies", BACKUP_KEEP: "14" });
    if (isConfigError(custom)) throw new Error(errorsOf(custom));
    expect(custom.backupDir).toBe("/mnt/copies");
    expect(custom.backupKeep).toBe(14);

    const off = loadConfig({ MESH_ADMIN_TOKEN: A, BACKUP_KEEP: "0" });
    if (isConfigError(off)) throw new Error(errorsOf(off));
    expect(off.backupKeep).toBe(0);
  });

  it("has no backup directory for a database that is not a file", () => {
    const r = loadConfig({ MESH_ADMIN_TOKEN: A, DATABASE_PATH: ":memory:" });
    if (isConfigError(r)) throw new Error(errorsOf(r));
    expect(r.backupDir).toBeNull();
  });

  it("refuses a BACKUP_KEEP it cannot read", () => {
    for (const bad of ["-1", "seven", "7.5", "366", "1e2"]) {
      expect(errorsOf(loadConfig({ MESH_ADMIN_TOKEN: A, BACKUP_KEEP: bad })), bad).toContain("BACKUP_KEEP");
    }
  });
});
