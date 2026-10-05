-- The applicant's own facts — name, contact, links, education, work history —
-- per user, so something other than the runner's machine can fill a form.
--
-- Until 2026-10-04 these lived only in the scraper's local
-- config/applicant-profile.json. Every board we apply through flags or
-- code-checks an automated browser, so the owner now fills forms in their own
-- Chrome with an extension, which needs these facts from somewhere it can
-- reach. One JSON document per user: the shape is the runner's
-- ApplicantProfile and is read whole, never queried by field.
CREATE TABLE IF NOT EXISTS applicant_profiles (
	user_id TEXT PRIMARY KEY,
	profile TEXT NOT NULL,
	updated_at TEXT NOT NULL
);
