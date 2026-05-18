CREATE TABLE IF NOT EXISTS oauth_tokens (
  code       TEXT PRIMARY KEY,
  token      TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_oauth_tokens_expires ON oauth_tokens(expires_at);
