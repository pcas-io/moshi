-- Who a message is for, and who has read it.
--
-- to_key: the recipient's inbox key, its immutable address; '' for a
--         broadcast; NULL for every row from before this migration, and for
--         what an older release writes in a deploy overlap. `to_agent` is a
--         label: a rename rewrites part of the history, and a name can be
--         given to another agent after a delete. mesh_inbox shows rows with
--         a key only: a NULL row has no reads and would look unread for ever.
--
-- message_reads: one row per message and reader, written when mesh_receive
--         hands the message out. mesh_receive acks before its answer has
--         reached the agent; when that answer is lost the message is gone
--         from the broker, and this is what mesh_inbox finds it by. Keyed by
--         the reader's inbox key, because a broadcast has many readers. It
--         has no foreign key: a message can be delivered while its history
--         row could not be written, and its read still has to be known, so
--         that a repeated send (same id) is not handed out twice.
--
-- send_attempts: every send, recorded BEFORE it is published, and removed
--         once the history has its row. A send whose outcome is unknown (the
--         broker did not answer) can be repeated under its id; the repeat has
--         to match this record, and the envelope is rebuilt from it. Without
--         the record any agent that had seen the id could publish under it
--         and have the history row written from ITS draft. Not an outbox:
--         nothing retries a row here.
--
-- idx_activity_entity: "is there a message_expired row for this message
--         already?" is asked once per expired message.
-- idx_activity_once: one such row per message and actor, whoever notices
--         first, also across two processes on one volume.
--
-- idx_messages_to_created: the broadcast half of an inbox, newest first.
--
-- A release from before this migration keeps working on this schema: it
-- leaves to_key NULL and writes no reads. What it stores in the meantime is
-- not in mesh_inbox afterwards, direct mail and broadcasts alike.
BEGIN;
ALTER TABLE messages ADD COLUMN to_key TEXT;
CREATE INDEX IF NOT EXISTS idx_messages_to_key ON messages(to_key, created_at);

CREATE TABLE IF NOT EXISTS message_reads (
  message_id TEXT NOT NULL,
  reader_key TEXT NOT NULL,
  read_at    TEXT NOT NULL,
  PRIMARY KEY (message_id, reader_key)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_message_reads_read_at ON message_reads(read_at);

CREATE TABLE IF NOT EXISTS send_attempts (
  message_id     TEXT PRIMARY KEY,
  from_key       TEXT NOT NULL,
  from_agent     TEXT NOT NULL,
  to_agent       TEXT NOT NULL,
  to_key         TEXT,
  subject        TEXT NOT NULL,
  type           TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  context        TEXT NOT NULL,
  correlation_id TEXT,
  reply_to       TEXT,
  priority       TEXT NOT NULL,
  ttl_seconds    INTEGER NOT NULL,
  created_at     TEXT NOT NULL
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_send_attempts_created ON send_attempts(created_at);

CREATE INDEX IF NOT EXISTS idx_activity_entity ON activity_log(entity_id, action);
CREATE UNIQUE INDEX IF NOT EXISTS idx_activity_once ON activity_log(entity_id, action, agent_name)
  WHERE action IN ('message_expired', 'message_dead_letter', 'read_not_recorded');
CREATE INDEX IF NOT EXISTS idx_messages_to_created ON messages(to_agent, created_at);
COMMIT;
