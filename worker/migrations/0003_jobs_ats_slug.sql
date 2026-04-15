-- Add (ats, slug) to jobs so we can join to user_companies for per-user filtering.
--
-- Derived from job.url at ingest time via parseAtsSlug() — see worker/src/slugParse.ts.
-- Nullable because not every URL matches a known pattern; unmatched rows are
-- excluded from mine=true queries and can be backfilled later.

ALTER TABLE jobs ADD COLUMN ats TEXT;
ALTER TABLE jobs ADD COLUMN slug TEXT;

CREATE INDEX IF NOT EXISTS idx_jobs_ats_slug ON jobs(ats, slug);
