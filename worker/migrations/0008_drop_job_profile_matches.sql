-- WS1: scores are computed on read (see worker/src/routes/jobs.ts), not
-- precomputed. The precompute table was the source of the all-0.00 feed: jobs
-- were ingested before any profile existed, and the one-time backfill rescore
-- (load-every-job) failed silently and never retried. Drop it — nothing reads
-- or writes it any more.
DROP INDEX IF EXISTS idx_matches_profile_score;
DROP INDEX IF EXISTS idx_matches_profile_date;
DROP TABLE IF EXISTS job_profile_matches;
