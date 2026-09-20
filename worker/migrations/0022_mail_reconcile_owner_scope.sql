-- Reconciliation belongs to ONE owner: the person whose mailbox it is.
--
-- 0021 keyed the state on a grant label and matched mail against `applications`
-- with no user filter at all. The first production run found the fault
-- immediately: two Pinecone confirmations reported `confirmed: 2` against an
-- owner who has no Pinecone application, because the query was free to match
-- any identity's rows — including the e2e test user's.
--
-- Mail addressed to matthaeus@hadoku.me is evidence about HIS applications and
-- nobody else's. Scoping it is not tidiness; an unscoped match writes a
-- confirmation onto a row the mail says nothing about, which is precisely the
-- fabricated-evidence failure this feature exists to prevent.
--
-- Both tables are rebuilt rather than ALTERed with a default, because there is
-- no correct backfill value: rows written by the unscoped run cannot be
-- attributed after the fact, and inventing an owner for them would preserve the
-- bad data under a name that looks deliberate. Dropping them is honest — the
-- feed is re-readable from its first message, so a reset re-derives everything.

DROP TABLE IF EXISTS mail_reconcile_state;
DROP TABLE IF EXISTS mail_unmatched;

CREATE TABLE mail_reconcile_state (
	user_id TEXT PRIMARY KEY,
	cursor TEXT,
	last_run_at TEXT NOT NULL,
	messages_seen INTEGER NOT NULL DEFAULT 0,
	matched INTEGER NOT NULL DEFAULT 0,
	unmatched INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE mail_unmatched (
	user_id TEXT NOT NULL,
	message_id TEXT NOT NULL,
	received_at TEXT NOT NULL,
	from_domain TEXT NOT NULL,
	subject TEXT NOT NULL,
	company TEXT,
	kind TEXT NOT NULL CHECK (kind IN ('confirmation', 'verification', 'other')),
	possible_duplicate_of TEXT,
	seen_at TEXT NOT NULL,
	PRIMARY KEY (user_id, message_id)
);

CREATE INDEX idx_mail_unmatched_company ON mail_unmatched (user_id, company, received_at);
