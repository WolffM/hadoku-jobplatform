-- Standing answers to application questions, learned once per user.
--
-- The form runner can only answer a question it has seen before. Every fill
-- already reports the ones it could not answer (they ride along in
-- applications.evidence as `unmatched`), but that was a dead end: the owner had
-- to read a CLI report and hand-edit a JSON file on the runner's machine, so in
-- practice the same question blocked application after application.
--
-- PRIVACY NOTE, because this reverses an explicit earlier decision.
-- hadoku-scrape's ApplicantProfile keeps demographic answers on the runner's
-- disk on purpose: "so they never travel through an API that a board, a proxy
-- or a log could see." Answers stored here DO cross the API and DO sit in D1.
-- That is the deliberate trade for having the site learn them, and it applies
-- only to answers the owner enters in the UI — nothing already in the local
-- file is migrated here, and the runner still reads that file.
--
-- question_key is the normalized question (see worker/src/questionKey.ts, which
-- mirrors hadoku_scrape/apply/_answers.py::normalize). Storing the key rather
-- than matching on raw text is what makes "Preferred Pronouns" and
-- "preferred pronouns *" the same question.
CREATE TABLE application_answers (
	user_id TEXT NOT NULL,
	question_key TEXT NOT NULL,
	-- The question as the board actually worded it, kept for display: the
	-- normalized key is unreadable, and the owner needs to recognise what they
	-- are answering.
	question TEXT NOT NULL,
	answer TEXT NOT NULL,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL,
	PRIMARY KEY (user_id, question_key)
);
