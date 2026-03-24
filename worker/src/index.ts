/**
 * Job Platform Worker Package
 *
 * Exports factory functions for Cloudflare Workers.
 * The host worker in hadoku_site imports these and delegates to them.
 *
 * @example
 * ```typescript
 * // In hadoku_site/workers/jobplatform-api/src/index.ts
 * import { createFetchHandler, createScheduledHandler } from '@wolffm/jobplatform-worker';
 *
 * export default {
 *   async fetch(request, env) {
 *     return createFetchHandler(env)(request);
 *   },
 *   scheduled(event, env, ctx) {
 *     ctx.waitUntil(createScheduledHandler(env)(event.cron));
 *   },
 * };
 * ```
 */

import { OpenAPIHono } from '@hono/zod-openapi';
import { cors } from 'hono/cors';
import {
	createHadokuAuth,
	wrappedValidationHook,
	createErrorHandlers,
	createOpenAPIDocConfig,
	DEFAULT_HADOKU_ORIGINS,
	type HadokuAuthContext,
} from '@wolffm/worker-utils';
import type { AppEnv } from './types.js';
import { healthRoutes } from './routes/health.js';
import { exampleRoutes } from './routes/example.js';

// ============================================================================
// App Context
// ============================================================================

interface AppContext {
	Bindings: AppEnv;
	Variables: {
		authContext: HadokuAuthContext;
	};
}

// ============================================================================
// Create Hono App
// ============================================================================

function createApp() {
	const app = new OpenAPIHono<AppContext>({
		defaultHook: wrappedValidationHook,
	});

	// --------------------------------------------------------------------------
	// Middleware Stack
	// --------------------------------------------------------------------------

	// 1. CORS Middleware - Allow hadoku.me origins
	app.use(
		'*',
		cors({
			origin: DEFAULT_HADOKU_ORIGINS,
			allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
			allowHeaders: ['Content-Type', 'X-User-Key', 'X-API-Key', 'X-Session-Id'],
			credentials: true,
			maxAge: 86400,
		})
	);

	// 2. Authentication Middleware
	app.use('*', createHadokuAuth());

	// --------------------------------------------------------------------------
	// Route Registration
	// --------------------------------------------------------------------------

	// Health check (public)
	app.route('/', healthRoutes);

	// Example CRUD routes (mounted at /api/jobplatform)
	app.route('/api/jobplatform', exampleRoutes);

	// --------------------------------------------------------------------------
	// OpenAPI Spec Endpoint
	// --------------------------------------------------------------------------

	app.doc(
		'/api/jobplatform/openapi.json',
		createOpenAPIDocConfig({
			title: 'Job Platform API',
			version: '1.0.0',
			description: `
API for Job Platform.

## Authentication
- **Public endpoints**: Health check and read operations
- **Protected endpoints**: Write operations require X-User-Key header
- **Admin endpoints**: Delete operations require admin authentication

## Usage
See the endpoint documentation below for details on each operation.
			`,
			production: 'https://jobplatform-api.hadoku.workers.dev',
			tags: [
				{ name: 'Health', description: 'Health check endpoints' },
				{ name: 'Items', description: 'Example CRUD operations' },
			],
		})
	);

	// --------------------------------------------------------------------------
	// Error Handlers
	// --------------------------------------------------------------------------

	const { notFoundHandler, errorHandler } = createErrorHandlers('wrapped');
	app.notFound(notFoundHandler);
	app.onError(errorHandler);

	return app;
}

// ============================================================================
// Exported Factory Functions
// ============================================================================

/**
 * Create the fetch handler for HTTP requests.
 *
 * @param env - Worker environment bindings
 * @returns Request handler function
 */
export function createFetchHandler(env: AppEnv) {
	const app = createApp();
	return (request: Request) => app.fetch(request, env);
}

/**
 * Create the scheduled handler for cron jobs.
 *
 * @param env - Worker environment bindings
 * @returns Cron handler function
 */
export function createScheduledHandler(_env: AppEnv) {
	return (cron: string) => {
		console.log(`[jobplatform-worker] Scheduled task: ${cron}`);

		// Add your scheduled task logic here
		// Example:
		// if (cron === '0 */8 * * *') {
		//   await syncData(env);
		// }
	};
}

// ============================================================================
// Re-exports
// ============================================================================

export type { AppEnv } from './types.js';
export * from './schemas.js';
