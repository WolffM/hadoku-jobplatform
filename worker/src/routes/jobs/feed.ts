import { createRoute, z } from '@hono/zod-openapi';
import type { AppEnv } from '../../types.js';
import { JobsResponseSchema, ErrorResponseSchema } from '../../schemas.js';
import { scoreJob, scoreJobLightAxes } from '../../scoring.js';
import { loadScorableProfile } from '../../profileScore.js';
import { logger } from '../../logger.js';
import {
	asApplicationStatus,
	asRoleLevel,
	asRoleTrack,
	maybeUserId,
	ZERO_BREAKDOWN,
	type JobsApp,
} from './shared.js';
import { rankIsCurrent, scheduleRankBuild } from '../../rank.js';

// Two-stage score-on-read. Descriptions are what make whole-corpus scoring
// impossible in one pass (30k rows × ~4KB each), but they feed only ONE factor
// (keyword_match, weight 0.4). So the light pass ranks the ENTIRE corpus
// without descriptions using an optimistic score upper bound, and only the top
// FULL_SCORE_CAP candidates get their descriptions fetched and fully scored.
// A job outside the shortlist has an upper bound below the shortlist's floor —
// it could not have out-ranked them even with a perfect description match.
//
// LIGHT_CANDIDATE_CAP is a safety valve on the light pass itself (rows without
// descriptions are ~300 bytes); hitting it is logged, not silent.
const LIGHT_CANDIDATE_CAP = 50000;
const FULL_SCORE_CAP = 800;
// SQLite binds at most 100 parameters per statement; description fetches for
// the shortlist chunk their IN () lists accordingly (one db.batch round trip).
const ID_CHUNK = 100;

// Tier-1 feedback effect: a downvoted job sinks regardless of its score, an
// upvote boosts it. Applied after scoring so the model itself stays pure.
function applyVote(score: number, vote: unknown): number {
	if (vote === -1) return Math.round(score * 0.15 * 1000) / 1000;
	// Upvote boost is ASYMPTOTIC — a quarter of the way toward 1.0, never
	// reaching it. The old min(1, ×1.2+0.02) clamped any upvoted 0.82+ job to a
	// flat 1.00, recreating the fake-precision score wall the owner rejected
	// (his own upvoted Cohere job showed a lone 1.00 over a 0.82 field).
	if (vote === 1) return Math.round((score + (1 - score) * 0.25) * 1000) / 1000;
	return score;
}

// Staleness: the owner's first application attempt was a 3-month-old LinkedIn
// posting that had closed. Freshness = the newest of posted/first-seen/last-
// seen; board postings keep last_seen_at advancing while listed, so only
// genuinely dead or unverifiable-old rows decay.
const DAY_MS = 86_400_000;
function staleFactor(row: {
	posted_date: string | null;
	scraped_at: string;
	last_seen_at?: string | null;
}): number {
	const stamps = [row.posted_date, row.scraped_at, row.last_seen_at].filter(Boolean) as string[];
	const newest = stamps.reduce((a, b) => (a > b ? a : b), '');
	const age = (Date.now() - Date.parse(newest)) / DAY_MS;
	if (!Number.isFinite(age) || age <= 30) return 1.0;
	if (age <= 60) return 0.7;
	return 0.25;
}

// Ghost-posting decay: a req still LISTED (liveness fresh, so the cull rightly
// spares it) but POSTED many months ago is pipeline-filler risk — a 5-month-old
// Cohere req topped the owner's feed. Decays by posted age regardless of
// liveness; lens views exclude the >GHOST_LENS_DAYS tail entirely.
const GHOST_LENS_DAYS = 120;
function postedAgeFactor(postedDate: string | null): number {
	if (!postedDate) return 1.0;
	const age = (Date.now() - Date.parse(postedDate)) / DAY_MS;
	if (!Number.isFinite(age) || age <= 60) return 1.0;
	if (age <= 120) return 0.9;
	if (age <= 180) return 0.75;
	return 0.6;
}
function postedDaysAgo(postedDate: string | null): number {
	if (!postedDate) return 0;
	const age = (Date.now() - Date.parse(postedDate)) / DAY_MS;
	return Number.isFinite(age) ? age : 0;
}

