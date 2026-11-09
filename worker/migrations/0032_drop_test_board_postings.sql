-- Drop the postings of known ATS test boards (worker/src/testBoards.ts):
-- LinkedIn's own Greenhouse and Lever tenants, which hold only LinkedIn's
-- integration tests ("Bug Bash Job …", "EA Test - Most Questions",
-- "SJ_TEST_LEVER_ATTACHMENT", 76 rows on 2026-11-09). Ingest and
-- POST /jobs/import refuse them from now on; this removes what is already
-- stored.
--
-- Only rows nobody has touched: a posting someone tracks, voted on, queued or
-- logged a timeline row for stays, as the daily cull spares it. job_profile_rank,
-- job_profile_matches, job_states and job_events cascade on delete; applications
-- and job_feedback have no foreign key, so they are checked explicitly.
DELETE FROM jobs
WHERE (
		(ats = 'greenhouse' AND LOWER(slug) = 'linkedin')
		OR (ats = 'lever' AND LOWER(slug) = 'linkedin')
		OR url LIKE 'https://job-boards.greenhouse.io/linkedin/%'
		OR url LIKE 'https://boards.greenhouse.io/linkedin/%'
		OR url LIKE 'https://jobs.lever.co/linkedin/%'
	)
	AND NOT EXISTS (SELECT 1 FROM job_states s WHERE s.job_id = jobs.id)
	AND NOT EXISTS (SELECT 1 FROM job_feedback f WHERE f.job_id = jobs.id)
	AND NOT EXISTS (SELECT 1 FROM applications a WHERE a.job_id = jobs.id)
	AND NOT EXISTS (SELECT 1 FROM job_events e WHERE e.job_id = jobs.id);
