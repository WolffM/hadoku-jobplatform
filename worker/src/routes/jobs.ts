import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { AppEnv } from '../types.js';
import {
	JobsResponseSchema,
	JobResponseSchema,
	ErrorResponseSchema,
	SetJobStateSchema,
	JobStateResponseSchema,
} from '../schemas.js';
import type { HadokuAuthContext } from '@wolffm/worker-utils';
import { userIdFromCredential } from '../userId.js';

interface RouteContext {
	Bindings: AppEnv;
	Variables: { authContext: HadokuAuthContext };
}

const app = new OpenAPIHono<RouteContext>();

// Resolve the caller to an opaque user id, or null when unauthenticated.
async function maybeUserId(c: {
	get: (k: 'authContext') => HadokuAuthContext;
}): Promise<string | null> {
	const auth = c.get('authContext');
	if ((auth.userType === 'admin' || auth.userType === 'friend') && auth.credential) {
		return userIdFromCredential(auth.credential);
	}
	return null;
}

// ============================================================================
// GET /jobs
// ============================================================================

app.openapi(
	createRoute({
		method: 'get',
		path: '/jobs',
		tags: ['Jobs'],
		summary: 'List jobs (optionally scored, mine-only, or filtered by triage state)',
		request: {
			query: z.object({
				profile_id: z
					.string()
					.optional()
					.openapi({ description: 'Filter/score by profile. Omit to list all jobs unscored.' }),
				mine: z.enum(['true', 'false']).optional().openapi({
					description:
						'If true, filter to jobs from companies the caller is subscribed to (via /companies). Requires admin/friend auth.',
				}),
				state: z.enum(['interested', 'dismissed', 'saved', 'applied', 'new']).optional().openapi({
					description:
						'Filter to a single triage state for the authed user. Requires admin/friend auth. "new" filters to jobs without any state row.',
				}),
				hide_dismissed: z.enum(['true', 'false']).optional().openapi({
					description:
						'If true, exclude state=dismissed for the authed user. No effect when unauthed (no per-user join).',
				}),
				page: z.coerce.number().int().positive().default(1).openapi({ description: 'Page number' }),
				limit: z.coerce
					.number()
					.int()
					.min(1)
					.max(100)
					.default(25)
					.openapi({ description: 'Results per page' }),
				sort: z.enum(['score', 'date']).default('score').openapi({ description: 'Sort order' }),
				min_score: z.coerce
					.number()
					.min(0)
					.max(1)
					.default(0)
					.openapi({ description: 'Minimum score filter' }),
			}),
		},
		responses: {
			200: {
				description: 'Job list',
				content: { 'application/json': { schema: JobsResponseSchema } },
			},
			401: {
				description: 'mine=true / state= / hide_dismissed= require auth',
				content: { 'application/json': { schema: ErrorResponseSchema } },
			},
		},
	}),
	async (c) => {
		const {
			profile_id,
			mine: mineRaw,
			state: stateFilter,
			hide_dismissed: hideDismissedRaw,
			page,
			limit,
			sort,
			min_score,
		} = c.req.valid('query');
		const mine = mineRaw === 'true';
		const hideDismissed = hideDismissedRaw === 'true';
		const db = c.env.JOB_PLATFORM_DB;
		const offset = (page - 1) * limit;

		const zeroBreakdown = {
			title_match: 0,
			keyword_match: 0,
			company_boost: 0,
			seniority_match: 0,
			remote_match: 0,
			salary_match: 0,
		};

		interface JobRow {
			id: string;
			title: string;
			company: string;
			location: string;
			workplace_type: string;
			salary_min: number | null;
			salary_max: number | null;
			source_site: string;
			url: string;
			posted_date: string | null;
			scraped_at: string;
			ats: string | null;
			slug: string | null;
			score: number | null;
			score_breakdown: string | null;
			row_state: string | null;
		}

		// mine=true and state= require an authed caller — they explicitly opt
		// into per-user filtering and the wrong answer is misleading. hide_dismissed
		// is treated as a no-op for unauthed callers (no per-user join, nothing
		// to hide) so the UI can default it on without forcing a pre-flight
		// auth check.
		const userId = await maybeUserId(c);
		const needsAuth = mine || stateFilter !== undefined;
		if (needsAuth && !userId) {
			return c.json(
				{
					success: false as const,
					error: 'Unauthorized',
					message: 'mine=true and state= require admin/friend auth',
				},
				401
			);
		}

		const joins: string[] = [];
		const wheres: string[] = [];
		const binds: (string | number)[] = [];

		const scoredCols = profile_id
			? 'm.score, m.score_breakdown'
			: 'NULL as score, NULL as score_breakdown';

		// LEFT JOIN job_states once when authed so we can both surface state on
		// every row AND filter by it cheaply. js.user_id binds first if present
		// because the join clause has to come before any state filter binds.
		const stateCols = userId ? 'js.state as row_state' : 'NULL as row_state';
		if (userId) {
			joins.push('LEFT JOIN job_states js ON js.job_id = j.id AND js.user_id = ?');
			binds.push(userId);
		}

		if (profile_id) {
			joins.push('JOIN job_profile_matches m ON m.job_id = j.id');
			wheres.push('m.profile_id = ?');
			binds.push(profile_id);
			wheres.push('m.score >= ?');
			binds.push(min_score);
		}

		if (mine && userId) {
			joins.push('INNER JOIN user_companies uc ON uc.ats = j.ats AND uc.slug = j.slug');
			wheres.push('uc.user_id = ?');
			binds.push(userId);
		}

		// State / hide_dismissed clauses reference the LEFT JOIN above, which
		// only exists when authed. Skip them otherwise — they'd dangle on
		// `js.state` and the SQL would fail to parse.
		if (userId) {
			if (stateFilter === 'new') {
				wheres.push('js.state IS NULL');
			} else if (stateFilter) {
				wheres.push('js.state = ?');
				binds.push(stateFilter);
			} else if (hideDismissed) {
				wheres.push("(js.state IS NULL OR js.state != 'dismissed')");
			}
		}

		const whereClause = wheres.length > 0 ? `WHERE ${wheres.join(' AND ')}` : '';
		const joinClause = joins.join(' ');
		const orderBy = profile_id && sort === 'score' ? 'm.score DESC' : 'j.scraped_at DESC';

		const countSql = `SELECT COUNT(*) as total FROM jobs j ${joinClause} ${whereClause}`;
		const countRow = await db
			.prepare(countSql)
			.bind(...binds)
			.first<{ total: number }>();
		const total = countRow?.total ?? 0;

		const dataSql = `
			SELECT
				j.id, j.title, j.company, j.location, j.workplace_type,
				j.salary_min, j.salary_max, j.source_site, j.url,
				j.posted_date, j.scraped_at, j.ats, j.slug,
				${scoredCols},
				${stateCols}
			FROM jobs j
			${joinClause}
			${whereClause}
			ORDER BY ${orderBy}
			LIMIT ? OFFSET ?`;

		const rows = await db
			.prepare(dataSql)
			.bind(...binds, limit, offset)
			.all<JobRow>();

		const jobs = rows.results.map((r) => ({
			id: r.id,
			title: r.title,
			company: r.company,
			location: r.location,
			workplace_type: r.workplace_type,
			salary_min: r.salary_min,
			salary_max: r.salary_max,
			source_site: r.source_site,
			url: r.url,
			posted_date: r.posted_date,
			scraped_at: r.scraped_at,
			ats: r.ats,
			slug: r.slug,
			score: r.score ?? 0,
			score_breakdown: r.score_breakdown
				? (JSON.parse(r.score_breakdown) as typeof zeroBreakdown)
				: zeroBreakdown,
			state: userId ? ((r.row_state as 'new' | null) ?? 'new') : null,
		}));

		return c.json(
			{
				success: true as const,
				data: { jobs, total, page, limit, has_more: offset + jobs.length < total },
			},
			200
		);
	}
);

