import { createRoute, z } from '@hono/zod-openapi';
import {
	ErrorResponseSchema,
	SetJobFeedbackSchema,
	JobFeedbackResponseSchema,
} from '../../schemas.js';
import { gateAuthed, maybeUserId, type JobsApp } from './shared.js';

/**
 * PUT / DELETE /jobs/{id}/feedback — the owner's curation vote on one posting.
 *
 * One vote per (user, job): +1 / -1 plus an axis-aligned reason. Three uses,
 * in increasing order of leverage:
 *   tier 1  the feed multiplies voted jobs directly (immediate, per-job)
 *   tier 2  a batch step mines same-reason votes into the profile's
 *           interest/stack lists (generalizes to unseen postings)
 *   tier 3  votes become labels for fitting per-profile axis weights
 * `processed_at` stays NULL until tier-2/3 consumes the vote.
 */
export function registerFeedbackRoutes(app: JobsApp): void {
	app.put('/jobs/:id/feedback', gateAuthed);
	app.delete('/jobs/:id/feedback', gateAuthed);

	app.openapi(
		createRoute({
			method: 'put',
			path: '/jobs/{id}/feedback',
			tags: ['Jobs'],
			summary: 'Up/downvote a posting with an axis-aligned reason (per-user, upsert)',
			request: {
				params: z.object({ id: z.string() }),
				body: { content: { 'application/json': { schema: SetJobFeedbackSchema } } },
			},
			responses: {
				200: {
					description: 'Feedback recorded',
					content: { 'application/json': { schema: JobFeedbackResponseSchema } },
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

			const exists = await db
				.prepare('SELECT id FROM jobs WHERE id = ?')
				.bind(id)
				.first<{ id: string }>();
			if (!exists) {
				return c.json(
					{ success: false as const, error: 'Not found', message: `Job '${id}' not found` },
					404
				);
			}

			const now = new Date().toISOString();
			// A changed vote resets processed_at: tier-2/3 must re-consume it.
			await db
				.prepare(
					`INSERT INTO job_feedback (id, user_id, job_id, vote, reason, created_at, processed_at)
					 VALUES (?, ?, ?, ?, ?, ?, NULL)
					 ON CONFLICT (user_id, job_id) DO UPDATE SET
					   vote = excluded.vote,
					   reason = excluded.reason,
					   created_at = excluded.created_at,
					   processed_at = NULL`
				)
				.bind(crypto.randomUUID(), userId, id, body.vote, body.reason ?? null, now)
				.run();

			return c.json(
				{
					success: true as const,
					data: { job_id: id, vote: body.vote, reason: body.reason ?? null, updated_at: now },
				},
				200
			);
		}
	);

	app.openapi(
		createRoute({
			method: 'delete',
			path: '/jobs/{id}/feedback',
			tags: ['Jobs'],
			summary: 'Clear the vote on a posting — idempotent',
			request: { params: z.object({ id: z.string() }) },
			responses: {
				200: {
					description: 'Feedback cleared',
					content: { 'application/json': { schema: JobFeedbackResponseSchema } },
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
			await c.env.JOB_PLATFORM_DB.prepare(
				'DELETE FROM job_feedback WHERE user_id = ? AND job_id = ?'
			)
				.bind(userId, id)
				.run();
			return c.json(
				{
					success: true as const,
					data: { job_id: id, vote: null, reason: null, updated_at: new Date().toISOString() },
				},
				200
			);
		}
	);
}
