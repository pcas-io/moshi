-- Who an audit row is ABOUT, by address instead of by label.
--
-- `activity_log.agent_name` holds a name, and a name is a label. A rename
-- rewrites `messages.from_agent` and `messages.to_agent` (services/agent.ts)
-- and leaves every audit row exactly as it was. Two things hang off that
-- lookup and both drifted:
--
--   * `recordDeadLetter` asks whether it has already written a row for this
--     message and this reader. Asked by name, the answer after a rename is
--     "no", and the broker's next advisory wrote a second row for the same
--     message.
--   * `unread` in `mesh_inbox` has to stop counting a message the broker has
--     given up on — it will never be handed out again, and an agent that
--     loops on `unread > 0` spins on it. Subtracting by name would stop
--     working at the same moment.
--
-- The inbox key never changes (CLAUDE.md: a name is a label, the inbox key is
-- the address), so it is what both ask by.
--
-- Nullable, and backfilled only where a name still resolves: an agent that
-- was renamed or deleted since keeps its old rows without a key. That is no
-- worse than today, where those rows are already unreachable by name.

ALTER TABLE activity_log ADD COLUMN agent_key TEXT;

UPDATE activity_log
   SET agent_key = (SELECT a.inbox_key FROM agents a WHERE a.name = activity_log.agent_name COLLATE NOCASE)
 WHERE agent_key IS NULL
   AND agent_name IS NOT NULL;

-- "Is there a row of this action for this message and this reader?" —
-- `idx_activity_entity` (entity_id, action) already answers the first half;
-- this one carries the reader, so the lookup inside the bounded `unread`
-- count stays an index seek.
CREATE INDEX IF NOT EXISTS idx_activity_actor ON activity_log(entity_id, action, agent_key);
