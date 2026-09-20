-- A correlation id names a thread. mesh_send used to store whatever string it
-- was given, and two kinds of it cannot be named by a link:
--   ''          every such message fell into ONE thread with the id '',
--               and /conversations?id= means "no id"
--   ' topic-1 ' query strings get trimmed on the way in
-- createMessage normalises new ids the same way (src/services/message.ts).
-- Idempotent.

UPDATE messages SET correlation_id = NULL WHERE correlation_id IS NOT NULL AND TRIM(correlation_id) = '';
UPDATE messages SET correlation_id = TRIM(correlation_id) WHERE correlation_id IS NOT NULL AND correlation_id != TRIM(correlation_id);
