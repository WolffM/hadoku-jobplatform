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
	// Ingest auth (scraper → worker)
	// ============================================================================

	/** Shared secret for hadoku-scrape webhook callbacks. Checked via X-User-Key header. */
	JOBPLATFORM_INGEST_KEY?: string;

	// ============================================================================
	// Database
	// ============================================================================

	/** D1 database — declared in hadoku_site wrangler.toml as [[d1_databases]] */
	JOB_PLATFORM_DB: D1Database;
}
