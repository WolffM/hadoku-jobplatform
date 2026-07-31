-- Application-kit: remember which minted packet was sent with an application.
--
-- When the owner marks a job "applied" after preparing the kit, we stash the
-- resume-api variant slug (the shareable packet link) on the state row, so the
-- record of what was actually sent survives. Nullable — a job can be marked
-- applied without a packet, and every existing row predates this column.
ALTER TABLE job_states ADD COLUMN variant_slug TEXT;
