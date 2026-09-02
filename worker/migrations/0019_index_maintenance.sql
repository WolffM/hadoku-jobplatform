-- Index maintenance on the two paths that carry the traffic: the scraper's
-- ingest webhook, and the feed.
--
-- Measured on production over 7 days (monitoring-api request logs + D1
-- sql_duration): POST /ingest ran 2,027 times and spent 620s in total. ~64% of
-- that was ONE query — the cull, which reads 31,271 rows and takes ~195ms per
-- call to delete, typically, two of them. It is also where the database's
-- background row-read volume was coming from: ~9M rows/day.
--
-- The cull cannot use an index today because it filters on a computed
-- expression, so SQLite has no choice but to scan:
--
--   WHERE MAX(COALESCE(posted_date,''), COALESCE(last_seen_at,''), scraped_at) < ?
--
-- SQLite will index an expression, and uses it only when the query's expression
-- has the same SHAPE as the index's. Formatting is free — whitespace and the
-- `j.` alias make no difference — but reordering the MAX arguments or dropping
-- a COALESCE does not match, and nothing fails when it stops matching: the cull
-- still returns the right rows, just by scanning again. So this must stay in
-- step with cullExpired() in routes/ingest.ts, and
-- worker/tests/routes/ingestCull.test.ts asserts the query plan so that drift
-- is caught rather than merely regretted.
CREATE INDEX IF NOT EXISTS idx_jobs_freshness ON jobs(
	MAX(COALESCE(posted_date, ''), COALESCE(last_seen_at, ''), scraped_at)
);

-- Every index is a write cost on the highest-volume write path, so the ones
-- that earn nothing come off. These three are strict PREFIXES of an index that
-- already exists, which SQLite can use for the same lookups:
--
--   idx_job_states_user(user_id)    ⊂ idx_job_states_user_state(user_id, state)
--   idx_job_feedback_user(user_id)  ⊂ UNIQUE(user_id, job_id)
--   idx_profiles_user(user_id)      ⊂ idx_profiles_user_default(user_id, is_default)
DROP INDEX IF EXISTS idx_job_states_user;
DROP INDEX IF EXISTS idx_job_feedback_user;
DROP INDEX IF EXISTS idx_profiles_user;

-- And this one is never read at all: `company` is SELECTed for display, but no
-- query in the worker filters, orders or groups by it. It was pure write cost
-- on every ingested posting.
DROP INDEX IF EXISTS idx_jobs_company;
