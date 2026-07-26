import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { AppEnv } from '../types.js';
import {
	JobsResponseSchema,
	JobResponseSchema,
	ErrorResponseSchema,
	SetJobStateSchema,
	JobStateResponseSchema,
} from '../schemas.js';
import { tierAtLeast, type HadokuAuthContext } from '@wolffm/worker-utils';
import { resolveUserId } from '../userId.js';
import { scoreJob, SENIORITY_KEYWORDS } from '../scoring.js';
import { loadScorableProfile } from '../profileScore.js';
import { logger } from '../logger.js';

// Cap on candidates scored in-request for a profile feed. Profile feeds are
// scoped to the profile's companies, so this is comfortably above any real
// slice; beyond it we score the most-recent CAP rows and log the truncation.
const SCORE_CANDIDATE_CAP = 3000;

interface RouteContext {
	Bindings: AppEnv;
	Variables: { authContext: HadokuAuthContext };
}

const app = new OpenAPIHono<RouteContext>();

// Resolve the caller to a user id, or null when unauthenticated.
//
// Prefers the edge-injected X-User-Id (the registry UUID that survives key
// rotation, and the identity job_states rows are keyed by after the one-time
// migration). Falls back to the legacy credential hash only for callers that
// bypass the edge. See userId.ts.
async function maybeUserId(c: {
	req: { header: (name: string) => string | undefined };
	get: (k: 'authContext') => HadokuAuthContext;
}): Promise<string | null> {
	const auth = c.get('authContext');
	if (tierAtLeast(auth, 'friend') && auth.credential) {
		return resolveUserId(c);
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
			state: stateFilter,
			hide_dismissed: hideDismissedRaw,
			page,
			limit,
			sort,
			min_score,
		} = c.req.valid('query');
		const hideDismissed = hideDismissedRaw === 'true';
		const db = c.env.JOB_PLATFORM_DB;
		const offset = (page - 1) * limit;

		const zeroBreakdown = {
			title_match: 0,
			keyword_match: 0,
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
			description: string;
			row_state: string | null;
		}

		// mine=true and state= require an authed caller — they explicitly opt
		// into per-user filtering and the wrong answer is misleading. hide_dismissed
		// is treated as a no-op for unauthed callers (no per-user join, nothing
		// to hide) so the UI can default it on without forcing a pre-flight
		// auth check.
		const userId = await maybeUserId(c);
		const needsAuth = stateFilter !== undefined;
		if (needsAuth && !userId) {
			return c.json(
				{
					success: false as const,
					error: 'Unauthorized',
					message: 'state= requires admin/friend auth',
				},
				401
			);
		}

		const joins: string[] = [];
		const wheres: string[] = [];
		const binds: (string | number)[] = [];

		// LEFT JOIN job_states once when authed so we can both surface state on
		// every row AND filter by it cheaply. js.user_id binds first if present
		// because the join clause has to come before any state filter binds.
		const stateCols = userId ? 'js.state as row_state' : 'NULL as row_state';
		if (userId) {
			joins.push('LEFT JOIN job_states js ON js.job_id = j.id AND js.user_id = ?');
			binds.push(userId);
		}

		// Companies are an OPTIONAL filter, not a required scope. When a profile
		// has companies, restrict its feed to their jobs; when it has none, the
		// feed is the whole corpus, ranked by the profile's other criteria
		// (keywords / roles / salary / remote). An empty profile ⇒ everything,
		// newest first.
		if (profile_id) {
			const companyCount = await db
				.prepare('SELECT COUNT(*) as n FROM profile_companies WHERE profile_id = ?')
				.bind(profile_id)
				.first<{ n: number }>();
			if ((companyCount?.n ?? 0) > 0) {
				joins.push(
					'INNER JOIN profile_companies pc ON pc.ats = j.ats AND pc.slug = j.slug AND pc.profile_id = ?'
				);
				binds.push(profile_id);
			}
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

		// ── Score-on-read path ────────────────────────────────────────────────
		// A profile scores its candidate set live, in-request: pull the rows
		// (company-scoped when the profile has companies, else the whole corpus,
		// most-recent first up to the cap), score each against the profile's
		// current criteria in JS, then filter/sort/paginate. No precomputed
		// job_profile_matches, so scores always reflect the profile right now.
		if (profile_id) {
			const profile = await loadScorableProfile(db, profile_id);

			const candSql = `
				SELECT
					j.id, j.title, j.company, j.location, j.workplace_type,
					j.salary_min, j.salary_max, j.source_site, j.url,
					j.posted_date, j.scraped_at, j.ats, j.slug, j.description,
					${stateCols}
				FROM jobs j
				${joinClause}
				${whereClause}
				ORDER BY j.scraped_at DESC
				LIMIT ${SCORE_CANDIDATE_CAP}`;

			const candidates = await db
				.prepare(candSql)
				.bind(...binds)
				.all<JobRow>();

			if (candidates.results.length >= SCORE_CANDIDATE_CAP) {
				logger.warn('score-on-read candidate cap hit', {
					profile_id,
					cap: SCORE_CANDIDATE_CAP,
				});
			}

			const scored = candidates.results
				.map((r) => {
					const { score, breakdown } = scoreJob(
						{
							title: r.title,
							description: r.description,
							workplace_type: r.workplace_type,
							salary_min: r.salary_min,
						},
						profile
					);
					return {
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
						score,
						score_breakdown: breakdown,
						state: userId ? ((r.row_state as 'new' | null) ?? 'new') : null,
					};
				})
				.filter((j) => j.score >= min_score);

			if (sort === 'score') {
				scored.sort((a, b) => b.score - a.score || b.scraped_at.localeCompare(a.scraped_at));
			} else {
				scored.sort((a, b) => b.scraped_at.localeCompare(a.scraped_at));
			}

			const total = scored.length;
			const pageJobs = scored.slice(offset, offset + limit);

			return c.json(
				{
					success: true as const,
					data: {
						jobs: pageJobs,
						total,
						page,
						limit,
						has_more: offset + pageJobs.length < total,
					},
				},
				200
			);
		}

		// ── Unscored path ─────────────────────────────────────────────────────
		// No profile: list the corpus (optionally per-user filtered), paginated
		// in SQL. Scores are absent, so every row reports a neutral 0.
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
				${stateCols}
			FROM jobs j
			${joinClause}
			${whereClause}
			ORDER BY j.scraped_at DESC
			LIMIT ? OFFSET ?`;

		const rows = await db
			.prepare(dataSql)
			.bind(...binds, limit, offset)
			.all<Omit<JobRow, 'description'>>();

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
			score: 0,
			score_breakdown: zeroBreakdown,
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
// GET /jobs/preflight — "does this connect to something real?"
//
// Powers the profile editor's per-field probes: given a keyword and/or a role
// type, count how many corpus jobs it would match, so the user sees a live
// signal ("312 matching jobs") before saving it into a profile. Read-only,
// unauthenticated (same posture as GET /jobs).
//
// MUST be registered before GET /jobs/{id} — OpenAPIHono resolves in
// registration order, so a later static route loses to the earlier param route
// (/jobs/{id} would otherwise capture "preflight" as an id). Verified.
// ============================================================================

app.openapi(
	createRoute({
		method: 'get',
		path: '/jobs/preflight',
		tags: ['Jobs'],
		summary: 'Count corpus jobs matching a keyword and/or role type (editor probe)',
		request: {
			query: z.object({
				keyword: z
					.string()
					.optional()
					.openapi({ description: 'Match in title or description (case-insensitive)' }),
				role_type: z
					.string()
					.optional()
					.openapi({ description: 'One of the seniority buckets; matched against title' }),
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
		const { keyword, role_type } = c.req.valid('query');
		const db = c.env.JOB_PLATFORM_DB;

		const wheres: string[] = [];
		const binds: string[] = [];

		const kw = keyword?.trim();
		if (kw) {
			const like = `%${kw.toLowerCase()}%`;
			wheres.push('(LOWER(title) LIKE ? OR LOWER(description) LIKE ?)');
			binds.push(like, like);
		}

		const rt = role_type?.trim();
		if (rt) {
			const patterns = SENIORITY_KEYWORDS[rt.toUpperCase()] ?? [rt.toLowerCase()];
			const ors = patterns.map(() => 'LOWER(title) LIKE ?');
			wheres.push(`(${ors.join(' OR ')})`);
			for (const p of patterns) binds.push(`%${p.toLowerCase()}%`);
		}

		const whereClause = wheres.length ? `WHERE ${wheres.join(' AND ')}` : '';
		const row = await db
			.prepare(`SELECT COUNT(*) as n FROM jobs ${whereClause}`)
			.bind(...binds)
			.first<{ n: number }>();

		return c.json({ success: true as const, data: { count: row?.n ?? 0 } }, 200);
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
			seniority_match: 0,
			remote_match: 0,
			salary_match: 0,
		};

		if (profile_id) {
			const profile = await loadScorableProfile(db, profile_id);
			const result = scoreJob(
				{
					title: row.title as string,
					description: row.description as string,
					workplace_type: row.workplace_type as string,
					salary_min: row.salary_min as number | null,
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
	if (!tierAtLeast(auth, 'friend')) {
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

// ============================================================================
// V3 — tailored application packets (POST /jobs/:id/{resume,cover-letter})
//
// The caller (dashboard user, admin/friend) hits these; we pull the job row and
// proxy title/company/description to resume-api over a Cloudflare service
// binding. The binding bypasses the public edge, so we stamp X-Edge-Auth +
// X-Hadoku-Tier: service ourselves — resume-api's in-worker gate admits service
// on these two routes.
// ============================================================================

interface JobTailoringFields {
	title: string;
	company: string;
	description: string;
}

async function loadTailoringFields(
	db: AppEnv['JOB_PLATFORM_DB'],
	id: string
): Promise<JobTailoringFields | null> {
	return db
		.prepare('SELECT title, company, description FROM jobs WHERE id = ?')
		.bind(id)
		.first<JobTailoringFields>();
}

async function callResumeBinding(
	env: AppEnv,
	path: string,
	payload: Record<string, unknown>
): Promise<Response> {
	if (!env.RESUME) {
		throw new Error('RESUME service binding not configured');
	}
	return env.RESUME.fetch(`https://resume-api${path}`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'X-Edge-Auth': env.EDGE_AUTH_SECRET ?? '',
			'X-Hadoku-Tier': 'service',
		},
		body: JSON.stringify(payload),
	});
}

