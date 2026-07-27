-- Split the old one-dimensional `role_types` into the two axes it was
-- conflating: TRACK (does the job have direct reports?) and LEVEL (where it
-- sits on that track's ladder).
--
-- `role_types` was a flat OR-list of six title substrings — 'senior', 'staff',
-- 'principal', 'lead', 'manager', 'director' — matched against the title and
-- scored hit/miss. 'senior' and 'manager' are not alternatives to each other,
-- so the only expressible query was "any of these words appears", and a Senior
-- Engineering Manager scored identically to a Senior Engineer.
--
-- Also drops two dead columns:
--   min_salary       — salary is a view filter now, not a scoring criterion.
--                      It was 0.06 of the score and returned a neutral 0.5
--                      whenever salary_min was NULL, which is most postings.
--   experience_levels — round-tripped through every read/write since 0001 and
--                      never once read by the scorer. Its default value was a
--                      verbatim copy of role_types.

-- ── jobs: classified at ingest (worker/src/roleClassify.ts) ─────────────────
-- 'unknown' only for a blank title; every real title resolves to ic/manager.
-- Existing rows start 'unknown' and are filled by POST /ingest/backfill-roles.
ALTER TABLE jobs ADD COLUMN role_track TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE jobs ADD COLUMN role_level TEXT;

CREATE INDEX IF NOT EXISTS idx_jobs_role_track ON jobs(role_track);

-- ── profiles: track + levels replace role_types ─────────────────────────────
ALTER TABLE profiles ADD COLUMN track TEXT NOT NULL DEFAULT 'either';
ALTER TABLE profiles ADD COLUMN levels TEXT NOT NULL DEFAULT '[]';

-- Translate existing selections. A profile that picked both sides of the old
-- list ('senior' AND 'manager') really did want both tracks, so it becomes
-- 'either' rather than arbitrarily picking one. An empty role_types stays
-- 'either' — no constraint expressed, no constraint invented.
UPDATE profiles SET track = CASE
	WHEN (role_types LIKE '%"manager"%' OR role_types LIKE '%"director"%')
	 AND (role_types LIKE '%"senior"%' OR role_types LIKE '%"staff"%' OR role_types LIKE '%"principal"%')
		THEN 'either'
	WHEN (role_types LIKE '%"manager"%' OR role_types LIKE '%"director"%')
		THEN 'manager'
	WHEN (role_types LIKE '%"senior"%' OR role_types LIKE '%"staff"%' OR role_types LIKE '%"principal"%')
		THEN 'ic'
	ELSE 'either'
END;

-- Map the old tokens onto the new ladders. 'lead' is dropped deliberately: it
-- was never a level, and it's the one title that can't be bucketed from the
-- word alone (Tech Lead is an IC, Engineering Lead usually isn't) — the job
-- classifier resolves it per-posting from the description instead.
-- The surviving tokens are named identically on the new ladders, so this is a
-- filter rather than a remap.
UPDATE profiles SET levels = COALESCE(
	(
		SELECT json_group_array(je.value)
		FROM json_each(profiles.role_types) je
		WHERE je.value IN ('senior', 'staff', 'principal', 'manager', 'director')
	),
	'[]'
);

ALTER TABLE profiles DROP COLUMN role_types;
ALTER TABLE profiles DROP COLUMN min_salary;
ALTER TABLE profiles DROP COLUMN experience_levels;
