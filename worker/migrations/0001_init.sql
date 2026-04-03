-- Job Platform D1 Schema

CREATE TABLE IF NOT EXISTS profiles (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	keywords TEXT NOT NULL DEFAULT '[]',        -- JSON string[]
	target_companies TEXT NOT NULL DEFAULT '[]', -- JSON string[]
	role_types TEXT NOT NULL DEFAULT '[]',       -- JSON string[]
	min_salary INTEGER,
	remote_pref TEXT NOT NULL DEFAULT 'any',     -- 'remote'|'hybrid'|'onsite'|'any'
	experience_levels TEXT NOT NULL DEFAULT '[]',-- JSON string[]
	created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
	id TEXT PRIMARY KEY,                -- e.g. "greenhouse_5099202008"
	url TEXT NOT NULL,
	source_site TEXT NOT NULL,
	title TEXT NOT NULL,
	company TEXT NOT NULL,
	location TEXT NOT NULL,
	job_type TEXT NOT NULL DEFAULT 'unknown',
	workplace_type TEXT NOT NULL DEFAULT 'unknown', -- 'remote'|'hybrid'|'onsite'|'unknown'
	salary_min REAL,
	salary_max REAL,
	description TEXT NOT NULL DEFAULT '',
	posted_date TEXT,
	application_url TEXT,
	department TEXT,
	scraper_used TEXT,
	raw TEXT NOT NULL DEFAULT '{}',     -- full original payload JSON
	scraped_at TEXT NOT NULL,
	run_id TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_url ON jobs(url);
CREATE INDEX IF NOT EXISTS idx_jobs_company ON jobs(company);
CREATE INDEX IF NOT EXISTS idx_jobs_scraped_at ON jobs(scraped_at DESC);

CREATE TABLE IF NOT EXISTS job_profile_matches (
	job_id TEXT NOT NULL,
	profile_id TEXT NOT NULL,
	score REAL NOT NULL,
	score_breakdown TEXT NOT NULL DEFAULT '{}', -- JSON ScoreBreakdown
	matched_at TEXT NOT NULL,
	PRIMARY KEY (job_id, profile_id),
	FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE,
	FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_matches_profile_score ON job_profile_matches(profile_id, score DESC);
CREATE INDEX IF NOT EXISTS idx_matches_profile_date ON job_profile_matches(profile_id, matched_at DESC);
