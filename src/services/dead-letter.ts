// A message the broker has given up on. A durable hands a message out at
// most `max_deliver` times (five); when none of them was acked, the message
// stays in the stream and is never delivered to that agent again. The broker
// says so once, on an advisory subject, to whoever listens. Nobody did.
//
// mesh_receive acks what it returns, so this is rare: a process that died
// between fetch and ack five times over, or a fetch whose messages were never
// returned. Rare and silent is the combination worth an audit row. The
// message is not lost to the agent: mesh_inbox reads the history.
//
// Pure: parsing and the audit row. The subscription lives in NatsService.

import type Database from "better-sqlite3";
import type { ActivityService } from "./activity.js";

const STREAM_NAME = "MESH_MESSAGES";
export const DEAD_LETTER_SUBJECT = `$JS.EVENT.ADVISORY.CONSUMER.MAX_DELIVERIES.${STREAM_NAME}.*`;
export const MESSAGE_DEAD_LETTER = "message_dead_letter";

export interface DeadLetter {
  /** The durable that gave up: `agent-<key>` or `agent-<key>-broadcast`. */
  consumer: string;
  streamSeq: number;
  deliveries: number;
}

const decoder = new TextDecoder();

/** The advisory's body, or null when it is none. Never throws. */
export function parseDeadLetter(data: Uint8Array): DeadLetter | null {
  let body: unknown;
  try {
    body = JSON.parse(decoder.decode(data));
  } catch {
    return null;
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const { stream, consumer, stream_seq, deliveries } = body as Record<string, unknown>;
  if (stream !== STREAM_NAME) return null;
  if (typeof consumer !== "string" || consumer.length === 0) return null;
  if (typeof stream_seq !== "number" || !Number.isInteger(stream_seq) || stream_seq < 1) return null;
  if (typeof deliveries !== "number" || !Number.isFinite(deliveries)) return null;
  return { consumer, streamSeq: stream_seq, deliveries };
}

const DURABLE_PREFIX = "agent-";
const BROADCAST_SUFFIX = "-broadcast";

/** Whose durable it is. No inbox key ends in `-broadcast` (AgentService). */
function readerOf(consumer: string): { key: string; side: "inbox" | "broadcast" } | null {
  if (!consumer.startsWith(DURABLE_PREFIX)) return null;
  const rest = consumer.slice(DURABLE_PREFIX.length);
  if (rest.endsWith(BROADCAST_SUFFIX)) {
    const key = rest.slice(0, -BROADCAST_SUFFIX.length);
    return key ? { key, side: "broadcast" } : null;
  }
  return rest ? { key: rest, side: "inbox" } : null;
}

/**
 * One audit row per message and reader. False when there is one already, or
 * when the consumer is not an agent's.
 *
 * The message is looked up by its stream sequence AND by whom it was for:
 * SQLite and the stream are two volumes, and after a lost stream an old row
 * can carry the same sequence.
 */
export function recordDeadLetter(
  db: Database.Database,
  activity: Pick<ActivityService, "log">,
  letter: DeadLetter,
  /** When the stream the sequence belongs to was created. After a lost NATS
   *  volume the sequences start again, and the history keeps the old rows:
   *  a row from before the stream cannot be the message. */
  streamCreated: string | null = null,
): boolean {
  const reader = readerOf(letter.consumer);
  if (!reader) return false;

  const agent = db.prepare("SELECT name FROM agents WHERE inbox_key = ?").get(reader.key) as { name: string } | undefined;
  const name = agent?.name ?? reader.key;

  const notBefore = streamCreated ?? "";
  const message = (
    reader.side === "broadcast"
      ? db.prepare("SELECT id, from_agent FROM messages WHERE stream_seq = ? AND to_agent = 'broadcast' AND created_at >= ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(letter.streamSeq, notBefore)
      : db
          .prepare(
            `SELECT id, from_agent FROM messages
              WHERE stream_seq = ? AND created_at >= ? AND (to_key = ? OR (to_key IS NULL AND to_agent = ? COLLATE NOCASE))
              ORDER BY created_at DESC, rowid DESC LIMIT 1`,
          )
          .get(letter.streamSeq, notBefore, reader.key, name)
  ) as { id: string; from_agent: string } | undefined;

  const entityId = message?.id ?? `seq:${letter.streamSeq}`;
  const noted = db
    .prepare("SELECT 1 FROM activity_log WHERE entity_id = ? AND action = ? AND agent_name = ?")
    .get(entityId, MESSAGE_DEAD_LETTER, name);
  if (noted) return false;

  const what = message ? `${message.id} from ${message.from_agent}` : `a message (stream sequence ${letter.streamSeq})`;
  const tail = message ? "mesh_inbox still shows it." : "The history has no row for it.";
  try {
    activity.log({
      action: MESSAGE_DEAD_LETTER,
      entity_type: "message",
      entity_id: entityId,
      summary: `${name} was handed ${what} ${letter.deliveries} times and never acknowledged it; the broker has stopped delivering it. ${tail}`,
      agent_name: name,
    });
  } catch (err) {
    // Another process wrote it between the check and the insert: the unique
    // index (migration 0010) says so. Anything else goes up.
    if (/UNIQUE/.test(String(err))) return false;
    throw err;
  }
  return true;
}