// Plain Hono routes (not app.openapi) — these are internal proxies whose
// response shape is resume-api's, so they stay out of the OpenAPI schema and
// dodge zod-openapi's strict handler-return typing. gateAuthed (admin/friend)
// runs first via the middleware registration, then the handler.
app.post('/jobs/:id/resume', gateAuthed);
app.post('/jobs/:id/cover-letter', gateAuthed);

app.post('/jobs/:id/resume', async (c) => {
	const id = c.req.param('id');
	let opts: Record<string, unknown> = {};
	try {
		opts = await c.req.json();
	} catch {
		// no/empty body is fine — all fields are optional passthroughs
	}
	const job = await loadTailoringFields(c.env.JOB_PLATFORM_DB, id);
	if (!job) {
		return c.json(
			{ success: false as const, error: 'Not found', message: `Job '${id}' not found` },
			404
		);
	}

	const res = await callResumeBinding(c.env, '/resume/api/tailored-resume', {
		job_title: job.title,
		company: job.company,
		description: job.description,
		...(typeof opts.profile_type === 'string' ? { profile_type: opts.profile_type } : {}),
		...(typeof opts.tailor === 'boolean' ? { tailor: opts.tailor } : {}),
	});
	if (!res.ok) {
		const detail = await res.text();
		return c.json(
			{
				success: false as const,
				error: 'Upstream error',
				message: `resume-api ${res.status}: ${detail.slice(0, 300)}`,
			},
			502
		);
	}
	const data = await res.json();
	return c.json({ success: true as const, data }, 200);
});

