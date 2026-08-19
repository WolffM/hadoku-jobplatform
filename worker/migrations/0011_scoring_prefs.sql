-- Scoring overhaul v2 (2026-08-19): the feed needed axes the profile could not
-- express — comp floor, tech stack, domain interests. All default to neutral so
-- existing profiles score exactly as before until seeded.
ALTER TABLE profiles ADD COLUMN salary_floor INTEGER;
ALTER TABLE profiles ADD COLUMN stack TEXT NOT NULL DEFAULT '[]';
ALTER TABLE profiles ADD COLUMN interests_like TEXT NOT NULL DEFAULT '[]';
ALTER TABLE profiles ADD COLUMN interests_avoid TEXT NOT NULL DEFAULT '[]';
