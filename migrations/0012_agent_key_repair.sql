-- Repairs what 0011's backfill wrote on a database where it has already run.
--
-- 0011 resolved `activity_log.agent_name` to an inbox key by the name the
-- agent holds TODAY. A name is a label and can pass from one agent to
-- another: rename A away and give its old name to B, and a row about A lands
-- on B. Reproduced with the real AgentService — a row with agent_name 'bob',
-- written while A (key `bob`) was called that, came out of the backfill with
-- agent_key `carol`, which is B.
--
-- What that costs, both ways: B is told `dead_lettered: true` about a
-- delivery to A, and `unread` stops counting a message for B that the broker
-- is still willing to deliver — "one too few hides mail". A, the agent the
-- row is about, goes on counting it, so the fix 0011 exists for does not
-- reach the one case it was written for.
--
-- Every key is checked against the rule `rename()` uses, and cleared where it
-- does not hold. That clears some keys that were right: once an agent is
-- renamed, the schema keeps only its current name, so a row naming an older
-- one can no longer be tied to it either way — not even one `recordDeadLetter`
-- wrote correctly. Clearing is the safe direction, and the window is one
-- deploy wide, because this runs once and nothing writes a key by lookup
-- afterwards.
--
-- A cleared key is exactly as reachable as it was before 0011: the code falls
-- back to the name, and `unread` counts that one message again, which is the
-- behaviour of the release before it. Keeping an unverifiable key would keep
-- the WRONG ones too, and a wrong one hides mail from one agent and shows it
-- another agent's failure. Nothing is guessed.
--
-- 0011 itself was corrected in the same change, so a database migrating from
-- scratch never gets a wrong key and this statement matches nothing there.

UPDATE activity_log
   SET agent_key = NULL
 WHERE agent_key IS NOT NULL
   AND (
     -- The column is about the reader of a dead letter. `message_expired`
     -- records the SENDER in `agent_name`, so a key there means the wrong
     -- person and is the next query's trap.
     action <> 'message_dead_letter'
     OR NOT EXISTS (
       SELECT 1 FROM agents a
        WHERE a.inbox_key = activity_log.agent_key
          AND a.name = activity_log.agent_name COLLATE NOCASE
          AND COALESCE(a.name_since, a.created_at) <= activity_log.created_at
     )
   );

-- The check in `recordDeadLetter` asks by key; this makes the schema hold the
-- same rule, so two processes on one volume cannot write two rows for one
-- message and one reader. `idx_activity_once` keys on the NAME and keeps
-- doing so for the rows that have no key.
CREATE UNIQUE INDEX IF NOT EXISTS idx_activity_once_key
  ON activity_log(entity_id, action, agent_key)
  WHERE action = 'message_dead_letter' AND agent_key IS NOT NULL;
