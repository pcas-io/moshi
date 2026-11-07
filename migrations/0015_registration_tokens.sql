-- Registration tokens: a narrow token that can only create agents
-- (ADR ocellio 06aef68e; Tech-CIO criteria 1-8). For machines that must not
-- hold the admin token, e.g. a customer's, where mesh-cockpit registers its
-- agents.
--
-- registration_tokens: one token. The secret is shown once, at creation, and
--         stored only as a scrypt hash with its own salt (`secret_hash`,
--         `salt`); the token's id is part of the plaintext, so a request finds
--         its row without trying every hash. `name_prefix`, when set, is the
--         start every agent name created with it must have (e.g. "anna-").
--         `expires_at` (ISO, optional) and `revoked_at` end it. `max_per_hour`
--         is a hard cap on agents created with it per rolling hour, counted
--         from the audit rows, so it holds across restarts and containers.
--
-- registration_audit: every attempt to create an agent with a registration
--         token, also the refused ones: which token (NULL when it could not
--         be identified), the requested name, the result, a hashed client IP.
BEGIN;
CREATE TABLE IF NOT EXISTS registration_tokens (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  salt TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  name_prefix TEXT,
  expires_at TEXT,
  max_per_hour INTEGER NOT NULL DEFAULT 10,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  revoked_at TEXT
);
CREATE TABLE IF NOT EXISTS registration_audit (
  id TEXT PRIMARY KEY,
  token_id TEXT,
  name TEXT,
  result TEXT NOT NULL,
  ip_hash TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_registration_audit_token ON registration_audit (token_id, result, created_at);
COMMIT;
