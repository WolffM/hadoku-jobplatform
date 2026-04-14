-- User company subscriptions (V1)
--
-- Each row: one user is subscribed to one resolved scraper target.
-- A single display_name (e.g. "Stripe") may resolve to multiple targets
-- (e.g. greenhouse + lever) and produce multiple rows under one user.
--
-- user_id is sha256(credential).slice(0, 16) — opaque, stable, never raw.

CREATE TABLE IF NOT EXISTS user_companies (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL,
	target_id INTEGER NOT NULL,        -- scraper TargetView.id
	ats TEXT NOT NULL,                  -- 'greenhouse'|'lever'|'linkedin'|'ashby'
	slug TEXT NOT NULL,
	display_name TEXT NOT NULL,         -- what the user typed
	added_at TEXT NOT NULL,
	UNIQUE(user_id, target_id)
);

CREATE INDEX IF NOT EXISTS idx_user_companies_user ON user_companies(user_id);
CREATE INDEX IF NOT EXISTS idx_user_companies_target ON user_companies(target_id);
