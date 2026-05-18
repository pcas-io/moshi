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
