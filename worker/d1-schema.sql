CREATE TABLE IF NOT EXISTS relay_results (
  result_id TEXT PRIMARY KEY NOT NULL,
  ciphertext BLOB NOT NULL,
  iv BLOB NOT NULL,
  envelope_version TEXT NOT NULL,
  canonical_bytes INTEGER NOT NULL CHECK (canonical_bytes BETWEEN 1 AND 1048576),
  ciphertext_bytes INTEGER NOT NULL CHECK (ciphertext_bytes BETWEEN 17 AND 1052672),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS relay_results_expires_at_idx
  ON relay_results (expires_at);

CREATE INDEX IF NOT EXISTS relay_results_created_at_idx
  ON relay_results (created_at);

CREATE TRIGGER IF NOT EXISTS relay_results_immutable
BEFORE UPDATE ON relay_results
BEGIN
  SELECT RAISE(ABORT, 'relay result is immutable');
END;

