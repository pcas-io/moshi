-- Authorization codes, without anything readable in them.
--
-- oauth_tokens kept the bearer token in plaintext, under the code itself as
-- the key, until the exchange or (for an abandoned sign-in) the next cleanup.
-- The PKCE challenge was not stored at all: it travelled inside the code and
-- came back from the client, unsigned.
--
-- oauth_codes keeps
--   code_hash       SHA-256 of the code. The code exists only at the client.
--   token_sealed    the token, AES-256-GCM, under a key derived from the code
--                   AND the server secret. The file alone opens nothing, and
--                   neither does the file together with the secret.
--   code_challenge  the S256 challenge the code was issued for. The token
--                   endpoint verifies against THIS value.
--
-- Rows waiting in the old table are deleted. They live five minutes; a
-- sign-in that is under way during the deploy has to be started again.
--
-- The old TABLE stays for one release. The release before this one cannot
-- sign anybody in without it (HTTP 500 on POST /oauth/authorize), 0004 is
-- recorded as applied, so nothing would bring it back after a rollback, and
-- during a rolling deploy both releases share the file for a few seconds.
-- The new code never writes to it and empties it at start and every hour
-- (purgeLegacyOAuthTokens). A later migration drops it.
--
-- What SQL cannot do: the deleted bytes stay in the file until the page is
-- reused. initDatabase runs with secure_delete and rebuilds the file after a
-- migration (src/services/db.ts).
BEGIN;
DELETE FROM oauth_tokens;
CREATE TABLE oauth_codes (
  code_hash      TEXT PRIMARY KEY,
  token_sealed   TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  expires_at     INTEGER NOT NULL
);
CREATE INDEX idx_oauth_codes_expires ON oauth_codes(expires_at);
COMMIT;
