// The webhook of an agent: where it goes, how it proves itself, what it is
// for, and how it has been doing. One per agent, by inbox key.
//
// The signing secret (or bearer key) is needed in plain text for every call,
// so it cannot be hashed. It is sealed (src/seal.ts) under a key derived from
// OAUTH_SECRET, and the seal names the agent and the hook it belongs to. It is
// never handed out again: not by `get`, not in a log line, not on a page. A
// secret moshi generates is shown once, in the answer to `set`.
//
// Rotating OAUTH_SECRET makes every sealed secret unreadable. The next call of
// such a hook fails with `secret_unreadable`, and it has to be set again.

import crypto from "node:crypto";
import { ulid } from "ulidx";
import type Database from "better-sqlite3";
import { MESSAGE_PRIORITIES } from "../types.js";
import type { MessagePriority } from "../types.js";
import { seal, open } from "../seal.js";
import { checkUrl, resolveTarget } from "./webhook-target.js";
import type { Resolved } from "./webhook-target.js";
import { checkSigningSecret, checkBearerKey, generateSigningSecret, SIGNING_SECRET_PREFIX } from "./webhook-sign.js";
import type { ActivityService } from "./activity.js";

export const AUTH_MODES = ["standard_webhooks", "bearer"] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

export const WEBHOOK_LIMITS = {
  TYPES: 32,
  TYPE: 64,
  ERROR: 200,
} as const;

const KEY_SALT = "moshi/webhook-secret";
const KEY_INFO = "moshi/webhook-secret/v1";

export interface WebhookSettings {
  url: string;
  /** Absent: told by the secret (see `authModeFor`). */
  authMode?: AuthMode;
  includeBroadcasts: boolean;
  /** Only these message types; null for all. */
  types: string[] | null;
  minPriority: MessagePriority;
}

/** What `mesh_status` may tell everybody: no URL, no filter. */
export interface WebhookStatus {
  /** `failing`: active, and the last attempt failed. */
  state: "active" | "failing" | "disabled";
  last_success_at: string | null;
  last_failure_at: string | null;
}

/** What the agent itself and the admin see. Never the secret. */
export interface WebhookView extends WebhookStatus {
  url: string;
  auth_mode: AuthMode;
  include_broadcasts: boolean;
  types: string[] | null;
  min_priority: MessagePriority;
  consecutive_failures: number;
  last_error: string | null;
  disabled_at: string | null;
  created_at: string;
  updated_at: string;
  /** The call that is waiting or under way, if there is one. */
  pending: { messages: number; attempts: number; due_at: string } | null;
}

/** What a call needs. `secret` is null when it can no longer be opened. */
export interface WebhookMaterial {
  agentName: string;
  url: string;
  authMode: AuthMode;
  secret: string | null;
}

interface Row {
  agent_key: string;
  hook_id: string;
  url: string;
  auth_mode: AuthMode;
  secret_sealed: string;
  include_broadcasts: number;
  types: string | null;
  min_priority: MessagePriority;
  state: "active" | "disabled";
  consecutive_failures: number;
  last_success_at: string | null;
  last_failure_at: string | null;
  last_error: string | null;
  disabled_at: string | null;
  created_at: string;
  updated_at: string;
}

export class WebhookError extends Error {}

function statusOf(row: Pick<Row, "state" | "last_success_at" | "last_failure_at">): WebhookStatus {
  const failedLast = row.last_failure_at !== null && (row.last_success_at === null || row.last_failure_at > row.last_success_at);
  return {
    state: row.state === "disabled" ? "disabled" : failedLast ? "failing" : "active",
    last_success_at: row.last_success_at,
    last_failure_at: row.last_failure_at,
  };
}

/**
 * The kind of key, by its form: a `whsec_` secret (or none, then moshi makes
 * one) is signed, any other key is sent as a bearer key. Nobody has to know
 * which kind a receiver handed out; it is what they copy.
 */
export function authModeFor(secret: string | undefined): AuthMode {
  return secret === undefined || secret === "" || secret.startsWith(SIGNING_SECRET_PREFIX) ? "standard_webhooks" : "bearer";
}

/** Trimmed, without empties and repeats; null when nothing is left. */
export function normaliseTypes(types: readonly string[] | null | undefined): string[] | null {
  if (!types) return null;
  const unique = [...new Set(types.map((t) => t.trim()).filter((t) => t !== ""))];
  return unique.length > 0 ? unique : null;
}

