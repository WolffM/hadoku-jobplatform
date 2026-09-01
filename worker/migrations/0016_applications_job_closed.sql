-- A posting that closed before the runner reached it is not a failure and not
-- a task: the job is gone, nobody can act on the URL, and there is nothing to
-- retry. Filing those under needs_manual turns the owner's review queue —
-- whose entire job is "these need you" — into a list mostly of things nobody
-- can do anything about.
--
-- SQLite cannot alter a CHECK constraint, so the table is rebuilt. Column list
-- is 0014 plus 0015's approved_fingerprint; the copy is explicit rather than
-- SELECT * so a column added between then and now fails loudly here instead of
-- being silently dropped.
CREATE TABLE applications_new (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	job_id TEXT NOT NULL,
	variant_slug TEXT NOT NULL,
	mode TEXT NOT NULL DEFAULT 'review' CHECK (mode IN ('review', 'auto')),
	status TEXT NOT NULL DEFAULT 'queued' CHECK (
		status IN (
			'queued', 'filled', 'approved', 'submitted',
			'needs_manual', 'failed', 'job_closed'
		)
	),
	error TEXT,
	evidence TEXT,
	approved_fingerprint TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	UNIQUE (user_id, job_id)
);

INSERT INTO applications_new (
	id, user_id, job_id, variant_slug, mode, status, error, evidence,
	approved_fingerprint, created_at, updated_at
)
SELECT id, user_id, job_id, variant_slug, mode, status, error, evidence,
       approved_fingerprint, created_at, updated_at
FROM applications;

DROP TABLE applications;

ALTER TABLE applications_new RENAME TO applications;

CREATE INDEX idx_applications_status ON applications(status);
