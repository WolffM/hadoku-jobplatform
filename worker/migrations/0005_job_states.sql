-- V2 Triage State.
--
-- Per-user, per-job lifecycle for the triage flow. No row = "new" (implicit
-- default at read time). Every other state is materialised as a row keyed on
-- (job_id, user_id). user_id matches the opaque hash used by user_companies
-- and profiles: sha256(credential).slice(0, 16).
--
-- States covered in V2:
--   interested  user opted in from the card
--   dismissed   user opted out — usually hidden from the default list
--   saved       longer-term shortlist
--   applied     manually marked or set by V4 auto-apply
--
-- V5 will extend this with offered / rejected and add a parallel job_events
-- append-only log for full timeline history. We deliberately keep the state
-- column free-text (no CHECK constraint) so adding new states later is a
-- code-only change.
--
-- notes is reserved for V5 — V2 only sets/reads state, but the column lands
-- now to avoid a back-compat ALTER once the timeline UI starts writing free
-- text.

CREATE TABLE IF NOT EXISTS job_states (
	job_id TEXT NOT NULL,
	user_id TEXT NOT NULL,
	state TEXT NOT NULL,
	notes TEXT,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (job_id, user_id),
	FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_job_states_user ON job_states(user_id);
CREATE INDEX IF NOT EXISTS idx_job_states_user_state ON job_states(user_id, state);