export class WebhookService {
  private readonly key: Buffer;

  constructor(
    private readonly db: Database.Database,
    keyMaterial: string,
    private readonly activity?: ActivityService,
    /** DNS, replaceable in tests. */
    private readonly resolve: (host: string) => Promise<Resolved> = (host) => resolveTarget(host),
  ) {
    if (!keyMaterial) throw new Error("WebhookService needs key material (OAUTH_SECRET)");
    this.key = Buffer.from(crypto.hkdfSync("sha256", keyMaterial, KEY_SALT, KEY_INFO, 32));
  }

  /** Whether `url` may be a hook right now: its form, and every address its
   *  host resolves to. The call checks again; this is so that `set` refuses
   *  a private target instead of failing five times later. */
  async checkTarget(url: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    const form = checkUrl(url);
    if (!form.ok) return form;
    const target = await this.resolve(form.host);
    if (target.ok) return { ok: true };
    return {
      ok: false,
      reason: target.reason === "target_not_public"
        ? "the host resolves to an address that is not public (private, loopback, link-local or reserved)"
        : `the host could not be resolved (${target.reason})`,
    };
  }

  private context(agentKey: string, hookId: string): Buffer {
    return Buffer.from(`${agentKey}:${hookId}`);
  }

  /**
   * Sets the hook of `agentKey`, replacing one it had, and enables it. The URL
   * has to have passed `checkTarget` (DNS) already; its form is checked here
   * again. Returns the secret only when it was generated here.
   */
  set(
    agentKey: string,
    settings: WebhookSettings,
    secret: string | undefined,
    actor: string,
  ): { view: WebhookView; generatedSecret?: string } {
    const url = checkUrl(settings.url);
    if (!url.ok) throw new WebhookError(`url: ${url.reason}`);
    const authMode = settings.authMode ?? authModeFor(secret);
    if (!(AUTH_MODES as readonly string[]).includes(authMode)) throw new WebhookError(`auth_mode: one of ${AUTH_MODES.join(", ")}`);
    if (!(MESSAGE_PRIORITIES as readonly string[]).includes(settings.minPriority)) {
      throw new WebhookError(`min_priority: one of ${MESSAGE_PRIORITIES.join(", ")}`);
    }
    const types = normaliseTypes(settings.types);
    if (types && (types.length > WEBHOOK_LIMITS.TYPES || types.some((t) => t.length > WEBHOOK_LIMITS.TYPE))) {
      throw new WebhookError(`types: at most ${WEBHOOK_LIMITS.TYPES}, each at most ${WEBHOOK_LIMITS.TYPE} characters`);
    }

    let generatedSecret: string | undefined;
    let plain: string;
    if (authMode === "bearer") {
      if (secret === undefined || secret === "") throw new WebhookError("secret: the bearer key the receiver gave out is required for auth_mode bearer");
      const why = checkBearerKey(secret);
      if (why) throw new WebhookError(`secret: ${why}`);
      plain = secret;
    } else if (secret === undefined || secret === "") {
      plain = generatedSecret = generateSigningSecret();
    } else {
      const why = checkSigningSecret(secret);
      if (why) throw new WebhookError(`secret: ${why}`);
      plain = secret;
    }

    const hookId = ulid();
    const now = new Date().toISOString();
    const write = this.db.transaction(() => {
      // Whatever the old hook still had waiting was for the old target.
      this.db.prepare("DELETE FROM webhook_deliveries WHERE agent_key = ?").run(agentKey);
      this.db
        .prepare(
          `INSERT INTO agent_webhooks (agent_key, hook_id, url, auth_mode, secret_sealed, include_broadcasts, types, min_priority,
                                       state, consecutive_failures, last_success_at, last_failure_at, last_error, disabled_at, created_at, updated_at)
           VALUES (@agent_key, @hook_id, @url, @auth_mode, @secret_sealed, @include_broadcasts, @types, @min_priority,
                   'active', 0, NULL, NULL, NULL, NULL, @now, @now)
           ON CONFLICT(agent_key) DO UPDATE SET
             hook_id = excluded.hook_id, url = excluded.url, auth_mode = excluded.auth_mode, secret_sealed = excluded.secret_sealed,
             include_broadcasts = excluded.include_broadcasts, types = excluded.types, min_priority = excluded.min_priority,
             state = 'active', consecutive_failures = 0, last_success_at = NULL, last_failure_at = NULL, last_error = NULL,
             disabled_at = NULL, updated_at = excluded.updated_at`,
        )
        .run({
          agent_key: agentKey,
          hook_id: hookId,
          url: url.url,
          auth_mode: authMode,
          secret_sealed: seal(plain, this.key, this.context(agentKey, hookId)),
          include_broadcasts: settings.includeBroadcasts ? 1 : 0,
          types: types ? JSON.stringify(types) : null,
          min_priority: settings.minPriority,
          now,
        });
    });
    write.immediate();

    this.activity?.logAsync({
      action: "webhook_set",
      entity_type: "agent",
      entity_id: agentKey,
      // Never the URL: a trigger URL is often half a secret, and the log is
      // shown to everyone who signs in to the dashboard.
      summary: `Webhook of "${this.nameOf(agentKey) ?? agentKey}" set (${authMode})`,
      agent_name: actor,
    });
    return { view: this.get(agentKey)!, ...(generatedSecret ? { generatedSecret } : {}) };
  }

