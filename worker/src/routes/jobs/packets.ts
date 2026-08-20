import { createRoute } from '@hono/zod-openapi';
import { ErrorResponseSchema, PacketsResponseSchema } from '../../schemas.js';
import { gateAuthed, maybeUserId, type JobsApp } from './shared.js';

/**
 * GET /jobs/packets — every application packet the caller has generated.
 *
 * A packet is a minted resume-api variant: when a packet link is created (or a
 * job is marked applied with one), the slug lands on the caller's job_states
 * row and survives later state changes via the COALESCE in state.ts. This
 * route is the way back to those packets — which job, when it was prepared,
 * and the slug that keys both the public page and the PDF.
 *
 * Friend-gated: packets are per-user by construction (job_states is keyed by
 * user), so an unauthenticated caller has nothing to see here.
 *
 * MUST be registered before GET /jobs/{id} — OpenAPIHono resolves in
 * registration order, so the param route would otherwise capture "packets" as
 * an id. Same trap as /jobs/preflight; the order lives in ./index.ts.
 */
export function registerPacketsRoute(app: JobsApp): void {
	app.get('/jobs/packets', gateAuthed);

	app.openapi(
		createRoute({
			method: 'get',
			path: '/jobs/packets',
			tags: ['Jobs'],
			summary: 'List the caller’s application packets (job states with a minted variant)',
			responses: {
				200: {
					description: 'Packets, newest first',
					content: { 'application/json': { schema: PacketsResponseSchema } },
				},
				403: {
					description: 'Forbidden',
					content: { 'application/json': { schema: ErrorResponseSchema } },
				},
			},
		}),
		async (c) => {
			const userId = await maybeUserId(c);
			if (!userId) {
				return c.json(
					{ success: false as const, error: 'Forbidden', message: 'Authentication required' },
					403
				);
			}

			const rows = await c.env.JOB_PLATFORM_DB.prepare(
				`SELECT js.job_id, js.state, js.variant_slug, js.updated_at,
				        j.title, j.company, j.location
				 FROM job_states js
				 INNER JOIN jobs j ON j.id = js.job_id
				 WHERE js.user_id = ? AND js.variant_slug IS NOT NULL
				 ORDER BY js.updated_at DESC`
			)
				.bind(userId)
				.all<{
					job_id: string;
					state: string;
					variant_slug: string;
					updated_at: string;
					title: string;
					company: string;
					location: string;
				}>();

			const packets = rows.results.map((r) => ({
				job_id: r.job_id,
				title: r.title,
				company: r.company,
				location: r.location,
				state: r.state as 'interested' | 'dismissed' | 'saved' | 'applied',
				variant_slug: r.variant_slug,
				updated_at: r.updated_at,
			}));

			return c.json({ success: true as const, data: { packets } }, 200);
		}
	);
}
