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
-- Nullable, and backfilled only where a name resolves to ONE agent that held
-- it when the row was written: an agent that was renamed or deleted since
-- keeps its old rows without a key. That is no worse than before this column,
-- where those rows are already unreachable by name.
--
-- The column is about the READER of a dead letter and about nothing else.
-- `message_expired` records the SENDER in `agent_name`, so filling it there
-- too would make the column mean two different things depending on the row.

ALTER TABLE activity_log ADD COLUMN agent_key TEXT;

-- Only for the one action the column is about, and only where the name is
-- UNAMBIGUOUS at the moment the row was written. `agents.name_since` says
-- when the agent took the name it has today; before that the same name may
-- have belonged to a different agent, which is exactly why `rename()` bounds
-- its own history rewrite by it (services/agent.ts). Resolving by the current
-- name alone lands a row on whoever holds the name NOW — demonstrated: an
-- agent renamed bob -> alice while another took the freed name got its
-- dead-letter row attributed to that other agent.
UPDATE activity_log
   SET agent_key = (
     SELECT a.inbox_key FROM agents a
      WHERE a.name = activity_log.agent_name COLLATE NOCASE
        AND COALESCE(a.name_since, a.created_at) <= activity_log.created_at
   )
 WHERE agent_key IS NULL
   AND agent_name IS NOT NULL
   AND action = 'message_dead_letter';

-- "Is there a row of this action for this message and this reader?" —
-- `idx_activity_entity` (entity_id, action) already answers the first half;
-- this one carries the reader, so the lookup inside the bounded `unread`
-- count stays an index seek.
CREATE INDEX IF NOT EXISTS idx_activity_actor ON activity_log(entity_id, action, agent_key);
