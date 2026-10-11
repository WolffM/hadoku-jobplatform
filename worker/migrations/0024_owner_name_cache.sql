-- Remembered owner-name resolutions, so the apply runner's five-minute tick
-- stops costing a full key-registry scan at edge-router (issue #23).
--
-- An in-isolate Map was tried first and measured useless: requests 20s apart
-- landed on different isolates, so every tick still missed. Rows here are
-- edge-resolved answers with an expiry, never a name stored as an identity:
-- callers still pass a NAME, and a row past expires_at is ignored.
CREATE TABLE IF NOT EXISTS owner_name_cache (
	name_key TEXT PRIMARY KEY, -- trimmed, lowercased: how the registry matches
	user_id TEXT NOT NULL,
	name TEXT,
	tier TEXT,
	expires_at INTEGER NOT NULL -- ms epoch
);
