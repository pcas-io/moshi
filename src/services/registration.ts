// Registration tokens (ADR ocellio 06aef68e): a token that can create agents
// and nothing else, for machines that must not hold the admin token.
//
// Tech-CIO criteria, where each is met:
//   1 scope        : only POST /api/register/agents accepts it (routes/register-api.ts);
//                    the auth middleware does not know it, so everywhere else it is a
//                    wrong Bearer (401) — never an agent, never the operator.
//   2 at rest      : scrypt hash with a per-token salt; the plaintext exists once.
//   3 expires_at   : checked here, on the server (expired = 401).
//   4 name_prefix  : the name must start with it and still pass the agent name rule.
//   5 rate limit   : `max_per_hour` created agents per rolling hour, counted from the
//                    audit rows (survives restarts, holds across containers) → 429.
//   6 audit        : every attempt lands in registration_audit, refused ones too; minting
//                    and revoking a token are `registration_token_created` / `_revoked`
//                    rows in activity_log (never the secret), a created agent is an
//                    `agent_created` row with origin `register` and actor `register:<id>`.
//   7 no escalation: an agent created this way is a plain agent (AgentService.create).
//   8 own route    : see 1; negative tests per refused case in tests/app/registration.test.ts.

import crypto from "node:crypto";
import type Database from "better-sqlite3";
import { ulid } from "ulidx";
import { AGENT_NAME_RE, NameTakenError } from "./agent";
import type { AgentService } from "./agent";
import type { Agent } from "../types";
import { registerActor } from "./activity";
import type { ActivityService, AuditBy } from "./activity";

const PREFIX = "rt_";
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 } as const;
const MAX_LABEL = 80;
export const DEFAULT_MAX_PER_HOUR = 10;
export const MAX_PER_HOUR_CAP = 100;
const HOUR_MS = 60 * 60 * 1000;
/** At most this many token checks (one scrypt each, ~16 MB, in the libuv pool shared with fs and dns)
 *  run at once; more get 429 with Retry-After: 1. Bounds a burst that arrives before any failure is
 *  counted (review C2). */
export const MAX_INFLIGHT_CHECKS = 4;

export interface RegistrationToken {
  id: string;
  label: string;
  name_prefix: string | null;
  expires_at: string | null;
  max_per_hour: number;
  created_at: string;
  created_by: string;
  revoked_at: string | null;
}

/** What an admin sees: never the secret or its hash. */
export interface RegistrationTokenView extends RegistrationToken {
  created_agents: number;
  last_used_at: string | null;
}

export type RegisterResult =
  | { ok: true; agent: Agent; token: string; tokenId: string }
  | { ok: false; status: 400 | 401 | 403 | 409 | 429; error: string; message?: string; retryAfter?: number };

interface Row extends RegistrationToken {
  salt: string;
  secret_hash: string;
}

/** Off the event loop (libuv thread pool): a flood of attempts must not stall every other request. */
function hashSecret(secret: string, salt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(secret, Buffer.from(salt, "hex"), SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p },
      (err, key) => (err ? reject(err) : resolve(key.toString("hex"))));
  });
}

/** How long audit rows are kept (the hourly sweep prunes older ones). */
export const AUDIT_RETENTION_DAYS = 90;

/** `rt_<id>_<secret>` → its parts, or null for anything else. */
export function parseRegistrationToken(plain: string): { id: string; secret: string } | null {
  const match = /^rt_([0-9a-z]{26})_([A-Za-z0-9_-]{43})$/.exec(plain);
  return match ? { id: match[1].toUpperCase(), secret: match[2] } : null;
}

export function isRegistrationToken(plain: string): boolean {
  return plain.startsWith(PREFIX);
}

/** The prefix itself must be the start of a valid agent name. */
function validPrefix(prefix: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,40}$/.test(prefix);
}

export class RegistrationService {
  constructor(
    private db: Database.Database,
    private agents: AgentService,
    private now: () => number = Date.now,
    private activity?: ActivityService,
  ) {}