app.post('/jobs/:id/cover-letter', async (c) => {
	const id = c.req.param('id');
	let opts: Record<string, unknown> = {};
	try {
		opts = await c.req.json();
	} catch {
		// no/empty body is fine
	}
	const job = await loadTailoringFields(c.env.JOB_PLATFORM_DB, id);
	if (!job) {
		return c.json(
			{ success: false as const, error: 'Not found', message: `Job '${id}' not found` },
			404
		);
	}

	const res = await callResumeBinding(c.env, '/resume/api/cover-letter', {
		job_title: job.title,
		company: job.company,
		description: job.description,
		...(opts.tone === 'formal' || opts.tone === 'conversational' ? { tone: opts.tone } : {}),
	});
	if (!res.ok) {
		const detail = await res.text();
		return c.json(
			{
				success: false as const,
				error: 'Upstream error',
				message: `resume-api ${res.status}: ${detail.slice(0, 300)}`,
			},
			502
		);
	}
	const data = await res.json();
	return c.json({ success: true as const, data }, 200);
});

// POST /jobs/:id/packet-link — mint a shareable résumé+cover-letter packet link.
//
// The client generates the résumé and cover letter first (the two routes above,
// each fast under its own edge carve-out) and posts the finished markdown here.
// We mint a resume-api variant with that PRE-RENDERED content — no LLM at mint,
// so it returns instantly and never risks the edge timeout — and hand back the
// public hadoku.me/resume?v={slug} link. resume-api's /variants admits our
// service-tier binding call (requireMinTier('friend')).
app.post('/jobs/:id/packet-link', gateAuthed);
app.post('/jobs/:id/packet-link', async (c) => {
	const id = c.req.param('id');
	let opts: Record<string, unknown> = {};
	try {
		opts = await c.req.json();
	} catch {
		// fall through to the required-field check below
	}
	const resumeMarkdown = typeof opts.resume_markdown === 'string' ? opts.resume_markdown : '';
	if (!resumeMarkdown) {
		return c.json(
			{ success: false as const, error: 'Bad request', message: 'resume_markdown is required' },
			400
		);
	}
	const coverLetterMarkdown =
		typeof opts.cover_letter_markdown === 'string' ? opts.cover_letter_markdown : undefined;
	// Default 365d — a variant is ~8.6KB in KV, so long retention is effectively
	// free (KV caps at 25MB/value); a stale shared link outliving its usefulness
	// is a better failure than one that 404s while someone's still considering it.
	const ttlDays = typeof opts.ttl_days === 'number' ? opts.ttl_days : 365;

	const job = await loadTailoringFields(c.env.JOB_PLATFORM_DB, id);
	if (!job) {
		return c.json(
			{ success: false as const, error: 'Not found', message: `Job '${id}' not found` },
			404
		);
	}

	const res = await callResumeBinding(c.env, '/resume/api/variants', {
		label: `${job.company} — ${job.title}`,
		markdown: resumeMarkdown,
		...(coverLetterMarkdown ? { cover_letter_markdown: coverLetterMarkdown } : {}),
		company: job.company,
		job_title: job.title,
		ttl_days: ttlDays,
	});
	if (!res.ok) {
		const detail = await res.text();
		return c.json(
			{
				success: false as const,
				error: 'Upstream error',
				message: `resume-api ${res.status}: ${detail.slice(0, 300)}`,
			},
			502
		);
	}
	const variant: { slug?: string } = await res.json();
	if (!variant.slug) {
		return c.json(
			{ success: false as const, error: 'Upstream error', message: 'resume-api returned no slug' },
			502
		);
	}
	const url = `https://hadoku.me/resume?v=${encodeURIComponent(variant.slug)}`;
	return c.json({ success: true as const, data: { slug: variant.slug, url } }, 200);
});

export const jobRoutes = app;
