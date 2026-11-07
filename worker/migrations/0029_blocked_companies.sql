-- Companies a person never wants in their feed (from the JobPulse merge, where
-- it was a localStorage list on one machine).
--
-- Keyed by LOWER(TRIM(company)), computed in SQL on both sides — at insert and
-- in the feed's NOT EXISTS — so the key and the comparison cannot disagree
-- about case folding (SQLite's LOWER folds ASCII only; doing it in JS on one
-- side would not match the other for a non-ASCII name). `company` keeps the
-- spelling the person blocked, for display.
--
-- A filter on the feed only: a blocked employer's postings stay in the shared
-- corpus, and anything already in the person's pipeline stays there.
CREATE TABLE IF NOT EXISTS blocked_companies (
	user_id TEXT NOT NULL,
	company_key TEXT NOT NULL,
	company TEXT NOT NULL,
	created_at TEXT NOT NULL,
	PRIMARY KEY (user_id, company_key)
);
