-- View defaults a profile carries for the feed (JobPulse's search profiles had
-- them): where to centre the near= filter and how far, the salary floor to
-- filter by, whether postings with no listed salary stay, and US-only.
--
-- These are DEFAULTS a UI passes to GET /jobs (near / radius_miles /
-- min_salary). They are not scoring criteria: scoring.ts never reads them and
-- rank.ts's criteriaHash leaves them out, so editing one never invalidates or
-- rebuilds the precomputed ranking (job_profile_rank). `salary_floor`, which
-- IS scored, is a different column.
ALTER TABLE profiles ADD COLUMN location TEXT;
ALTER TABLE profiles ADD COLUMN radius_miles INTEGER NOT NULL DEFAULT 25;
ALTER TABLE profiles ADD COLUMN min_salary INTEGER;
ALTER TABLE profiles ADD COLUMN include_undisclosed_salary INTEGER NOT NULL DEFAULT 1;
ALTER TABLE profiles ADD COLUMN us_only INTEGER NOT NULL DEFAULT 0;
