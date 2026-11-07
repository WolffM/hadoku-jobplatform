-- V5 pipeline: what happens to an application after it is sent.
--
-- job_states already says where a posting stands for one person. V5 adds the
-- states past "applied" (interviewing / offered / rejected — the column is
-- free TEXT by design, see 0005, so those are a code-only change), the facts a
-- person tracks per application, and an append-only timeline.
--
-- The tracking columns live on job_states rather than a table of their own
-- because they mean nothing without a state: a posting is in someone's
-- pipeline exactly when it has a job_states row, and that row is also what
-- makes the posting immune to the daily cull (ingest.ts cullExpired), so a
-- listing that closes while you are interviewing stays readable.
--
--   priority      1 high · 2 normal · 3 low; NULL = unset
--   follow_up_at  the date (YYYY-MM-DD) the person means to chase it
--   contact_name / contact_email
--                 the recruiter or hiring manager, as the person wrote it down
ALTER TABLE job_states ADD COLUMN priority INTEGER;
ALTER TABLE job_states ADD COLUMN follow_up_at TEXT;
ALTER TABLE job_states ADD COLUMN contact_name TEXT;
ALTER TABLE job_states ADD COLUMN contact_email TEXT;

-- The timeline. One row per thing that happened, never updated:
--
--   kind = 'state'      written by PUT /jobs/:id/state when the state CHANGES
--                       (from_state → to_state; from_state NULL = was new)
--   kind = 'note' | 'interview' | 'contact' | 'follow_up'
--                       written by the person (POST /jobs/:id/events), with
--                       occurred_at as they give it — an interview logged the
--                       evening after happened that morning.
--
-- Only person-written rows can be deleted; a state row is the record of a
-- transition and goes only with the job or the person (erase hook).
CREATE TABLE IF NOT EXISTS job_events (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	job_id TEXT NOT NULL,
	user_id TEXT NOT NULL,
	kind TEXT NOT NULL,
	from_state TEXT,
	to_state TEXT,
	note TEXT,
	occurred_at TEXT NOT NULL,
	created_at TEXT NOT NULL,
	FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
);

-- One job's timeline, and the cascade from jobs (job_id leads neither of the
-- other two, and an unindexed cascade is what 0027 had to fix).
CREATE INDEX IF NOT EXISTS idx_job_events_job ON job_events(job_id, user_id, occurred_at);
-- Insights: one person's transitions over time.
CREATE INDEX IF NOT EXISTS idx_job_events_user ON job_events(user_id, kind, occurred_at);
