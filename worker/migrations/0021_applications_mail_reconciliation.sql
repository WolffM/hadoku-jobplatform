-- Mail reconciliation: what the INBOX says about an application, kept apart
-- from what the runner says about it.
--
-- The whole point of this feature is that these two can disagree. On
-- 2026-09-19 the queue reported zero applications sent while a Pinecone
-- confirmation sat in the mailbox for an application it had no row for, so
-- these columns are deliberately NOT folded into `status`: `status` is the
-- runner's account of itself, and overwriting it with mail evidence would
-- destroy the very disagreement worth seeing.
--
-- Two different facts, because for our corpus they are genuinely different:
--
--   confirmed_at              an employer said it RECEIVED an application.
--                             Ashby does this. Greenhouse never has.
--
--   verification_requested_at an employer mailed a code and is waiting on a
--                             human. Every Greenhouse mail this mailbox has
--                             ever received is one of these, and all 37
--                             applications are Greenhouse — so for us this is
--                             the common case, not the edge case.
--
-- There is deliberately NO column for the code itself. See
-- docs/DECISION-mail-reconciler.md: a code mail sets state and its contents are
-- never parsed, stored, logged or displayed. Adding a column here would be the
-- first half of answering an anti-bot challenge on the owner's behalf.

ALTER TABLE applications ADD COLUMN confirmed_at TEXT;
ALTER TABLE applications ADD COLUMN confirmation_source TEXT;
ALTER TABLE applications ADD COLUMN verification_requested_at TEXT;

-- The reconciler's own progress marker, so a re-run is incremental rather than
-- a full replay of the mailbox. One row per grant label ('jobplatform').
--
-- `cursor` is the feed's opaque (created_at, id) cursor and is the ONLY thing
-- that decides where the next poll starts. `last_run_at` and the counters are
-- for a human reading the table; nothing branches on them.
CREATE TABLE IF NOT EXISTS mail_reconcile_state (
	label TEXT PRIMARY KEY,
	cursor TEXT,
	last_run_at TEXT NOT NULL,
	messages_seen INTEGER NOT NULL DEFAULT 0,
	matched INTEGER NOT NULL DEFAULT 0,
	unmatched INTEGER NOT NULL DEFAULT 0
);

-- Mail that named an employer we have no application for.
--
-- This table IS the feature. A confirmation with no application row is exactly
-- the Pinecone case — an application the system did not know existed — and
-- dropping those on the floor would rebuild the blind spot this was built to
-- close. Kept as its own table rather than as orphan `applications` rows
-- because we often cannot tell WHICH posting was applied to: an Ashby
-- confirmation names the company and, measured, no role at all.
--
-- `body` is not stored. Subject and sender are what matching needs, and a
-- local copy of message bodies would be a second place the owner's mail lives.
CREATE TABLE IF NOT EXISTS mail_unmatched (
	message_id TEXT PRIMARY KEY,
	received_at TEXT NOT NULL,
	from_domain TEXT NOT NULL,
	subject TEXT NOT NULL,
	company TEXT,
	kind TEXT NOT NULL CHECK (kind IN ('confirmation', 'verification', 'other')),
	-- Two mails, same company, minutes apart, generic identical bodies: could be
	-- two applications or one double-send. Flagged, never guessed — inventing an
	-- application the owner never made is the same phantom row this feature
	-- exists to eliminate.
	possible_duplicate_of TEXT,
	seen_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mail_unmatched_company ON mail_unmatched (company, received_at);
