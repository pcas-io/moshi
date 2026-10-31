-- How often a hook may be called, and when it last was.
--
-- min_interval_seconds: the least time between two calls of this hook. A
--         Claude Code routine starts a whole session on every call, which
--         draws on the operator's subscription, and takes at most 30 calls an
--         hour; the operator chooses how often. NULL means the default of the
--         hook's kind (src/services/webhooks.ts, `intervalFor`): every hook
--         from before this migration keeps behaving as it did.
-- last_call_at: when the dispatcher last took a delivery of this hook (ms).
--         The next delivery is not due before last_call_at + the interval.
--
-- A release from before this migration ignores both columns.
BEGIN;
ALTER TABLE agent_webhooks ADD COLUMN min_interval_seconds INTEGER;
ALTER TABLE agent_webhooks ADD COLUMN last_call_at INTEGER;
COMMIT;
