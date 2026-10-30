-- Outgoing webhooks: one per agent, called when mail for it arrives.
--
-- agent_webhooks: the hook of one agent, by its inbox key (the address, which
--         never changes; a name is a label). `secret_sealed` is the signing
--         secret or bearer key, AES-256-GCM under a key derived from
--         OAUTH_SECRET (src/services/webhooks.ts): HMAC needs the secret
--         itself, so a hash would not do. `hook_id` is new on every set and
--         is part of what the seal authenticates, so a sealed secret cannot
--         be moved to another row. `types` is a JSON array or NULL (all).
--         `state` is 'active' or 'disabled'; five failed deliveries in a row
--         disable a hook, and setting it again enables it.
--
-- webhook_deliveries: one call that is due or under way. The first matching
--         message opens one for the agent and `due_at` is thirty seconds
--         later; everything that arrives before the call goes into the same
--         one (the partial unique index: one OPEN delivery per agent). The
--         dispatcher closes it when it takes it (`closed_at`), so a message
--         after that opens the next one. `lease_until` is how a process says
--         "mine": two containers share the volume during a deploy, and the
--         claim is one UPDATE. The id is the `webhook-id` the receiver
--         deduplicates on, the same for every attempt.
--
-- webhook_delivery_messages: what a delivery announces, as it was when the
--         message was sent. Metadata only: never a payload, never a context.
--         Copied here instead of read from `messages`, because a message can
--         be delivered while its history row could not be written.
--
-- Deleting an agent deletes its hook, and a hook its deliveries.
BEGIN;
CREATE TABLE IF NOT EXISTS agent_webhooks (
  agent_key            TEXT PRIMARY KEY REFERENCES agents(inbox_key) ON DELETE CASCADE,
  hook_id              TEXT NOT NULL,
  url                  TEXT NOT NULL,
  auth_mode            TEXT NOT NULL CHECK (auth_mode IN ('standard_webhooks', 'bearer')),
  secret_sealed        TEXT NOT NULL,
  include_broadcasts   INTEGER NOT NULL DEFAULT 0,
  types                TEXT,
  min_priority         TEXT NOT NULL DEFAULT 'low' CHECK (min_priority IN ('low', 'normal', 'high')),
  state                TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'disabled')),
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_success_at      TEXT,
  last_failure_at      TEXT,
  last_error           TEXT,
  disabled_at          TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_agent_webhooks_broadcast ON agent_webhooks(include_broadcasts, state);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id          TEXT PRIMARY KEY,
  agent_key   TEXT NOT NULL REFERENCES agent_webhooks(agent_key) ON DELETE CASCADE,
  due_at      INTEGER NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER,
  closed_at   INTEGER,
  created_at  TEXT NOT NULL
) WITHOUT ROWID;
CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_deliveries_open ON webhook_deliveries(agent_key) WHERE closed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_due ON webhook_deliveries(due_at);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_agent ON webhook_deliveries(agent_key);

CREATE TABLE IF NOT EXISTS webhook_delivery_messages (
  delivery_id    TEXT NOT NULL REFERENCES webhook_deliveries(id) ON DELETE CASCADE,
  message_id     TEXT NOT NULL,
  from_agent     TEXT NOT NULL,
  to_agent       TEXT NOT NULL,
  type           TEXT NOT NULL,
  priority       TEXT NOT NULL,
  correlation_id TEXT,
  created_at     TEXT NOT NULL,
  PRIMARY KEY (delivery_id, message_id)
) WITHOUT ROWID;
COMMIT;
