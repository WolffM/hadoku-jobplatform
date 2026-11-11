/**
 * POST /telemetry: what a visitor did in the UI, relayed to monitoring-api's
 * `service_events`.
 *
 * A browser holds no key, so it cannot post to `/health/api/telemetry` itself
 * (hadoku_site docs/child-apps/TELEMETRY.md). It posts batches here, and this
 * route forwards each event as its own row (`source=browser`,
 * `service=jobplatform`) over the EDGE binding as this worker's service
 * identity. Read back with
 * `GET /health/api/service-events?service=jobplatform&source=browser`.
 *
 * Open to every tier, signed out included: the app is publicly browsable and
 * a signed-out visitor's clicks are as much the record as anyone's. What keeps
 * an open write path small is the schema: at most 25 events a request, short
 * names, short values, a dozen props each. Identity is never taken from the
 * body: the user id and tier are the ones the edge verified for this request.
 */
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { HadokuAuthContext } from '@wolffm/worker-utils';
import type { AppEnv } from '../types.js';
import { runAfterResponse } from '../background.js';
import { canPostTelemetry, postServiceEvent } from '../clients/telemetry.js';
import { maybeUserId } from './jobs/shared.js';

interface RouteContext {
	Bindings: AppEnv;
	Variables: { authContext: HadokuAuthContext };
}

export const TELEMETRY_MAX_EVENTS = 25;

const PropValue = z.union([z.string().max(200), z.number(), z.boolean(), z.null()]);

const ClientEvent = z.object({
	event: z
		.string()
		.regex(/^[a-z][a-z0-9_.]{1,47}$/)
		.openapi({ description: 'Stable dotted name, e.g. ui.click, api.error, ui.error' }),
	level: z.enum(['info', 'warn', 'error']).default('info'),
	/** The browser's clock when it happened, ms since the epoch. */
	at: z.number().int().nonnegative(),
	props: z
		.record(z.string().max(40), PropValue)
		.refine((p) => Object.keys(p).length <= 12, 'at most 12 props')
		.default({}),
});

const TelemetryBody = z.object({
	app: z.enum(['jobplatform', 'jobpulse']),
	/** Random per page load: groups one visit's events. Not an identity. */
	session: z.string().regex(/^[A-Za-z0-9_-]{8,40}$/),
	events: z.array(ClientEvent).min(1).max(TELEMETRY_MAX_EVENTS),
});

const app = new OpenAPIHono<RouteContext>();

app.openapi(
	createRoute({
		method: 'post',
		path: '/telemetry',
		tags: ['Telemetry'],
		summary: 'Relay UI events to service_events',
		description:
			'Batches of browser events (clicks, client-side API failures, render errors), forwarded one row each to monitoring-api as source=browser. Open to every tier; identity comes from the edge, never the body.',
		request: { body: { content: { 'application/json': { schema: TelemetryBody } } } },
		responses: {
			202: {
				description: 'Accepted for forwarding',
				content: {
					'application/json': {
						schema: z.object({
							success: z.literal(true),
							data: z.object({ accepted: z.number() }),
						}),
					},
				},
			},
		},
	}),
	async (c) => {
		const { app: appName, session, events } = c.req.valid('json');
		const env = c.env;
		if (canPostTelemetry(env)) {
			const auth = c.get('authContext');
			const userId = await maybeUserId(c);
			const tier = auth.userType ?? 'public';
			runAfterResponse(
				c,
				'telemetry: browser relay',
				Promise.all(
					events.map((ev) =>
						postServiceEvent(env, {
							source: 'browser',
							level: ev.level,
							event: ev.event,
							message: describe(appName, ev.event, ev.props),
							context: {
								...ev.props,
								app: appName,
								session,
								user_id: userId,
								tier,
								client_at: new Date(ev.at).toISOString(),
							},
						})
					)
				)
			);
		}
		return c.json({ success: true as const, data: { accepted: events.length } }, 202);
	}
);

/** The row's message: readable in a raw listing without opening context_json. */
function describe(
	appName: string,
	event: string,
	props: Record<string, string | number | boolean | null>
): string {
	const what = props.label ?? props.path ?? props.message ?? '';
	return `${appName} ${String(what)}`.trim().slice(0, 200);
}

export { app as telemetryRoutes };