/**
 * Diversification: a company you already have applications out to sinks.
 *
 * Applied live, beside the vote and staleness factors, and deliberately NOT
 * folded into the precomputed `bound`. That bound is per-PROFILE and is trusted
 * while the profile's criteria hash holds; this is per-USER and moves every time
 * an application is queued, so storing it would either go stale silently or
 * invalidate the whole ranking on every click.
 *
 * Multiplicative for the same reason staleness and ghost-age are: the axes have
 * already agreed this job fits, and what is being expressed is a discount on
 * that fit rather than a different opinion about it. A subtractive penalty would
 * also hit a 0.30 job harder in relative terms than a 0.80 one, which is
 * backwards — the strong match at a company you have flooded is exactly the one
 * still worth seeing.
 *
 * The tiers are the owner's: some penalty from the first application out, more
 * from five, most from twenty.
 */
const COMPANY_SATURATION = [
	{ from: 20, factor: 0.3 },
	{ from: 5, factor: 0.6 },
	{ from: 1, factor: 0.85 },
];

function saturationFactor(applied: number): number {
	for (const tier of COMPANY_SATURATION) if (applied >= tier.from) return tier.factor;
	return 1.0;
}

/**
 * Applications that count as "out".
 *
 * A failed or closed application is not one you are waiting on, and it should
 * not suppress the rest of a company's board — the failure is usually ours (a
 * browser lock, an unrecognised form) rather than a signal about the employer.
 */
const APPLICATION_IS_OUT = ['queued', 'filled', 'approved', 'submitted', 'needs_manual'];

/** How many applications this user has out, per company. */
async function applicationsByCompany(
	db: AppEnv['JOB_PLATFORM_DB'],
	userId: string
): Promise<Map<string, number>> {
	const rows = await db
		.prepare(
			`SELECT LOWER(j.company) AS company, COUNT(*) AS n
			 FROM applications a
			 JOIN jobs j ON j.id = a.job_id
			 WHERE a.user_id = ? AND a.status IN (${APPLICATION_IS_OUT.map(() => '?').join(',')})
			 GROUP BY LOWER(j.company)`
		)
		.bind(userId, ...APPLICATION_IS_OUT)
		.all<{ company: string; n: number }>();
	return new Map(rows.results.map((r) => [r.company, Number(r.n)]));
}

// The light pass reads the WHOLE filtered corpus, so it selects only what
// ranking needs: the five scoring inputs, the three timestamps the stale/ghost
// factors read, and the per-user join columns. Everything a card renders is a
// column the shortlist fetches in stage 2 instead — at 30k rows the display
// columns (url alone is ~2MB across the table) cost more to ship than the
// ranking does to compute.
interface LightRow {
	id: string;
	title: string;
	location: string;
	workplace_type: string;
	salary_max: number | null;
	posted_date: string | null;
	scraped_at: string;
	last_seen_at: string | null;
	role_level: string | null;
	row_state: string | null;
	row_vote: number | null;
	row_vote_reasons: string | null;
	row_application: string | null;
}

