-- The agent's NATS address, split from its display name.
--
-- Subjects (`mesh.agents.<key>.inbox`) and durable consumer names
-- (`agent-<key>`, `agent-<key>-broadcast`) used to be derived from
-- `agents.name`, so renaming an agent moved it away from its own unread
-- mail. `inbox_key` is assigned once and never changes; the name becomes a
-- label. Existing agents keep exactly the address they have today
-- (`lower(name)`), so nothing moves inside the live JetStream stream.
--
-- Wrapped in a transaction because the migration runner applies a file and
-- records it in two separate steps.
BEGIN;
ALTER TABLE agents ADD COLUMN inbox_key TEXT;
UPDATE agents SET inbox_key = lower(name) WHERE inbox_key IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_inbox_key ON agents(inbox_key);
COMMIT;
