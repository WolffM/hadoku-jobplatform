import { createRoute, z } from '@hono/zod-openapi';
import { ErrorResponseSchema, SetJobStateSchema, JobStateResponseSchema } from '../../schemas.js';
import { gateAuthed, maybeUserId, type JobsApp } from './shared.js';

/**
 * PUT / DELETE /jobs/{id}/state — the caller's triage state for one job.
 *
 * A change of state is also a row on the job's timeline (job_events, kind
 * 'state'); see pipeline.ts for the rest of that timeline.
 *
 * gateAuthed is registered as middleware on the plain method+path first; the
 * openapi routes below then run as the next handler in the same chain. Keep
 * that order.
 */
export function registerStateRoutes(app: JobsApp): void {
	app.put('/jobs/:id/state', gateAuthed);
	app.delete('/jobs/:id/state', gateAuthed);

	app.openapi(
		createRoute({
			method: 'put',
			path: '/jobs/{id}/state',
			tags: ['Jobs'],
			summary: 'Set triage state for a job (per-user, upsert)',
			request: {
				params: z.object({ id: z.string() }),
				body: { content: { 'application/json': { schema: SetJobStateSchema } } },
			},
			responses: {
				200: {
					description: 'State updated',
					content: { 'application/json': { schema: JobStateResponseSchema } },
				},
				403: {
					description: 'Forbidden',
					content: { 'application/json': { schema: ErrorResponseSchema } },
				},
				404: {
					description: 'Job not found',
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

			const { id } = c.req.valid('param');
			const body = c.req.valid('json');
			const db = c.env.JOB_PLATFORM_DB;

			// Verify the job exists — better error than relying on FK to scream —
			// and read the state it is leaving, for the timeline.
			const exists = await db
				.prepare(
					`SELECT j.id, js.state AS prev FROM jobs j
					 LEFT JOIN job_states js ON js.job_id = j.id AND js.user_id = ?
					 WHERE j.id = ?`
				)
				.bind(userId, id)
				.first<{ id: string; prev: string | null }>();
			if (!exists) {
				return c.json(
					{ success: false as const, error: 'Not found', message: `Job '${id}' not found` },
					404
				);
			}

			const now = new Date().toISOString();
			// COALESCE(excluded.variant_slug, variant_slug): a later state change that
			// carries no slug (e.g. moving applied → saved) must not wipe the record of
			// what was already sent. A fresh slug overwrites; a null leaves it be.
			const variantSlug = body.variant_slug ?? null;
			const upsert = db
				.prepare(
					`INSERT INTO job_states (job_id, user_id, state, notes, updated_at, variant_slug)
					 VALUES (?, ?, ?, NULL, ?, ?)
					 ON CONFLICT (job_id, user_id) DO UPDATE SET
					   state = excluded.state,
					   updated_at = excluded.updated_at,
					   variant_slug = COALESCE(excluded.variant_slug, job_states.variant_slug)`
				)
				.bind(id, userId, body.state, now, variantSlug);
			// The timeline records transitions, not writes: re-sending the state a
			// job already has (a packet re-recorded on 'applied', a double click)
			// changes nothing a person would call an event.
			if (exists.prev === body.state) {
				await upsert.run();
			} else {
				await db.batch([
					upsert,
					db
						.prepare(
							`INSERT INTO job_events
							   (job_id, user_id, kind, from_state, to_state, note, occurred_at, created_at)
							 VALUES (?, ?, 'state', ?, ?, NULL, ?, ?)`
						)
						.bind(id, userId, exists.prev, body.state, now, now),
				]);
			}

			return c.json(
				{
					success: true as const,
					data: { job_id: id, state: body.state, updated_at: now },
				},
				200
			);
		}
	);

	// DELETE — clear state (back to implicit 'new'). Idempotent.
	app.openapi(
		createRoute({
			method: 'delete',
			path: '/jobs/{id}/state',
			tags: ['Jobs'],
			summary:
				'Clear triage state for a job — returns the row to implicit "new" and drops its timeline',
			request: {
				params: z.object({ id: z.string() }),
			},
			responses: {
				200: {
					description: 'State cleared (or already absent)',
					content: {
						'application/json': {
							schema: z
								.object({
									success: z.literal(true),
									data: z.object({ job_id: z.string(), deleted: z.boolean() }),
								})
								.openapi('ClearJobStateResponse'),
						},
					},
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
			const { id } = c.req.valid('param');
			const db = c.env.JOB_PLATFORM_DB;
			// Clearing returns the posting to 'new' — out of the pipeline, and
			// back within reach of the cull — so its timeline goes with it. A
			// timeline left behind would describe an application the person has
			// just said is not one, and the cull would take it later anyway.
			const [result] = await db.batch([
				db.prepare('DELETE FROM job_states WHERE job_id = ? AND user_id = ?').bind(id, userId),
				db.prepare('DELETE FROM job_events WHERE job_id = ? AND user_id = ?').bind(id, userId),
			]);
			const deleted = (result.meta?.changes ?? 0) > 0;
			return c.json({ success: true as const, data: { job_id: id, deleted } }, 200);
		}
	);
}