/** The display half, fetched only for rows that survive the light pass. */
interface HeavyRow {
	id: string;
	company: string;
	salary_min: number | null;
	source_site: string;
	url: string;
	application_url: string | null;
	ats: string | null;
	slug: string | null;
	role_track: string;
	description: string;
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
					hide_queued: z
						.enum(['true', 'false'])
						.optional()
						.openapi({
							description:
								'If true, exclude jobs the caller has already queued an application for, whatever ' +
								'its status. They live under Applications and Packets from that point on, and a ' +
								'feed is for postings not yet acted on. No effect when unauthed.',
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
					sort: z
						.enum(['score', 'date', 'salary', 'comp', 'interest', 'relevance'])
						.default('score')
						.openapi({
							description:
								'Sort order. comp/interest/relevance are LENSES over the score breakdown: ' +
								'they exclude floor-violating jobs (lowball comp, non-Americas remote, ' +
								'non-eng discipline), stale postings, and downvotes, then sort by that axis. ' +
								'salary sorts by raw salary_max desc.',
						}),
					workplace: z.enum(['remote', 'hybrid', 'onsite']).optional().openapi({
						description: 'Filter to one workplace type (e.g. full-remote only).',
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
				hide_queued: hideQueuedRaw,
				page,
				limit,
				sort,
				workplace,
				min_score,
				min_salary,
			} = c.req.valid('query');
			const hideDismissed = hideDismissedRaw === 'true';
			const hideQueued = hideQueuedRaw === 'true';
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

			const wheres: string[] = [];
			// Binds for the WHERE clause only. The FROM clause's own binds (the
			// per-user joins, the company slice, the rank table) are assembled per
			// query below, because which table leads the join changes between them.
			const whereBinds: (string | number)[] = [];

			// LEFT JOIN job_states once when authed so we can both surface state on
			// every row AND filter by it cheaply.
			const stateCols = userId
				? `js.state as row_state, jf.vote as row_vote, jf.reason as row_vote_reasons,
				   ap.status as row_application`
				: `NULL as row_state, NULL as row_vote, NULL as row_vote_reasons,
				   NULL as row_application`;
			// The applications join is what lets a card say "queued" after a reload.
			// Without it the feed knew only that a packet had been minted (which
			// lands a job_states row as 'saved'), so a posting already handed to the
			// runner still offered an Apply button that would queue it again.
			const userJoins = userId
				? `LEFT JOIN job_states js ON js.job_id = j.id AND js.user_id = ?
				   LEFT JOIN job_feedback jf ON jf.job_id = j.id AND jf.user_id = ?
				   LEFT JOIN applications ap ON ap.job_id = j.id AND ap.user_id = ?`
				: '';
			const userBinds: (string | number)[] = userId ? [userId, userId, userId] : [];

			// Companies are an OPTIONAL filter, not a required scope. When a profile
			// has companies, restrict its feed to their jobs; when it has none, the
			// feed is the whole corpus, ranked by the profile's other criteria
			// (keywords / levels / remote). An empty profile ⇒ everything, newest
			// first.
			let profile = null as Awaited<ReturnType<typeof loadScorableProfile>> | null;
			let hasCompanies = false;
			if (profile_id) {
				const companyCount = await db
					.prepare('SELECT COUNT(*) as n FROM profile_companies WHERE profile_id = ?')
					.bind(profile_id)
					.first<{ n: number }>();
				hasCompanies = (companyCount?.n ?? 0) > 0;

				// Track is a HARD filter, not a score factor — "I want management
				// roles" is a different question from "rank management roles higher",
				// and the old seniority weight (0.12) could never express the former.
				// 'either' expresses no constraint, so it adds no clause.
				profile = await loadScorableProfile(db, profile_id);
				if (profile.track !== 'either') {
					wheres.push('j.role_track = ?');
					whereBinds.push(profile.track);
				}
			}

			if (workplace) {
				wheres.push('j.workplace_type = ?');
				whereBinds.push(workplace);
			}

			// Salary is a view filter now, never a scoring criterion. Jobs with no
			// listed salary survive it: salary_max is NULL on the large majority of
			// postings, so excluding them would empty the feed rather than narrow it.
			if (min_salary !== undefined) {
				wheres.push('(j.salary_max IS NULL OR j.salary_max >= ?)');
				whereBinds.push(min_salary);
			}

			// State / hide_dismissed clauses reference the LEFT JOIN above, which
			// only exists when authed. Skip them otherwise — they'd dangle on
			// `js.state` and the SQL would fail to parse.
			if (userId) {
				if (stateFilter === 'new') {
					wheres.push('js.state IS NULL');
				} else if (stateFilter) {
					wheres.push('js.state = ?');
					whereBinds.push(stateFilter);
				} else if (hideDismissed) {
					wheres.push("(js.state IS NULL OR js.state != 'dismissed')");
				}
				// An explicit state= filter is the owner asking to see a specific
				// slice, so it wins: hiding queued rows there would answer a
				// different question than the one asked.
				if (hideQueued && !stateFilter) wheres.push('ap.id IS NULL');
			}

			const whereClause = wheres.length > 0 ? `WHERE ${wheres.join(' AND ')}` : '';
			const andWheres = wheres.length > 0 ? ` AND ${wheres.join(' AND ')}` : '';

			// ── Score-on-read path ────────────────────────────────────────────────
			// A profile scores its candidate set live, in-request: pull the rows
			// (company-scoped when the profile has companies, else the whole corpus,
			// most-recent first up to the cap), score each against the profile's
			// current criteria in JS, then filter/sort/paginate. Scores always
			// reflect the profile right now.
			if (profile_id && profile) {
				// Stage 1 — the candidate rows the shortlist is chosen from.
				//
				// Two ways in. When job_profile_rank holds a CURRENT ranking for this
				// profile, the light pass's sort key is already a column, so SQL can
				// order and cap — which is the whole point: the cap is 800, not the
				// corpus, so this reads 800 rows instead of 31,748.
				//
				// Otherwise we rank live, exactly as before. That is the fallback for
				// a profile that has never been ranked, whose criteria just changed,
				// or whose ranking does not yet cover the newest jobs — and it is why
				// a missing or half-written rank table costs latency and never
				// correctness.
				// sort=score only. The lens sorts rank by a DIFFERENT key
				// (comp_fit / interest_bound / relevance_bound), so taking the top
				// 800 by `bound` would hand them the wrong candidates; date and
				// salary rank on columns of their own. Those keep the live path
				// until they have stored keys too.
				const rankUsable = sort === 'score' && (await rankIsCurrent(db, profile_id, profile));

				// No usable ranking: this request is served the slow way, and the
				// ranking is built behind it so the next one is not. That makes the
				// fast path self-installing — it arrives the first time a profile's
				// feed is actually opened, instead of waiting for someone to run
				// /ingest/rebuild-rank. Tying the cost to USE is the point: a Default
				// profile is materialised for every identity that calls GET
				// /profiles, and most of those never look at a feed.
				if (!rankUsable && sort === 'score') {
					scheduleRankBuild(c, db, profile_id, profile);
				}

				// WHICH TABLE LEADS THE JOIN is the whole performance story here, and
				// SQLite will not get it right on its own.
				//
				// A company-scoped profile is a narrow slice of a wide corpus — three
				// companies, 953 of 33,103 jobs. Written as a plain join, the planner
				// sees `ORDER BY r.bound DESC` and leads with idx_job_profile_rank_order
				// so it can skip the sort, then probes jobs + profile_companies for every
				// rank row it walks. Because the slice is 3% of the corpus, LIMIT 800
				// does not fill until nearly all of it is walked: 61,673 rows read and
				// ~1.97s of SQL per feed request. That is the cost the owner feels, and
				// it is also what starves the drawer's own query — one isolate, one
				// thread, so a deep link into a posting waits behind its own feed.
				//
				// Leading with profile_companies instead reads 2,866 rows in 32ms and
				// sorts 953 rows in memory, which is free at this size. CROSS JOIN is
				// how that is said in SQLite: same semantics as INNER JOIN, but it
				// pins the loop order instead of letting the planner choose. A CTE
				// (even AS MATERIALIZED) does NOT work — the planner still leads with
				// the rank index inside it.
				const rankedFrom = hasCompanies
					? `FROM profile_companies pc
					   CROSS JOIN jobs j ON j.ats = pc.ats AND j.slug = pc.slug
					   CROSS JOIN job_profile_rank r ON r.profile_id = ? AND r.job_id = j.id
					   ${userJoins}
					   WHERE pc.profile_id = ?${andWheres}`
					: `FROM job_profile_rank r
					   JOIN jobs j ON j.id = r.job_id
					   ${userJoins}
					   WHERE r.profile_id = ?${andWheres}`;
				// Same reasoning for the live fallback: without a leading
				// profile_companies it scans jobs by scraped_at and discards 97% of
				// what it reads.
				const liveFrom = hasCompanies
					? `FROM profile_companies pc
					   CROSS JOIN jobs j ON j.ats = pc.ats AND j.slug = pc.slug
					   ${userJoins}
					   WHERE pc.profile_id = ?${andWheres}`
					: `FROM jobs j
					   ${userJoins}
					   ${whereClause}`;

				const candCols = `
					SELECT
						j.id, j.title, j.location, j.workplace_type, j.salary_max,
						j.posted_date, j.scraped_at, j.last_seen_at, j.role_level,
						${stateCols}`;
				const candSql = rankUsable
					? `${candCols}
					${rankedFrom}
					ORDER BY r.bound DESC, j.scraped_at DESC
					LIMIT ${FULL_SCORE_CAP}`
					: `${candCols}
					${liveFrom}
					ORDER BY j.scraped_at DESC
					LIMIT ${LIGHT_CANDIDATE_CAP}`;

				// Binds follow the order the placeholders appear in the FROM clause:
				// the rank join's profile_id, then the user joins, then the company
				// slice's profile_id, then the WHERE clause.
				const candBinds = rankUsable
					? hasCompanies
						? // pc.profile_id is in the WHERE, so it binds after the joins;
							// the rank join's own profile_id binds before them.
							[profile_id, ...userBinds, profile_id, ...whereBinds]
						: // No company slice: the rank table leads, and its profile_id
							// moves to the WHERE — so it binds after the user joins.
							[...userBinds, profile_id, ...whereBinds]
					: hasCompanies
						? [...userBinds, profile_id, ...whereBinds]
						: [...userBinds, ...whereBinds];

				const candidates = await db
					.prepare(candSql)
					.bind(...candBinds)
					.all<LightRow>();

				if (candidates.results.length >= LIGHT_CANDIDATE_CAP) {
					logger.warn('score-on-read light-pass cap hit', {
						profile_id,
						cap: LIGHT_CANDIDATE_CAP,
					});
				}

				// Shortlist: score/lens sorts rank by light-pass axes; other sorts
				// shortlist by their own key, since scoring is decoration there.
				// Lens views (comp/interest/relevance) also apply the hard floors:
				// sunk jobs, downvotes, and stale rows don't top ANY lens.
				const light = candidates.results;
				const isLens = sort === 'comp' || sort === 'interest' || sort === 'relevance';
				// Ranked alongside the row: the bound each candidate is sorted by.
				// Stage 2 reads it back to prove it has fetched far enough.
				let shortlist: { r: LightRow; bound: number }[];
				if (sort === 'score' || isLens) {
					let ranked = light.map((r) => ({
						r,
						axes: scoreJobLightAxes(
							{
								title: r.title,
								location: r.location,
								workplace_type: r.workplace_type,
								salary_max: r.salary_max,
								role_level: asRoleLevel(r.role_level),
							},
							profile
						),
					}));
					if (isLens) {
						ranked = ranked.filter(
							({ r, axes }) =>
								!axes.penalized &&
								r.row_vote !== -1 &&
								staleFactor(r) === 1.0 &&
								postedDaysAgo(r.posted_date) <= GHOST_LENS_DAYS
						);
					}
					const lensKey = (a: (typeof ranked)[number]) =>
						sort === 'comp'
							? a.axes.comp_fit
							: sort === 'interest'
								? a.axes.interest_bound
								: sort === 'relevance'
									? a.axes.relevance_bound
									: a.axes.bound;
					shortlist = ranked
						.map((x) => ({ r: x.r, bound: lensKey(x), tie: x.axes.bound }))
						.sort(
							(a, b) =>
								b.bound - a.bound || b.tie - a.tie || b.r.scraped_at.localeCompare(a.r.scraped_at)
						)
						.slice(0, FULL_SCORE_CAP);
				} else if (sort === 'salary') {
					shortlist = [...light]
						.sort(bySalaryDesc)
						.slice(0, FULL_SCORE_CAP)
						.map((r) => ({ r, bound: 1 }));
				} else {
					shortlist = [...light]
						.sort((a, b) => b.scraped_at.localeCompare(a.scraped_at))
						.slice(0, FULL_SCORE_CAP)
						.map((r) => ({ r, bound: 1 }));
				}

				// Stage 2 — the display columns and the description, fetched only for
				// rows the answer can actually depend on.
				//
				// Descriptions average ~7.5KB, so fetching the whole shortlist cost
				// ~6MB per request to render 25 rows. Instead: score a window past the
				// requested page, then check the window was big enough. Because the
				// shortlist is ordered by an upper bound on the final sort key, an
				// unscored candidate can only place ahead of the worst row we return if
				// its BOUND does — so `worst >= shortlist[cursor].bound` proves the page
				// is the same one full scoring would have produced.
				// One read for the whole page: the counts are per-user, not per-row.
				const appliedPerCompany = userId
					? await applicationsByCompany(db, userId)
					: new Map<string, number>();

				const heavyById = new Map<string, HeavyRow>();
				const fetchHeavy = async (from: number, to: number): Promise<void> => {
					const chunks: string[][] = [];
					for (let i = from; i < to; i += ID_CHUNK) {
						chunks.push(shortlist.slice(i, Math.min(i + ID_CHUNK, to)).map((x) => x.r.id));
					}
					if (chunks.length === 0) return;
					const res = await db.batch<HeavyRow>(
						chunks.map((ids) =>
							db
								.prepare(
									`SELECT id, company, salary_min, source_site, url, application_url,
									        ats, slug, role_track, description
									 FROM jobs WHERE id IN (${ids.map(() => '?').join(',')})`
								)
								.bind(...ids)
						)
					);
					for (const r of res) for (const row of r.results) heavyById.set(row.id, row);
				};

				const scoreWindow = (to: number) =>
					shortlist
						.slice(0, to)
						.map(({ r }) => {
							const roleLevel = asRoleLevel(r.role_level);
							const h = heavyById.get(r.id);
							const { score, breakdown } = scoreJob(
								{
									title: r.title,
									description: h?.description ?? '',
									location: r.location,
									workplace_type: r.workplace_type,
									salary_max: r.salary_max,
									role_level: roleLevel,
								},
								profile
							);
							return {
								id: r.id,
								title: r.title,
								company: h?.company ?? '',
								location: r.location,
								workplace_type: r.workplace_type,
								salary_min: h?.salary_min ?? null,
								salary_max: r.salary_max,
								source_site: h?.source_site ?? '',
								url: h?.url ?? '',
								application_url: h?.application_url ?? null,
								posted_date: r.posted_date,
								scraped_at: r.scraped_at,
								ats: h?.ats ?? null,
								slug: h?.slug ?? null,
								role_track: asRoleTrack(h?.role_track ?? ''),
								role_level: roleLevel,
								score: applyVote(
									Math.round(
										score *
											staleFactor(r) *
											postedAgeFactor(r.posted_date) *
											saturationFactor(
												appliedPerCompany.get((h?.company ?? '').toLowerCase()) ?? 0
											) *
											1000
									) / 1000,
									r.row_vote
								),
								score_breakdown: breakdown,
								state: userId ? ((r.row_state as 'new' | null) ?? 'new') : null,
								application_status: asApplicationStatus(r.row_application),
								vote: (r.row_vote as 1 | -1 | null) ?? null,
								vote_reasons: r.row_vote_reasons ? String(r.row_vote_reasons).split(',') : [],
							};
						})
						.filter((j) => j.score >= min_score);

				// The value the stopping rule compares: whatever the active sort ranks
				// by, so the certificate is checked against the same key the page is
				// ordered by rather than a proxy for it.
				const sortKey = (j: ReturnType<typeof scoreWindow>[number]) =>
					sort === 'comp'
						? j.score_breakdown.comp_fit
						: sort === 'interest'
							? j.score_breakdown.domain_interest
							: sort === 'relevance'
								? j.score_breakdown.relevance
								: j.score;
				const sortScored = (rows: ReturnType<typeof scoreWindow>) => {
					if (sort === 'score') {
						rows.sort((a, b) => b.score - a.score || b.scraped_at.localeCompare(a.scraped_at));
					} else if (sort === 'comp' || sort === 'interest' || sort === 'relevance') {
						rows.sort((a, b) => sortKey(b) - sortKey(a) || b.score - a.score);
					} else if (sort === 'salary') {
						rows.sort(bySalaryDesc);
					} else {
						rows.sort((a, b) => b.scraped_at.localeCompare(a.scraped_at));
					}
					return rows;
				};

				// How much of the shortlist actually needs a description.
				//
				// date and salary rank on columns stage 1 already selected, so the
				// shortlist is ALREADY in final order — the description only fills in the
				// decorative score on rows the caller can see, and fetching it for the
				// other 775 changes nothing in the response. score and the lens sorts do
				// rank on the description, and their light-pass bound is too loose to
				// prove an early cut is safe (relevanceUpperBound assumes EVERY keyword
				// hits, so thousands of candidates share the top bound), so those still
				// score the whole shortlist rather than quietly narrowing the field.
				const orderIsFinal = sort === 'date' || sort === 'salary';
				// min_score decides `total`, so a filtered feed has to score everything.
				const scoreTo =
					orderIsFinal && min_score === 0
						? Math.min(shortlist.length, offset + limit)
						: shortlist.length;

				await fetchHeavy(0, scoreTo);
				const scored = sortScored(scoreWindow(scoreTo));

				// Unchanged from scoring the whole shortlist: min_score is the only
				// filter that can drop rows here, and that path scores all of them.
				const total = min_score > 0 ? scored.length : shortlist.length;
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
			//
			// No company slice here — `profile_companies` is only ever joined for a
			// profile, and this branch is the one without one — so the plain join
			// order is the right one and no CROSS JOIN pinning is needed.
			const plainBinds = [...userBinds, ...whereBinds];
			const countSql = `SELECT COUNT(*) as total FROM jobs j ${userJoins} ${whereClause}`;
			const countRow = await db
				.prepare(countSql)
				.bind(...plainBinds)
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
					j.salary_min, j.salary_max, j.source_site, j.url, j.application_url,
					j.posted_date, j.scraped_at, j.ats, j.slug,
					j.role_track, j.role_level,
					${stateCols}
				FROM jobs j
				${userJoins}
				${whereClause}
				${orderBy}
				LIMIT ? OFFSET ?`;

			const rows = await db
				.prepare(dataSql)
				.bind(...plainBinds, limit, offset)
				.all<LightRow & HeavyRow>();

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
				application_url: r.application_url,
				posted_date: r.posted_date,
				scraped_at: r.scraped_at,
				ats: r.ats,
				slug: r.slug,
				role_track: asRoleTrack(r.role_track),
				role_level: asRoleLevel(r.role_level),
				score: 0,
				score_breakdown: ZERO_BREAKDOWN,
				state: userId ? ((r.row_state as 'new' | null) ?? 'new') : null,
				application_status: asApplicationStatus(r.row_application),
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
