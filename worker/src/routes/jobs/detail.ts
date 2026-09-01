import { createRoute, z } from '@hono/zod-openapi';
import { JobResponseSchema, ErrorResponseSchema } from '../../schemas.js';
import { scoreJob } from '../../scoring.js';
import { applyTier } from '../../applyTier.js';
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

			// Has the runner actually driven a form on THIS board before?
			//
			// Board-level rather than job-level on purpose: one posting having
			// been filled says nothing useful about itself (it is already
			// done), but it says a great deal about the next posting on the
			// same board — same ATS, same template, same questions. This is the
			// only signal here entitled to read as "checked"; `apply_tier` is a
			// prediction from the URL and no page has been opened for it.
			let applyVerified = false;
			if (userId && row.ats && row.slug) {
				const proven = await db
					.prepare(
						`SELECT 1 FROM applications a
						 JOIN jobs j ON j.id = a.job_id
						 WHERE a.user_id = ? AND j.ats = ? AND j.slug = ?
						   AND a.status IN ('filled', 'approved', 'submitted')
						 LIMIT 1`
					)
					.bind(userId, row.ats as string, row.slug as string)
					.first<{ 1: number }>();
				applyVerified = proven !== null;
			}
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
				apply_tier: applyTier(
					(row.application_url as string | null) ?? (row.url as string | null),
					(row.ats as string | null) ?? null
				),
				apply_verified: applyVerified,
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
