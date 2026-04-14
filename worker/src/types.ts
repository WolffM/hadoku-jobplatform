import type { D1Database } from '@cloudflare/workers-types';

export interface AppEnv {
	// ============================================================================
	// Authentication (parsed by @wolffm/worker-utils)
	// ============================================================================

	/** JSON array of admin API keys */
	ADMIN_KEYS?: string;

	/** JSON array of friend API keys */
	FRIEND_KEYS?: string;

	// ============================================================================
	// Database
	// ============================================================================

	/** D1 database — declared in hadoku_site wrangler.toml as [[d1_databases]] */
	JOB_PLATFORM_DB: D1Database;

	// ============================================================================
	// Scraper client (outbound to hadoku-scrape)
	// ============================================================================

	/** Bearer token for scraper API. Set via `python scripts/administration.py cloudflare-secrets`. */
	SCRAPER_API_KEY?: string;

	/** Override scraper base URL (default https://scraper.hadoku.me). Optional. */
	SCRAPER_BASE_URL?: string;
}
