/**
 * Job Platform Worker
 *
 * Exports a Hono handler factory consumed by hadoku_site's host worker.
 *
 * @example
 * ```typescript
 * // hadoku_site/workers/jobplatform-api/src/index.ts
 * import { createJobPlatformHandler } from '@wolffm/jobplatform-worker';
 *
 * export default {
 *   fetch(request: Request, env: Env) {
 *     return createJobPlatformHandler('/jobplatform/api').fetch(request, env);
 *   },
 * };
 * ```
 */

import { OpenAPIHono } from '@hono/zod-openapi';
import { cors } from 'hono/cors';
import {
	createEdgeAuth,
	wrappedValidationHook,
	createErrorHandlers,
	createOpenAPIDocConfig,
	DEFAULT_HADOKU_ORIGINS,
	type HadokuAuthContext,
} from '@wolffm/worker-utils';
import type { ExecutionContext } from '@cloudflare/workers-types';
import type { AppEnv } from './types.js';
import { logger } from './logger.js';
import { healthRoutes } from './routes/health.js';
import { ingestRoutes } from './routes/ingest.js';
import { profileRoutes } from './routes/profiles.js';
import { jobRoutes } from './routes/jobs/index.js';
import { companyRoutes } from './routes/companies.js';

interface AppContext {
	Bindings: AppEnv;
	Variables: { authContext: HadokuAuthContext };
}

export function createJobPlatformHandler(basePath = '/jobplatform/api') {
	const app = new OpenAPIHono<AppContext>({
		defaultHook: wrappedValidationHook,
	}).basePath(basePath);

	app.use(
		'*',
		cors({
			origin: DEFAULT_HADOKU_ORIGINS,
			allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
			allowHeaders: ['Content-Type', 'X-User-Key', 'X-API-Key'],
			credentials: true,
			maxAge: 86400,
		})
	);

	// Edge-auth — trusts the edge-stamped tier (centralized auth channel)
	// instead of resolving keys in-worker. Drop-in for the removed createHadokuAuth;
	// attaches the same authContext. Inbound (browser/friend + scrape's ingest
	// webhook at hadoku.me/jobplatform/api/ingest) all arrives via the edge, so
	// X-Edge-Auth is stamped. The /ingest route's own admin||friend check stays.
	app.use('*', createEdgeAuth());

	app.route('/', healthRoutes);
	app.route('/', ingestRoutes);
	app.route('/', profileRoutes);
	app.route('/', jobRoutes);
	app.route('/', companyRoutes);

	app.doc(
		'/openapi.json',
		createOpenAPIDocConfig({
			title: 'Job Platform API',
			version: '1.0.0',
			description: 'Job aggregation and profile-based scoring API.',
			production: 'https://hadoku.me/jobplatform/api',
			tags: [
				{ name: 'Health', description: 'Health check' },
				{ name: 'Ingest', description: 'Scraper webhook receiver' },
				{ name: 'Profiles', description: 'Role profile management' },
				{ name: 'Jobs', description: 'Job listing queries' },
				{ name: 'Applications', description: 'Approve-to-apply queue for the form runner' },
				{ name: 'Companies', description: 'Per-user company subscriptions' },
			],
		})
	);

	const { notFoundHandler, errorHandler } = createErrorHandlers('wrapped');
	app.notFound(notFoundHandler);
	app.onError(errorHandler);

	return app;
}

// Keep legacy export shape so existing hadoku_site host worker compiles
// until it's updated to call createJobPlatformHandler directly.
//
// `ctx` is optional only so an old host keeps compiling; pass it. Without it
// Hono has no ExecutionContext, every `c.executionCtx?.waitUntil()` in this
// worker throws, and the background work behind it is left unattached — which
// on Workers means killed the moment the response returns. That is not a
// degraded mode, it is silent: the request succeeds and the work never runs.
// It is how the feed's lazy rank build and triggerSearchBg's scrape kick both
// did nothing in production while passing their tests.
export function createFetchHandler(env: AppEnv) {
	const app = createJobPlatformHandler();
	return (request: Request, ctx?: ExecutionContext) => app.fetch(request, env, ctx);
}

export function createScheduledHandler(_env: AppEnv) {
	return (cron: string) => {
		logger.info('scheduled task', { cron });
	};
}

export type { AppEnv } from './types.js';
export * from './schemas.js';
