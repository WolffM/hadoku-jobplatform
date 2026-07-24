-- Companies become children of a profile (a "hiring slice" = its companies +
-- its role criteria), replacing the user-global user_companies model and the
-- profile's free-text target_companies field.
--
-- user_companies is left in place as harmless legacy (its scrape targets keep
-- running); nothing reads it after this. profiles.target_companies is likewise
-- deprecated in code (column kept to avoid a destructive rewrite).

CREATE TABLE IF NOT EXISTS profile_companies (
	id TEXT PRIMARY KEY,
	profile_id TEXT NOT NULL,
	ats TEXT NOT NULL,
	slug TEXT NOT NULL,
	display_name TEXT NOT NULL,
	target_id INTEGER,
	added_at TEXT NOT NULL,
	UNIQUE(profile_id, ats, slug)
);

CREATE INDEX IF NOT EXISTS idx_profile_companies_profile ON profile_companies(profile_id);
