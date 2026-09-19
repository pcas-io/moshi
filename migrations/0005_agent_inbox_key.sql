-- The agent's NATS address, split from its display name.
--
-- Subjects (`mesh.agents.<key>.inbox`) and durable consumer names
-- (`agent-<key>`, `agent-<key>-broadcast`) used to be derived from
-- `agents.name`, so renaming an agent moved it away from its own unread
-- mail. `inbox_key` is assigned once and never changes; the name becomes a
-- label. Existing agents keep exactly the address they have today
-- (`lower(name)`), so nothing moves inside the live JetStream stream.
--
-- `name_since` records when the agent took its current name. A rename
-- rewrites the names in the message history, and the rewrite must stop at
-- that moment: before it, the same name may have belonged to another,
-- since deleted agent — even during this agent's own lifetime.
--
-- Wrapped in a transaction so a failing statement leaves no half-applied
-- column behind.
BEGIN;
ALTER TABLE agents ADD COLUMN inbox_key TEXT;
ALTER TABLE agents ADD COLUMN name_since TEXT;
UPDATE agents SET inbox_key = lower(name) WHERE inbox_key IS NULL;
UPDATE agents SET name_since = created_at WHERE name_since IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_inbox_key ON agents(inbox_key);
COMMIT;
