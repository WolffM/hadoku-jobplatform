-- Owner feedback on postings: one vote per (user, job), with an axis-aligned
-- reason. Tier 1: feed multiplies voted jobs directly. Tier 2 mines reasons
-- into profile interest/stack lists. Tier 3 fits per-profile scoring weights
-- from accumulated votes. `processed_at` marks votes already consumed by the
-- tier-2/3 batch so re-runs are incremental.
CREATE TABLE job_feedback (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	job_id TEXT NOT NULL,
	vote INTEGER NOT NULL CHECK (vote IN (1, -1)),
	reason TEXT,
	created_at TEXT NOT NULL,
	processed_at TEXT,
	UNIQUE (user_id, job_id)
);
CREATE INDEX idx_job_feedback_user ON job_feedback(user_id);
