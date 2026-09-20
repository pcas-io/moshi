-- Where a message sits in the stream, and whose it is.
--
-- stream_seq: the JetStream sequence from the broker's publish ack.
-- from_key:   the sender's inbox key, its immutable address. A name is a
--             label: it can be given to another agent, and a rename rewrites
--             only part of the history.
--
-- With both, inbox_pending can tell an agent's OWN broadcasts apart. They
-- come back to its broadcast consumer like everybody else's, the broker's
-- pending count includes them, and mesh_receive never hands them out.
--
-- NULL for everything sent before this migration. Those rows are never
-- subtracted from a count.
BEGIN;
ALTER TABLE messages ADD COLUMN stream_seq INTEGER;
ALTER TABLE messages ADD COLUMN from_key TEXT;

-- "my broadcasts behind position N": small, and exactly that question.
CREATE INDEX IF NOT EXISTS idx_messages_own_broadcast
  ON messages(from_key, stream_seq) WHERE to_agent = 'broadcast';
COMMIT;
