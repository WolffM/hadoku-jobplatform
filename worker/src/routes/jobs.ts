import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { AppEnv } from '../types.js';
import { JobsResponseSchema, JobResponseSchema, ErrorResponseSchema } from '../schemas.js';

interface RouteContext {
	Bindings: AppEnv;
}

const app = new OpenAPIHono<RouteContext>();

// ============================================================================
// GET /jobs
// ============================================================================

app.openapi(
	createRoute({
		method: 'get',
		path: '/jobs',
		tags: ['Jobs'],
		summary: 'List jobs (optionally scored for a profile)',
		request: {
			query: z.object({
				profile_id: z
					.string()
					.optional()
					.openapi({ description: 'Filter/score by profile. Omit to list all jobs unscored.' }),
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
		},
	}),
	async (c) => {
		const { profile_id, page, limit, sort, min_score } = c.req.valid('query');
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
			score: number | null;
			score_breakdown: string | null;
		}

		let total: number;
		let rows: { results: JobRow[] };

		if (profile_id) {
			const orderBy = sort === 'score' ? 'm.score DESC' : 'j.scraped_at DESC';

			const countRow = await db
				.prepare(
					`SELECT COUNT(*) as total FROM job_profile_matches m
					 WHERE m.profile_id = ? AND m.score >= ?`
				)
				.bind(profile_id, min_score)
				.first<{ total: number }>();
			total = countRow?.total ?? 0;

			rows = await db
				.prepare(
					`SELECT
						j.id, j.title, j.company, j.location, j.workplace_type,
						j.salary_min, j.salary_max, j.source_site, j.url,
						j.posted_date, j.scraped_at,
						m.score, m.score_breakdown
					 FROM job_profile_matches m
					 JOIN jobs j ON j.id = m.job_id
					 WHERE m.profile_id = ? AND m.score >= ?
					 ORDER BY ${orderBy}
					 LIMIT ? OFFSET ?`
				)
				.bind(profile_id, min_score, limit, offset)
				.all<JobRow>();
		} else {
			// Unscored listing — no profile filter, score fields default to 0.
			// `sort=score` is meaningless here; fall back to date order.
			const countRow = await db
				.prepare('SELECT COUNT(*) as total FROM jobs')
				.first<{ total: number }>();
			total = countRow?.total ?? 0;

			rows = await db
				.prepare(
					`SELECT
						j.id, j.title, j.company, j.location, j.workplace_type,
						j.salary_min, j.salary_max, j.source_site, j.url,
						j.posted_date, j.scraped_at,
						NULL as score, NULL as score_breakdown
					 FROM jobs j
					 ORDER BY j.scraped_at DESC
					 LIMIT ? OFFSET ?`
				)
				.bind(limit, offset)
				.all<JobRow>();
		}

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
			score: r.score ?? 0,
			score_breakdown: r.score_breakdown
				? (JSON.parse(r.score_breakdown) as typeof zeroBreakdown)
				: zeroBreakdown,
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
			description: row.description as string,
			application_url: row.application_url as string | null,
			department: row.department as string | null,
			scraper_used: row.scraper_used as string | null,
			run_id: row.run_id as string | null,
			score,
			score_breakdown,
		};

		return c.json({ success: true as const, data: { job } }, 200);
	}
);

export const jobRoutes = app;
