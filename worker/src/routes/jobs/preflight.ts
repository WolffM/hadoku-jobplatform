import { createRoute, z } from '@hono/zod-openapi';
import { asRoleLevel, type JobsApp } from './shared.js';

/**
 * GET /jobs/preflight — "does this connect to something real?"
 *
 * Powers the profile editor's per-field probes: given a keyword and/or a role
 * type, count how many corpus jobs it would match, so the user sees a live
 * signal ("312 matching jobs") before saving it into a profile. Read-only,
 * unauthenticated (same posture as GET /jobs).
 *
 * MUST be registered before GET /jobs/{id} — OpenAPIHono resolves in
 * registration order, so a later static route loses to the earlier param route
 * (/jobs/{id} would otherwise capture "preflight" as an id). The order lives in
 * ./index.ts and is covered by tests/routes/jobsDetail.test.ts.
 */
export function registerPreflightRoute(app: JobsApp): void {
	app.openapi(
		createRoute({
			method: 'get',
			path: '/jobs/preflight',
			tags: ['Jobs'],
			summary: 'Count corpus jobs matching a keyword, track and/or level (editor probe)',
			request: {
				query: z.object({
					keyword: z
						.string()
						.optional()
						.openapi({ description: 'Match in title or description (case-insensitive)' }),
					track: z
						.enum(['ic', 'manager'])
						.optional()
						.openapi({ description: 'Count only jobs classified onto this track' }),
					level: z
						.string()
						.optional()
						.openapi({ description: 'Count only jobs classified at this rung' }),
				}),
			},
			responses: {
				200: {
					description: 'Match count',
					content: {
						'application/json': {
							schema: z
								.object({
									success: z.literal(true),
									data: z.object({ count: z.number() }),
								})
								.openapi('PreflightResponse'),
						},
					},
				},
			},
		}),
		async (c) => {
			const { keyword, track, level } = c.req.valid('query');
			const db = c.env.JOB_PLATFORM_DB;

			const wheres: string[] = [];
			const binds: string[] = [];

			const kw = keyword?.trim();
			if (kw) {
				const like = `%${kw.toLowerCase()}%`;
				wheres.push('(LOWER(title) LIKE ? OR LOWER(description) LIKE ?)');
				binds.push(like, like);
			}

			// Both probes read the columns the classifier already wrote, so the
			// editor's count is exactly the population the same selection would
			// filter to — no second, differently-spelled matcher to drift out of sync
			// with the scorer.
			if (track) {
				wheres.push('role_track = ?');
				binds.push(track);
			}

			const lvl = asRoleLevel(level?.trim() ?? null);
			if (lvl) {
				wheres.push('role_level = ?');
				binds.push(lvl);
			}

			const whereClause = wheres.length ? `WHERE ${wheres.join(' AND ')}` : '';
			const row = await db
				.prepare(`SELECT COUNT(*) as n FROM jobs ${whereClause}`)
				.bind(...binds)
				.first<{ n: number }>();

			return c.json({ success: true as const, data: { count: row?.n ?? 0 } }, 200);
		}
	);
}
