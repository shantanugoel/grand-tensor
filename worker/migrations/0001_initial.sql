-- One submitted series. The payload is kept whole because ratings are re-derived
-- from it on every read, so the method can change without migrating anything.
CREATE TABLE submissions (
  id TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL UNIQUE,
  protocol TEXT NOT NULL,
  app_version TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  model_a TEXT NOT NULL,
  effort_a TEXT NOT NULL,
  model_b TEXT NOT NULL,
  effort_b TEXT NOT NULL,
  -- Doubled so half-points stay integers: 2 per win, 1 per draw, over 2-10 games.
  score_a_x2 INTEGER NOT NULL CHECK (score_a_x2 BETWEEN 0 AND 20),
  score_b_x2 INTEGER NOT NULL CHECK (score_b_x2 BETWEEN 0 AND 20),
  wins_a INTEGER NOT NULL,
  draws_a INTEGER NOT NULL,
  losses_a INTEGER NOT NULL,
  -- Even, because colors alternate from game one: an odd series would hand the
  -- model in slot 0 an extra White, and the rating fit has no color term to
  -- correct for it. Mirrors isRankedGameCount in src/leaderboard-protocol.ts.
  games INTEGER NOT NULL CHECK (games BETWEEN 2 AND 10 AND games % 2 = 0),
  payload_json TEXT NOT NULL,
  install_hash TEXT NOT NULL,
  network_hash TEXT NOT NULL,
  pair_hash TEXT NOT NULL,
  delete_hash TEXT NOT NULL
);

-- Standings read one circuit's whole window; the quota checks are conditions on
-- the insert, so both of their lookups are on this hot path too.
CREATE INDEX submissions_protocol_created ON submissions(protocol, created_at);
CREATE INDEX submissions_install_pair_created ON submissions(install_hash, pair_hash, created_at);
CREATE INDEX submissions_network_created ON submissions(network_hash, created_at);
