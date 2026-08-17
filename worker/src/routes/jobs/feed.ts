import { createRoute, z } from '@hono/zod-openapi';
import { JobsResponseSchema, ErrorResponseSchema } from '../../schemas.js';
import { scoreJob } from '../../scoring.js';
import { loadScorableProfile } from '../../profileScore.js';
import { logger } from '../../logger.js';
import { asRoleLevel, asRoleTrack, maybeUserId, ZERO_BREAKDOWN, type JobsApp } from './shared.js';

// Cap on candidates scored in-request for a profile feed. Profile feeds are
// scoped to the profile's companies, so this is comfortably above any real
// slice; beyond it we score the most-recent CAP rows and log the truncation.
const SCORE_CANDIDATE_CAP = 3000;

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
	role_track: string;
	role_level: string | null;
	description: string;
	row_state: string | null;
}

/** Highest ceiling first; postings with no stated salary sort to the bottom. */
function bySalaryDesc(
	a: { salary_max: number | null; scraped_at: string },
	b: { salary_max: number | null; scraped_at: string }
): number {
	if (a.salary_max === null && b.salary_max === null) {
		return b.scraped_at.localeCompare(a.scraped_at);
	}
	if (a.salary_max === null) return 1;
	if (b.salary_max === null) return -1;
	return b.salary_max - a.salary_max || b.scraped_at.localeCompare(a.scraped_at);
}

export function registerFeedRoute(app: JobsApp): void {
	app.openapi(
		createRoute({
			method: 'get',
			path: '/jobs',
			tags: ['Jobs'],
			summary: 'List jobs (optionally scored, or filtered by triage state)',
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
					page: z.coerce
						.number()
						.int()
						.positive()
						.default(1)
						.openapi({ description: 'Page number' }),
					limit: z.coerce
						.number()
						.int()
						.min(1)
						.max(100)
						.default(25)
						.openapi({ description: 'Results per page' }),
					sort: z.enum(['score', 'date', 'salary']).default('score').openapi({
						description: 'Sort order. salary sorts by salary_max desc, unlisted last.',
					}),
					min_score: z.coerce
						.number()
						.min(0)
						.max(1)
						.default(0)
						.openapi({ description: 'Minimum score filter' }),
					min_salary: z.coerce
						.number()
						.min(0)
						.optional()
						.openapi({
							description:
								'View filter: drop jobs whose salary_max is below this. Jobs with no listed ' +
								'salary are kept — most postings omit it, and hiding them would hide the corpus.',
						}),
				}),
			},
			responses: {
				200: {
					description: 'Job list',
					content: { 'application/json': { schema: JobsResponseSchema } },
				},
				401: {
					description: 'state= requires auth',
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
				min_salary,
			} = c.req.valid('query');
			const hideDismissed = hideDismissedRaw === 'true';
			const db = c.env.JOB_PLATFORM_DB;
			const offset = (page - 1) * limit;

			// state= requires an authed caller — it explicitly opts into per-user
			// filtering and the wrong answer is misleading. hide_dismissed is treated
			// as a no-op for unauthed callers (no per-user join, nothing to hide) so
			// the UI can default it on without forcing a pre-flight auth check.
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
			// (keywords / levels / remote). An empty profile ⇒ everything, newest
			// first.
			let profile = null as Awaited<ReturnType<typeof loadScorableProfile>> | null;
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

				// Track is a HARD filter, not a score factor — "I want management
				// roles" is a different question from "rank management roles higher",
				// and the old seniority weight (0.12) could never express the former.
				// 'either' expresses no constraint, so it adds no clause.
				profile = await loadScorableProfile(db, profile_id);
				if (profile.track !== 'either') {
					wheres.push('j.role_track = ?');
					binds.push(profile.track);
				}
			}

			// Salary is a view filter now, never a scoring criterion. Jobs with no
			// listed salary survive it: salary_max is NULL on the large majority of
			// postings, so excluding them would empty the feed rather than narrow it.
			if (min_salary !== undefined) {
				wheres.push('(j.salary_max IS NULL OR j.salary_max >= ?)');
				binds.push(min_salary);
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
			if (profile_id && profile) {
				const candSql = `
					SELECT
						j.id, j.title, j.company, j.location, j.workplace_type,
						j.salary_min, j.salary_max, j.source_site, j.url,
						j.posted_date, j.scraped_at, j.ats, j.slug,
						j.role_track, j.role_level, j.description,
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
						const roleLevel = asRoleLevel(r.role_level);
						const { score, breakdown } = scoreJob(
							{
								title: r.title,
								description: r.description,
								workplace_type: r.workplace_type,
								role_level: roleLevel,
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
							role_track: asRoleTrack(r.role_track),
							role_level: roleLevel,
							score,
							score_breakdown: breakdown,
							state: userId ? ((r.row_state as 'new' | null) ?? 'new') : null,
						};
					})
					.filter((j) => j.score >= min_score);

				if (sort === 'score') {
					scored.sort((a, b) => b.score - a.score || b.scraped_at.localeCompare(a.scraped_at));
				} else if (sort === 'salary') {
					scored.sort(bySalaryDesc);
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

			// Unlisted salaries sort last rather than first — NULL collates low in
			// SQLite, so without the leading IS NULL term "sort by salary" would open
			// on the postings that don't state one.
			const orderBy =
				sort === 'salary'
					? 'ORDER BY (j.salary_max IS NULL), j.salary_max DESC, j.scraped_at DESC'
					: 'ORDER BY j.scraped_at DESC';

			const dataSql = `
				SELECT
					j.id, j.title, j.company, j.location, j.workplace_type,
					j.salary_min, j.salary_max, j.source_site, j.url,
					j.posted_date, j.scraped_at, j.ats, j.slug,
					j.role_track, j.role_level,
					${stateCols}
				FROM jobs j
				${joinClause}
				${whereClause}
				${orderBy}
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
				role_track: asRoleTrack(r.role_track),
				role_level: asRoleLevel(r.role_level),
				score: 0,
				score_breakdown: ZERO_BREAKDOWN,
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
}