  get(agentKey: string): WebhookView | null {
    const row = this.db.prepare("SELECT * FROM agent_webhooks WHERE agent_key = ?").get(agentKey) as Row | undefined;
    if (!row) return null;
    const pending = this.db
      .prepare(
        `SELECT d.attempts, d.due_at, (SELECT COUNT(*) FROM webhook_delivery_messages m WHERE m.delivery_id = d.id) AS messages
           FROM webhook_deliveries d WHERE d.agent_key = ? ORDER BY d.due_at LIMIT 1`,
      )
      .get(agentKey) as { attempts: number; due_at: number; messages: number } | undefined;
    return {
      ...statusOf(row),
      url: row.url,
      auth_mode: row.auth_mode,
      include_broadcasts: row.include_broadcasts === 1,
      types: row.types ? (JSON.parse(row.types) as string[]) : null,
      min_priority: row.min_priority,
      consecutive_failures: row.consecutive_failures,
      last_error: row.last_error,
      disabled_at: row.disabled_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
      pending: pending ? { messages: pending.messages, attempts: pending.attempts, due_at: new Date(pending.due_at).toISOString() } : null,
    };
  }

  delete(agentKey: string, actor: string): boolean {
    const name = this.nameOf(agentKey);
    const removed = this.db.prepare("DELETE FROM agent_webhooks WHERE agent_key = ?").run(agentKey).changes > 0;
    if (removed) {
      this.activity?.logAsync({
        action: "webhook_deleted",
        entity_type: "agent",
        entity_id: agentKey,
        summary: `Webhook of "${name ?? agentKey}" removed`,
        agent_name: actor,
      });
    }
    return removed;
  }

  /** Every hook's state, by inbox key: for `mesh_status`. */
  statuses(): Map<string, WebhookStatus> {
    const rows = this.db.prepare("SELECT agent_key, state, last_success_at, last_failure_at FROM agent_webhooks").all() as
      (Pick<Row, "agent_key" | "state" | "last_success_at" | "last_failure_at">)[];
    return new Map(rows.map((r) => [r.agent_key, statusOf(r)]));
  }

  /** What one call of the hook of `agentKey` needs, or null when there is
   *  nothing to call: no hook, a hook switched off, or a deactivated agent. */
  material(agentKey: string): WebhookMaterial | null {
    const row = this.db
      .prepare(
        `SELECT h.agent_key, h.hook_id, h.url, h.auth_mode, h.secret_sealed, a.name
           FROM agent_webhooks h JOIN agents a ON a.inbox_key = h.agent_key
          WHERE h.agent_key = ? AND h.state = 'active' AND a.is_active = 1`,
      )
      .get(agentKey) as (Pick<Row, "agent_key" | "hook_id" | "url" | "auth_mode" | "secret_sealed"> & { name: string }) | undefined;
    if (!row) return null;
    return {
      agentName: row.name,
      url: row.url,
      authMode: row.auth_mode,
      secret: open(row.secret_sealed, this.key, this.context(row.agent_key, row.hook_id)),
    };
  }

  private nameOf(agentKey: string): string | null {
    const row = this.db.prepare("SELECT name FROM agents WHERE inbox_key = ?").get(agentKey) as { name: string } | undefined;
    return row?.name ?? null;
  }
}
