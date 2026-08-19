import { createRoute, z } from '@hono/zod-openapi';
import { JobResponseSchema, ErrorResponseSchema } from '../../schemas.js';
import { scoreJob } from '../../scoring.js';
import { loadScorableProfile } from '../../profileScore.js';
import { asRoleLevel, asRoleTrack, maybeUserId, ZERO_BREAKDOWN, type JobsApp } from './shared.js';

export function registerDetailRoute(app: JobsApp): void {
	app.openapi(
		createRoute({
			method: 'get',
			path: '/jobs/{id}',
			tags: ['Jobs'],
			summary: 'Get full job detail',
			request: {
				params: z.object({ id: z.string() }),
				query: z.object({
					profile_id: z
						.string()
						.optional()
						.openapi({ description: 'Include score for this profile' }),
				}),
			},
			responses: {
				200: {
					description: 'Job detail',
					content: { 'application/json': { schema: JobResponseSchema } },
				},
				404: {
					description: 'Not found',
					content: { 'application/json': { schema: ErrorResponseSchema } },
				},
			},
		}),
		async (c) => {
			const { id } = c.req.valid('param');
			const { profile_id } = c.req.valid('query');
			const db = c.env.JOB_PLATFORM_DB;

			const row = await db
				.prepare('SELECT * FROM jobs WHERE id = ?')
				.bind(id)
				.first<Record<string, unknown>>();

			if (!row) {
				return c.json(
					{ success: false as const, error: 'Not found', message: `Job '${id}' not found` },
					404
				);
			}

			let score = 0;
			let score_breakdown = { ...ZERO_BREAKDOWN };

			const roleLevel = asRoleLevel((row.role_level as string | null) ?? null);

			if (profile_id) {
				const profile = await loadScorableProfile(db, profile_id);
				const result = scoreJob(
					{
						title: row.title as string,
						description: row.description as string,
						location: (row.location as string | null) ?? null,
						workplace_type: row.workplace_type as string,
						salary_max: (row.salary_max as number | null) ?? null,
						role_level: roleLevel,
					},
					profile
				);
				score = result.score;
				score_breakdown = result.breakdown;
			}

			// Per-user state if authed.
			type StateRead = 'new' | 'interested' | 'dismissed' | 'saved' | 'applied';
			const userId = await maybeUserId(c);
			let state: StateRead | null = null;
			let stateUpdatedAt: string | null = null;
			if (userId) {
				const stateRow = await db
					.prepare('SELECT state, updated_at FROM job_states WHERE job_id = ? AND user_id = ?')
					.bind(id, userId)
					.first<{ state: string; updated_at: string }>();
				state = stateRow ? (stateRow.state as StateRead) : 'new';
				stateUpdatedAt = stateRow?.updated_at ?? null;
			}

			const job = {
				id: row.id as string,
				title: row.title as string,
				company: row.company as string,
				location: row.location as string,
				workplace_type: row.workplace_type as string,
				job_type: row.job_type as string,
				salary_min: row.salary_min as number | null,
				salary_max: row.salary_max as number | null,
				source_site: row.source_site as string,
				url: row.url as string,
				posted_date: row.posted_date as string | null,
				scraped_at: row.scraped_at as string,
				ats: (row.ats as string | null) ?? null,
				slug: (row.slug as string | null) ?? null,
				role_track: asRoleTrack((row.role_track as string | null) ?? 'unknown'),
				role_level: roleLevel,
				description: row.description as string,
				application_url: row.application_url as string | null,
				department: row.department as string | null,
				scraper_used: row.scraper_used as string | null,
				run_id: row.run_id as string | null,
				score,
				score_breakdown,
				state,
				state_updated_at: stateUpdatedAt,
			};

			return c.json({ success: true as const, data: { job } }, 200);
		}
	);
}
