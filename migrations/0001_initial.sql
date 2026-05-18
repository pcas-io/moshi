CREATE TABLE IF NOT EXISTS agents (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  role         TEXT,
  capabilities TEXT,
  token_hash   TEXT NOT NULL,
  is_active    INTEGER NOT NULL DEFAULT 1,
  working_on   TEXT,
  last_seen_at TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agents_token_hash ON agents(token_hash);
CREATE INDEX IF NOT EXISTS idx_agents_active ON agents(is_active);

CREATE TABLE IF NOT EXISTS messages (
  id             TEXT PRIMARY KEY,
  from_agent     TEXT NOT NULL,
  to_agent       TEXT NOT NULL,
  type           TEXT NOT NULL,
  payload        TEXT NOT NULL,
  context        TEXT NOT NULL,
  correlation_id TEXT,
  reply_to       TEXT,
  priority       TEXT NOT NULL DEFAULT 'normal',
  ttl_seconds    INTEGER NOT NULL DEFAULT 86400,
  created_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_correlation ON messages(correlation_id);
CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(to_agent);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at);

CREATE TABLE IF NOT EXISTS activity_log (
  id          TEXT PRIMARY KEY,
  action      TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  summary     TEXT,
  agent_name  TEXT,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_activity_created ON activity_log(created_at);
