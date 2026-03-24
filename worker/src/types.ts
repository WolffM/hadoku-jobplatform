/**
 * Environment bindings for Job Platform Worker
 *
 * This interface defines all the bindings and secrets available to your worker.
 * Update this based on what your app needs (D1, KV, Durable Objects, etc.)
 */
export interface AppEnv {
	// ============================================================================
	// Authentication (parsed by @wolffm/worker-utils)
	// ============================================================================

	/** JSON array of admin API keys - full access */
	ADMIN_KEYS?: string;

	/** JSON array of friend API keys - limited access */
	FRIEND_KEYS?: string;

	// ============================================================================
	// Service-specific secrets
	// ============================================================================

	/** API key for service-to-service calls (e.g., from trader-api) */
	JOB_PLATFORM_API_KEY?: string;

	// ============================================================================
	// Optional: Database Bindings (uncomment if needed)
	// ============================================================================

	// /** D1 Database binding - requires [[d1_databases]] in wrangler.toml */
	// JOB_PLATFORM_DB?: D1Database;

	// /** KV Namespace binding - requires [[kv_namespaces]] in wrangler.toml */
	// JOB_PLATFORM_KV?: KVNamespace;

	// ============================================================================
	// Optional: External Service URLs
	// ============================================================================

	// /** URL to external service tunnel (e.g., local Python service) */
	// TUNNEL_URL?: string;
}
