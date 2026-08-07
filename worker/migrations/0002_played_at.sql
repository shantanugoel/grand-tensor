-- A result is now dated by when the match was played, not when it reached the
-- server. Those used to be the same thing only because a run ticket expired in
-- six hours; a match that finished while nobody was at the keyboard could not be
-- submitted at all. With that deadline gone, upload time says nothing about when
-- the games happened, so the standings window needs its own column.
--
-- `created_at` stays, and stays as upload time: the daily quotas are an abuse
-- control on the submitting browser and network, so they have to be counted on
-- the axis the submitter moves in real time, not on a timestamp that a stale
-- ticket can push into the past.
ALTER TABLE submissions ADD COLUMN played_at INTEGER NOT NULL DEFAULT 0;
UPDATE submissions SET played_at = created_at WHERE played_at = 0;

-- Standings and entrant records read one circuit's window whole, now by play time.
CREATE INDEX submissions_protocol_played ON submissions(protocol, played_at);
DROP INDEX submissions_protocol_created;

-- Withdrawal is gone. It existed to undo a misclick within fifteen minutes, which
-- is exactly the window that stopped being reachable once submitting moved hours
-- after the match; keeping a delete path that only ever fires late would have made
-- it a way to curate a record instead. A result now stands once it is submitted,
-- and the honest way to not submit one is not to submit it.
ALTER TABLE submissions DROP COLUMN delete_hash;
