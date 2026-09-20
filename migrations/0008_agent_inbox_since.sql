-- From when on the stream's messages are for this agent.
--
-- A durable consumer created without a start position hands out everything
-- the stream still holds (DeliverAll): a brand-new agent began with a week of
-- other agents' broadcasts, and delete-and-recreate or revoke-and-reactivate
-- replayed what had already been read. New durables start at `inbox_since`
-- (deliver_policy by_start_time), so nothing that arrives between the
-- agent's creation and its first request is lost either.
--
-- Set at creation and at reactivation; a rename or a token reset leaves it
-- alone. It also tells whose an existing durable is: one that the broker
-- created before `inbox_since` was left behind by a predecessor with the same
-- inbox key (src/services/consumers.ts).
--
-- Existing agents get their creation time. Their durables were created after
-- that, on their first request, so every one of them is kept as it is.
BEGIN;
ALTER TABLE agents ADD COLUMN inbox_since TEXT;
UPDATE agents SET inbox_since = created_at WHERE inbox_since IS NULL;
COMMIT;