// ============================================================================
// GET /jobs/:id
// ============================================================================

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
		let score_breakdown = {
			title_match: 0,
			keyword_match: 0,
			company_boost: 0,
			seniority_match: 0,
			remote_match: 0,
			salary_match: 0,
		};

		if (profile_id) {
			const match = await db
				.prepare(
					'SELECT score, score_breakdown FROM job_profile_matches WHERE job_id = ? AND profile_id = ?'
				)
				.bind(id, profile_id)
				.first<{ score: number; score_breakdown: string }>();

			if (match) {
				score = match.score;
				score_breakdown = JSON.parse(match.score_breakdown) as typeof score_breakdown;
			}
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

// ============================================================================
// PUT /jobs/:id/state — set the caller's triage state for one job
// ============================================================================

async function gateAuthed(
	c: { get: (k: 'authContext') => HadokuAuthContext; json: (b: unknown, s?: number) => Response },
	next: () => Promise<void>
) {
	const auth = c.get('authContext');
	if (auth.userType !== 'admin' && auth.userType !== 'friend') {
		return c.json(
			{ success: false as const, error: 'Forbidden', message: 'Authentication required' },
			403
		);
	}
	await next();
	return;
}

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

		// Verify the job exists — better error than relying on FK to scream.
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
		await db
			.prepare(
				`INSERT INTO job_states (job_id, user_id, state, notes, updated_at)
				 VALUES (?, ?, ?, NULL, ?)
				 ON CONFLICT (job_id, user_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`
			)
			.bind(id, userId, body.state, now)
			.run();

		return c.json(
			{
				success: true as const,
				data: { job_id: id, state: body.state, updated_at: now },
			},
			200
		);
	}
);

// ============================================================================
// DELETE /jobs/:id/state — clear state (back to implicit 'new'). Idempotent.
// ============================================================================

app.openapi(
	createRoute({
		method: 'delete',
		path: '/jobs/{id}/state',
		tags: ['Jobs'],
		summary: 'Clear triage state for a job — returns the row to implicit "new"',
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
		const result = await c.env.JOB_PLATFORM_DB.prepare(
			'DELETE FROM job_states WHERE job_id = ? AND user_id = ?'
		)
			.bind(id, userId)
			.run();
		const deleted = (result.meta?.changes ?? 0) > 0;
		return c.json({ success: true as const, data: { job_id: id, deleted } }, 200);
	}
);

export const jobRoutes = app;
