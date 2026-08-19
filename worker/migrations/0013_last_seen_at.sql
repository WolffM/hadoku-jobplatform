-- Liveness tracking: last_seen_at bumps every time a scrape still lists the
-- posting (ingest re-encounters its URL). A board job whose last_seen_at stops
-- moving has closed; keyword-feed jobs age out by posted date. Backfilled to
-- first-seen so nothing starts artificially stale.
ALTER TABLE jobs ADD COLUMN last_seen_at TEXT;
UPDATE jobs SET last_seen_at = scraped_at WHERE last_seen_at IS NULL;
