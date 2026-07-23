-- Default profile with per-user copy-on-write + tombstone.
--
-- Every user sees a shared default profile (seeded from code) even with zero
-- rows. Editing it copies it into a real per-user `profiles` row flagged
-- is_default=1 (copy-on-write) — the edit is local to that user and never
-- touches the code seed or anyone else. Deleting it writes a tombstone so the
-- factory default does not reappear for that user.
--
-- Both changes are additive: is_default defaults to 0 (existing rows are
-- ordinary profiles), and the tombstone table starts empty.

ALTER TABLE profiles ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0;

-- One row per (user, tombstoned key). Only key='default' is used today, but the
-- shape generalizes to any future seeded-then-deletable resource.
CREATE TABLE IF NOT EXISTS profile_tombstones (
	user_id TEXT NOT NULL,
	profile_key TEXT NOT NULL,
	created_at TEXT NOT NULL,
	PRIMARY KEY (user_id, profile_key)
);

-- Fast "does this user have a default copy?" lookup.
CREATE INDEX IF NOT EXISTS idx_profiles_user_default ON profiles(user_id, is_default);
