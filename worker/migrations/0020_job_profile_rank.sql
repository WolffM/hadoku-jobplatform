-- The feed's sort key, made into a column so the feed can paginate in SQL.
--
-- GET /jobs?sort=score orders by a value computed in JavaScript from the
-- profile's criteria, and SQL cannot ORDER BY a number it does not have. So the
-- worker read the WHOLE table on every request, ranked it in memory, and
-- returned 25 rows: 31,748 rows and 14.77MB to render a page. Warm that is
-- ~465ms of SQL; cold — the first load after a few hours away, which is the
-- load the owner actually experiences — the same read faults in from storage
-- and takes 8.8s, past the edge's proxy budget, so the app fails outright.
--
-- `bound` is exactly scoreJobLightAxes().bound: the description-free upper
-- bound the light pass already computed per request. Storing it changes where
-- it is computed, not what it is. The description-dependent half of the score
-- (relevance, domain_interest) is still computed live in stage 2 over the
-- shortlist, so what the feed DISPLAYS still reflects the profile right now.
--
-- Derived data, and always safe to delete: the feed falls back to ranking live
-- whenever this is absent or stale, so losing it costs latency, never
-- correctness.
CREATE TABLE IF NOT EXISTS job_profile_rank (
	profile_id TEXT NOT NULL,
	job_id TEXT NOT NULL,
	-- The light-pass upper bound, 0..1.
	bound REAL NOT NULL,
	-- Whether the light pass found a hard floor violation (lowball comp,
	-- non-Americas remote, non-engineering discipline). The lens sorts exclude
	-- these, and recovering it later would need the profile's criteria again.
	penalized INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (profile_id, job_id),
	FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
);

-- The feed's access path: one profile's rows, best first, LIMIT N.
CREATE INDEX IF NOT EXISTS idx_job_profile_rank_order
	ON job_profile_rank(profile_id, bound DESC);

-- Whether a profile's ranking can be trusted. Serving a STALE order is worse
-- than being slow, because nothing on the page would say so — hence two
-- markers the feed checks before using the fast path, both O(1):
--
--   criteria_hash   fingerprint of the profile fields the bound is computed
--                   from. Renaming a profile does not invalidate; changing a
--                   keyword does. `profiles` has no updated_at to use instead.
--   max_job_rowid   the highest jobs.rowid this ranking covers. Reading
--                   MAX(rowid) costs one row (0.2ms); COUNT(*) reads all
--                   31,748. Ingest advances it after writing the new jobs'
--                   rank rows, so a crash between those two writes leaves the
--                   marker behind and the feed falls back rather than quietly
--                   omitting the newest postings.
CREATE TABLE IF NOT EXISTS job_profile_rank_state (
	profile_id TEXT PRIMARY KEY,
	criteria_hash TEXT NOT NULL,
	max_job_rowid INTEGER NOT NULL,
	built_at TEXT NOT NULL
);
