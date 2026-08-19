/**
 * Job routes.
 *
 * Split by concern, but assembled here in ONE explicit order because route
 * resolution depends on it: OpenAPIHono matches in registration order, so
 * `/jobs/preflight` has to be registered before the `/jobs/{id}` param route or
 * the param route captures "preflight" as an id. Do not reorder these calls;
 * tests/routes/jobsDetail.test.ts fails if you do.
 */
import { OpenAPIHono } from '@hono/zod-openapi';
import type { RouteContext } from './shared.js';
import { registerFeedRoute } from './feed.js';
import { registerPreflightRoute } from './preflight.js';
import { registerDetailRoute } from './detail.js';
import { registerStateRoutes } from './state.js';
import { registerFeedbackRoutes } from './feedback.js';
import { registerTailoringRoutes } from './tailoring.js';

const app = new OpenAPIHono<RouteContext>();

registerFeedRoute(app);
registerPreflightRoute(app); // before the param route below — see above
registerDetailRoute(app);
registerStateRoutes(app);
registerFeedbackRoutes(app);
registerTailoringRoutes(app);

export const jobRoutes = app;
