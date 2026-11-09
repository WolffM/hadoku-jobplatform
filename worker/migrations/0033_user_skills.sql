-- A person's own skills list (GET/POST/DELETE /skills), the inventory
-- GET /jobs/:id/match compares a posting against. JobPulse kept it in local
-- SQLite; this makes it per-user in D1.
--
-- name_key is the vocabulary's canonical spelling (worker/src/skills.ts
-- canonicalSkill: "K8s" and "Kubernetes" are one skill), and is what a
-- posting's detected skills are matched on. One row per person per skill.
CREATE TABLE user_skills (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	user_id TEXT NOT NULL,
	name TEXT NOT NULL,
	name_key TEXT NOT NULL,
	category TEXT,
	proficiency TEXT NOT NULL DEFAULT 'intermediate'
		CHECK (proficiency IN ('beginner', 'intermediate', 'expert')),
	created_at TEXT NOT NULL,
	UNIQUE (user_id, name_key)
);
