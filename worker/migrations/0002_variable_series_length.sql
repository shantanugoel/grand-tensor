-- Ranked series became a 2-10 game range instead of a fixed 4, so the CHECK
-- constraints that hard-coded four games and eight half-points have to widen.
-- SQLite cannot alter a CHECK in place, so the table is rebuilt.

CREATE TABLE submissions_new (
  id TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL UNIQUE,
  protocol TEXT NOT NULL,
  app_version TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  model_a TEXT NOT NULL,
  effort_a TEXT NOT NULL,
  model_b TEXT NOT NULL,
  effort_b TEXT NOT NULL,
  score_a_x2 INTEGER NOT NULL CHECK (score_a_x2 BETWEEN 0 AND 20),
  score_b_x2 INTEGER NOT NULL CHECK (score_b_x2 BETWEEN 0 AND 20),
  wins_a INTEGER NOT NULL,
  draws_a INTEGER NOT NULL,
  losses_a INTEGER NOT NULL,
  games INTEGER NOT NULL CHECK (games BETWEEN 2 AND 10),
  payload_json TEXT NOT NULL,
  install_hash TEXT NOT NULL,
  network_hash TEXT NOT NULL,
  pair_hash TEXT NOT NULL,
  delete_hash TEXT NOT NULL
);

INSERT INTO submissions_new SELECT * FROM submissions;

DROP TABLE submissions;

ALTER TABLE submissions_new RENAME TO submissions;

CREATE INDEX submissions_protocol_created ON submissions(protocol, created_at);
CREATE INDEX submissions_install_pair_created ON submissions(install_hash, pair_hash, created_at);
CREATE INDEX submissions_network_created ON submissions(network_hash, created_at);
