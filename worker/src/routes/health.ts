/**
 * Health check routes
 *
 * Public endpoint for monitoring service health.
 */

import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { HealthResponseSchema } from '../schemas.js';
import type { AppEnv } from '../types.js';

interface RouteContext {
	Bindings: AppEnv;
}

const app = new OpenAPIHono<RouteContext>();

// ============================================================================
// Health Check Endpoint
// ============================================================================

const healthRoute = createRoute({
	method: 'get',
	path: '/health',
	tags: ['Health'],
	summary: 'Health check',
	description: 'Returns the health status of the Job Platform API',
	responses: {
		200: {
			description: 'API is healthy',
			content: {
				'application/json': {
					schema: HealthResponseSchema,
				},
			},
		},
	},
});

app.openapi(healthRoute, (c) => {
	// Add any health checks here (DB connectivity, external services, etc.)
	// Example with D1:
	// try {
	//   await c.env.JOB_PLATFORM_DB.prepare('SELECT 1').first();
	//   dbOk = true;
	// } catch {
	//   dbOk = false;
	// }

	const status = 'healthy'; // or 'degraded' or 'unhealthy' based on checks

	return c.json(
		{
			status,
			service: 'jobplatform-worker' as const,
			timestamp: new Date().toISOString(),
		},
		200
	);
});

export const healthRoutes = app;
