import type { D1Database, Fetcher } from '@cloudflare/workers-types';

export interface AppEnv {
	// ============================================================================
	// Authentication — edge-auth (createEdgeAuth verifies inbound X-Edge-Auth)
	// ============================================================================

	/** Edge provenance secret — createEdgeAuth verifies inbound X-Edge-Auth. */
	EDGE_AUTH_SECRET?: string;

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

	// ============================================================================
	// resume-bot service binding (V3 — tailored application packets)
	// ============================================================================

	/**
	 * Cloudflare service binding to the resume-api worker, declared in
	 * hadoku_site wrangler.toml as [[services]] binding="RESUME" service="resume-api".
	 * Bypasses the public edge; calls stamp X-Edge-Auth (= EDGE_AUTH_SECRET) +
	 * X-Hadoku-Tier: service so resume-api's in-worker gate admits them.
	 */
	RESUME?: Fetcher;

	// ============================================================================
	// edge-router service binding (identity — display name -> userId)
	// ============================================================================

	/**
	 * Service binding to edge-router, for ONE question: what userId does this
	 * display name belong to. Declared in hadoku_site wrangler.toml as
	 * [[services]] binding="EDGE" service="edge-router".
	 *
	 * NOT a SESSIONS_KV binding, which is how study, task and prefs answer the
	 * same question. That namespace is keyed `key:{rawKey}` — its KEYS are the
	 * fleet's credentials — and Workers KV has no prefix scoping and no
	 * read-only mode, so binding it here to resolve one name would hand this
	 * worker `list()` over every live key in the fleet, plus write access.
	 * Over the binding we learn one userId for one name we already knew.
	 */
	EDGE?: Fetcher;
}
