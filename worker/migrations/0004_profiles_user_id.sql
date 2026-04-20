-- V2 readiness: scope profiles per-user.
--
-- Production profiles table is empty at migration time (verified 2026-04-19),
-- and job_profile_matches is empty by consequence (FK + no scoring has run).
-- Safe to drop & recreate for a real NOT NULL user_id column.
--
-- user_id is sha256(credential).slice(0, 16) — same opaque id used by
-- user_companies. Raw credentials never enter D1.

DROP TABLE IF EXISTS profiles;

CREATE TABLE profiles (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	name TEXT NOT NULL,
	keywords TEXT NOT NULL DEFAULT '[]',
	target_companies TEXT NOT NULL DEFAULT '[]',
	role_types TEXT NOT NULL DEFAULT '[]',
	min_salary INTEGER,
	remote_pref TEXT NOT NULL DEFAULT 'any',
	experience_levels TEXT NOT NULL DEFAULT '[]',
	created_at TEXT NOT NULL
);

CREATE INDEX idx_profiles_user ON profiles(user_id);
