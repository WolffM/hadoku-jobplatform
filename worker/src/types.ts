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

	/**
	 * Service-tier key for scraper outbound (sent as X-User-Key, NOT Bearer —
	 * scraper backend dropped Bearer support 2026-05-05). Set via
	 * `python scripts/administration.py cloudflare-secrets jobplatform-api`,
	 * which pulls the value from vault key JOBPLATFORM_SCRAPER_KEY.
	 */
	SCRAPER_USER_KEY?: string;

	/** Override scraper base URL (default https://scraper.hadoku.me). Optional. */
	SCRAPER_BASE_URL?: string;
}
