-- Approve-to-apply queue (issue #15): one row per (user, job) the owner
-- explicitly queued for the PC-side form runner. The human clicking Apply IS
-- the consent step — the runner only ever drains this table, it never picks
-- jobs itself.
--
-- Lifecycle: queued → (runner fills the ATS form) → filled → (owner approves
-- the screenshot, review mode only) → approved → (runner submits) → submitted.
-- Terminal failure states: needs_manual (captcha / novel question / DOM
-- drift — deep link + screenshot, never a silent skip) and failed.
-- mode 'auto' skips the filled/approved pause and submits in one pass.
--
-- variant_slug pins WHICH minted packet goes out, copied from the caller's
-- job_states row at queue time so a later re-tailor cannot silently change an
-- in-flight application. evidence is a JSON blob (screenshot paths etc.)
-- written by the runner alongside status transitions.
CREATE TABLE applications (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	job_id TEXT NOT NULL,
	variant_slug TEXT NOT NULL,
	mode TEXT NOT NULL DEFAULT 'review' CHECK (mode IN ('review', 'auto')),
	status TEXT NOT NULL DEFAULT 'queued' CHECK (
		status IN ('queued', 'filled', 'approved', 'submitted', 'needs_manual', 'failed')
	),
	error TEXT,
	evidence TEXT,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	UNIQUE (user_id, job_id)
);
CREATE INDEX idx_applications_status ON applications(status);
