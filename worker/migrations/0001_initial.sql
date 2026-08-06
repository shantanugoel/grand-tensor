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
  score_a_x2 INTEGER NOT NULL CHECK (score_a_x2 BETWEEN 0 AND 8),
  score_b_x2 INTEGER NOT NULL CHECK (score_b_x2 BETWEEN 0 AND 8),
  wins_a INTEGER NOT NULL,
  draws_a INTEGER NOT NULL,
  losses_a INTEGER NOT NULL,
  games INTEGER NOT NULL CHECK (games = 4),
  payload_json TEXT NOT NULL,
  install_hash TEXT NOT NULL,
  network_hash TEXT NOT NULL,
  pair_hash TEXT NOT NULL,
  delete_hash TEXT NOT NULL
);

CREATE INDEX submissions_protocol_created ON submissions(protocol, created_at);
CREATE INDEX submissions_install_pair_created ON submissions(install_hash, pair_hash, created_at);
CREATE INDEX submissions_network_created ON submissions(network_hash, created_at);