  async create(params: {
    label: string;
    namePrefix?: string | null;
    expiresAt?: string | null;
    maxPerHour?: number;
    createdBy: string;
    /** Origin and hashed address for the audit row; the actor is `createdBy`. */
    by?: AuditBy;
  }): Promise<{ token: RegistrationTokenView; plaintext: string }> {
    const label = params.label.trim();
    if (!label || label.length > MAX_LABEL) throw new Error(`label: 1 to ${MAX_LABEL} characters`);
    // An EMPTY value is refused, never read as "none": an empty environment variable in a tool must
    // not silently mint a token without prefix or expiry (review C1). Leave the field out for "none".
    if (params.namePrefix !== undefined && params.namePrefix !== null && !params.namePrefix.trim()) {
      throw new Error("name_prefix: empty; leave it out for no prefix");
    }
    if (params.expiresAt !== undefined && params.expiresAt !== null && !params.expiresAt.trim()) {
      throw new Error("expires_at: empty; leave it out for no expiry");
    }
    const prefix = params.namePrefix?.trim() || null;
    if (prefix !== null && !validPrefix(prefix)) throw new Error("name_prefix: letters, digits, _ and -, at most 41");
    let expiresAt: string | null = null;
    if (params.expiresAt) {
      const t = Date.parse(params.expiresAt);
      if (Number.isNaN(t)) throw new Error("expires_at: an ISO date");
      if (t <= this.now()) throw new Error("expires_at: must lie in the future");
      expiresAt = new Date(t).toISOString();
    }
    const maxPerHour = params.maxPerHour ?? DEFAULT_MAX_PER_HOUR;
    if (!Number.isInteger(maxPerHour) || maxPerHour < 1 || maxPerHour > MAX_PER_HOUR_CAP) {
      throw new Error(`max_per_hour: 1 to ${MAX_PER_HOUR_CAP}`);
    }

    const id = ulid();
    const secret = crypto.randomBytes(32).toString("base64url");
    const salt = crypto.randomBytes(16).toString("hex");
    const createdAt = new Date(this.now()).toISOString();
    this.db
      .prepare(
        `INSERT INTO registration_tokens (id, label, salt, secret_hash, name_prefix, expires_at, max_per_hour, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, label, salt, await hashSecret(secret, salt), prefix, expiresAt, maxPerHour, createdAt, params.createdBy);
    // The settings only. The secret exists once, in the answer; its hash and salt stay in their table.
    this.activity?.audit({
      action: "registration_token_created",
      entity_type: "registration_token",
      entity_id: id,
      summary: `Registration token ${id} created ("${label}")`,
      agent_name: params.createdBy,
      origin: params.by?.origin ?? null,
      ip_hash: params.by?.ip_hash ?? null,
      detail: { new: { label, name_prefix: prefix, expires_at: expiresAt, max_per_hour: maxPerHour } },
    });
    return { token: this.view(id)!, plaintext: `${PREFIX}${id.toLowerCase()}_${secret}` };
  }

  list(): RegistrationTokenView[] {
    const ids = this.db.prepare("SELECT id FROM registration_tokens ORDER BY created_at DESC").all() as { id: string }[];
    return ids.map((r) => this.view(r.id)!);
  }

  view(id: string): RegistrationTokenView | null {
    const row = this.db
      .prepare(
        `SELECT id, label, name_prefix, expires_at, max_per_hour, created_at, created_by, revoked_at
         FROM registration_tokens WHERE id = ?`,
      )
      .get(id) as RegistrationToken | undefined;
    if (!row) return null;
    const usage = this.db
      .prepare(
        `SELECT COUNT(*) AS n, MAX(created_at) AS last FROM registration_audit WHERE token_id = ? AND result = 'created'`,
      )
      .get(id) as { n: number; last: string | null };
    return { ...row, created_agents: usage.n, last_used_at: usage.last };
  }

  /** Revoking twice is fine and changes nothing the second time (and writes no second audit row). */
  revoke(id: string, by?: AuditBy): RegistrationTokenView | null {
    const revokedAt = new Date(this.now()).toISOString();
    const changed = this.db
      .prepare("UPDATE registration_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
      .run(revokedAt, id).changes;
    if (changed > 0) {
      this.activity?.audit({
        action: "registration_token_revoked",
        entity_type: "registration_token",
        entity_id: id,
        summary: `Registration token ${id} revoked`,
        agent_name: by?.actor,
        origin: by?.origin ?? null,
        ip_hash: by?.ip_hash ?? null,
        detail: { old: { revoked_at: null }, new: { revoked_at: revokedAt } },
      });
    }
    return this.view(id);
  }

  audit(tokenId: string, limit = 50): { name: string | null; result: string; created_at: string }[] {
    return this.db
      .prepare(
        `SELECT name, result, created_at FROM registration_audit WHERE token_id = ? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(tokenId, Math.max(1, Math.min(limit, 500))) as { name: string | null; result: string; created_at: string }[];
  }

  /** Whether a presented plaintext names a token we have (shape + id, no hashing). Lets a route
   *  answer a throttled client cheaply when its token cannot be ours, while a token with a known id
   *  is always checked: valid credentials pass, whatever else happened from the same address. */
  namesKnownToken(plain: string): boolean {
    const parsed = parseRegistrationToken(plain);
    if (!parsed) return false;
    // Only a LIVE token counts (review C3): a revoked or expired token's id is in every copy of its
    // plaintext, and a leaked, revoked token must not keep a way past the throttle.
    return !!this.db
      .prepare(
        `SELECT 1 FROM registration_tokens
         WHERE id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`,
      )
      .get(parsed.id, new Date(this.now()).toISOString());
  }

  /** Only attempts that name a token we have are recorded: an attempt with a token that is no token
   *  of ours cannot be attributed to anyone, and recording it would let anyone fill the table. Those
   *  are counted and logged by the sign-in guard instead. */
  private record(tokenId: string | null, name: string | null, result: string, ipHash: string | null): void {
    if (tokenId === null) return;
    this.db
      .prepare(
        `INSERT INTO registration_audit (id, token_id, name, result, ip_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(ulid(), tokenId, name ? name.slice(0, 64) : null, result, ipHash, new Date(this.now()).toISOString());
  }

  /** The token behind a presented plaintext, if it is valid now. */
  private async authenticate(plain: string): Promise<{ row: Row } | { reason: "invalid" | "revoked" | "expired"; id: string | null }> {
    const parsed = parseRegistrationToken(plain);
    if (!parsed) return { reason: "invalid", id: null };
    const row = this.db.prepare("SELECT * FROM registration_tokens WHERE id = ?").get(parsed.id) as Row | undefined;
    // An unknown id still costs one scrypt, so the answer time does not tell ids apart.
    const actual = await hashSecret(parsed.secret, row?.salt ?? "00".repeat(16));
    const expected = row?.secret_hash ?? "";
    const match = expected.length === actual.length && crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
    if (!row || !match) return { reason: "invalid", id: row ? row.id : null };
    if (row.revoked_at) return { reason: "revoked", id: row.id };
    if (row.expires_at && Date.parse(row.expires_at) <= this.now()) return { reason: "expired", id: row.id };
    return { row };
  }

  private inflight = 0;

  async register(plain: string, rawName: unknown, rawAvatar: unknown, ipHash: string | null): Promise<RegisterResult> {
    if (this.inflight >= MAX_INFLIGHT_CHECKS) {
      return { ok: false, status: 429, error: "busy", retryAfter: 1 };
    }
    this.inflight++;
    try {
      return await this.registerChecked(plain, rawName, rawAvatar, ipHash);
    } finally {
      this.inflight--;
    }
  }

  private async registerChecked(plain: string, rawName: unknown, rawAvatar: unknown, ipHash: string | null): Promise<RegisterResult> {
    const name = typeof rawName === "string" ? rawName.trim() : "";
    const auth = await this.authenticate(plain);
    if ("reason" in auth) {
      // A wrong secret for a known id is recorded under that id: the owner sees someone tried.
      this.record(auth.id, name || null, `refused_${auth.reason}`, ipHash);
      return { ok: false, status: 401, error: auth.reason === "invalid" ? "invalid_token" : `token_${auth.reason}` };
    }
    const token = auth.row;
    if (!name || !AGENT_NAME_RE.test(name)) {
      this.record(token.id, name || null, "refused_name", ipHash);
      return { ok: false, status: 400, error: "invalid_name" };
    }
    if (token.name_prefix && !(name.startsWith(token.name_prefix) && name.length > token.name_prefix.length)) {
      this.record(token.id, name, "refused_prefix", ipHash);
      return { ok: false, status: 403, error: "name_prefix", message: `Names must start with ${token.name_prefix}` };
    }
    if (rawAvatar !== undefined && (typeof rawAvatar !== "string" || rawAvatar.length > 64)) {
      this.record(token.id, name, "refused_avatar", ipHash);
      return { ok: false, status: 400, error: "invalid_avatar" };
    }
    const since = new Date(this.now() - HOUR_MS).toISOString();
    const recent = this.db
      .prepare(
        `SELECT COUNT(*) AS n, MIN(created_at) AS first FROM registration_audit
         WHERE token_id = ? AND result = 'created' AND created_at > ?`,
      )
      .get(token.id, since) as { n: number; first: string | null };
    if (recent.n >= token.max_per_hour) {
      this.record(token.id, name, "refused_rate", ipHash);
      const retryAfter = recent.first
        ? Math.max(1, Math.ceil((Date.parse(recent.first) + HOUR_MS - this.now()) / 1000))
        : 3600;
      return { ok: false, status: 429, error: "rate_limited", retryAfter };
    }
    try {
      const created = this.agents.create(name, rawAvatar as string | undefined,
        { actor: registerActor(token.id), origin: "register", ip_hash: ipHash });
      this.record(token.id, name, "created", ipHash);
      return { ok: true, agent: created.agent, token: created.plaintextToken, tokenId: token.id };
    } catch (err: unknown) {
      if (err instanceof NameTakenError) {
        this.record(token.id, name, "refused_taken", ipHash);
        return { ok: false, status: 409, error: "name_taken", message: err.message };
      }
      this.record(token.id, name, "refused_other", ipHash);
      return { ok: false, status: 400, error: err instanceof Error ? err.message : "create_failed" };
    }
  }
}

/** For the hourly sweep (maintenance-tasks.ts): audit rows older than the retention. */
export function pruneRegistrationAudit(db: Database.Database, now: number = Date.now(),
                                       retentionDays: number = AUDIT_RETENTION_DAYS): number {
  const before = new Date(now - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  return db.prepare("DELETE FROM registration_audit WHERE created_at < ?").run(before).changes;
}
