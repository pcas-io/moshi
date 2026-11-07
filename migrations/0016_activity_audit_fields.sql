-- The agent lifecycle as an audit that can be found again (ocellio e49547b8).
--
-- An audit row named its ACTOR only (`agent_name`). "What happened to agent
-- X" could not be asked: the operator creates, renames, revokes and deletes,
-- so every row about X carried "admin", and the Log's `?agent=` filter found
-- none of them. Four columns, all nullable, written by `ActivityService.log`
-- for the events that know them (services/agent.ts, services/registration.ts,
-- services/presence.ts, services/webhooks.ts):
--
--   target_key  the inbox key of the agent the row is ABOUT. A key, not a
--               name: a name is a label and passes to another agent after a
--               delete, the key never changes (CLAUDE.md).
--   origin      where the action came from: dashboard | admin_api | register
--               | connect | presence.
--   ip_hash     the client address as `hashIP` (src/auth.ts) makes it, the
--               same function as `registration_audit.ip_hash`.
--   detail_json {"old": …, "new": …} where a value changed (rename, profile,
--               registration token); never a token, never a secret.
--
-- The rows themselves stay as they were written. The one backfill below fills
-- the NEW column of rows that are about an agent by its id (`entity_id` of an
-- `agent_*` row is `agents.id`, which never passes to another agent), and only
-- where that agent still exists. A deleted agent's old rows keep NULL.

ALTER TABLE activity_log ADD COLUMN target_key TEXT;
ALTER TABLE activity_log ADD COLUMN origin TEXT;
ALTER TABLE activity_log ADD COLUMN ip_hash TEXT;
ALTER TABLE activity_log ADD COLUMN detail_json TEXT;

UPDATE activity_log
   SET target_key = (SELECT a.inbox_key FROM agents a WHERE a.id = activity_log.entity_id)
 WHERE target_key IS NULL
   AND entity_type = 'agent'
   AND substr(action, 1, 6) = 'agent_';

CREATE INDEX IF NOT EXISTS idx_activity_target ON activity_log(target_key, created_at);
