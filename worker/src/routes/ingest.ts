import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { AppEnv } from '../types.js';
import { requireUserType, type HadokuAuthContext } from '@wolffm/worker-utils';
import { IngestPayloadSchema, IngestResponseSchema } from '../schemas.js';
import { scoreJob } from '../scoring.js';
import { scoreProfileAgainstAllJobs } from '../rescore.js';
import { parseAtsSlug } from '../slugParse.js';

interface RouteContext {
	Bindings: AppEnv;
	Variables: { authContext: HadokuAuthContext };
}

const app = new OpenAPIHono<RouteContext>();

// /ingest is the scraper webhook target — hadoku-scrape's jobboards orchestrator
// POSTs batches with its HADOKU_SERVICE_KEY (service tier). Same shape as the
// monitoring-api/contact-api service-tier carve-outs for internal writes.
// /rescore and /backfill-slugs stay admin/friend — operator tools, not webhooks.
app.use('/ingest', requireUserType(['admin', 'friend', 'service']));
app.use('/ingest/rescore', requireUserType(['admin', 'friend']));
app.use('/ingest/backfill-slugs', requireUserType(['admin', 'friend']));

// Normalize workplace_type values from scraper to our canonical set
function normalizeWorkplaceType(wt: string): string {
	if (wt === 'on_site') return 'onsite';
	return wt;
}

const ingestRoute = createRoute({
	method: 'post',
	path: '/ingest',
	tags: ['Ingest'],
	summary: 'Receive job batch from hadoku-scrape',
	description:
		'Called by hadoku-scrape after each batch. Requires admin, friend, or service auth via X-User-Key.',
	request: {
		body: {
			content: { 'application/json': { schema: IngestPayloadSchema } },
		},
	},
	responses: {
		200: {
			description: 'Batch accepted',
			content: { 'application/json': { schema: IngestResponseSchema } },
		},
	},
});

app.openapi(ingestRoute, async (c) => {
	const { jobs, batch_number, is_final } = c.req.valid('json');
	const db = c.env.JOB_PLATFORM_DB;
	const now = new Date().toISOString();

	// Fetch all profiles once for scoring
	const profileRows = await db.prepare('SELECT * FROM profiles').all<Record<string, unknown>>();
	const profiles = profileRows.results.map((r) => ({
		id: r.id as string,
		keywords: JSON.parse(r.keywords as string) as string[],
		role_types: JSON.parse(r.role_types as string) as string[],
		remote_pref: r.remote_pref as string,
		min_salary: r.min_salary as number | null,
	}));

	let accepted = 0;
	let skipped = 0;

	for (const job of jobs) {
		// Same-source dedup via URL
		const existing = await db
			.prepare('SELECT id FROM jobs WHERE url = ?')
			.bind(job.url)
			.first<{ id: string }>();

		if (existing) {
			skipped++;
			continue;
		}

		const workplaceType = normalizeWorkplaceType(job.workplace_type);
		const salaryMin = job.salary?.min ?? null;
		const salaryMax = job.salary?.max ?? null;
		const { ats, slug } = parseAtsSlug(job.url);

		await db
			.prepare(
				`INSERT INTO jobs (
					id, url, source_site, title, company, location,
					job_type, workplace_type, salary_min, salary_max,
					description, posted_date, application_url, department,
					scraper_used, raw, scraped_at, ats, slug
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.bind(
				job.id,
				job.url,
				job.source_site,
				job.title,
				job.company,
				job.location,
				job.job_type,
				workplaceType,
				salaryMin,
				salaryMax,
				job.description,
				job.posted_date ?? null,
				job.application_url ?? null,
				job.department ?? null,
				job.scraper_used ?? null,
				JSON.stringify(job.raw),
				now,
				ats,
				slug
			)
			.run();

		// Score against every profile
		for (const profile of profiles) {
			const { score, breakdown } = scoreJob(
				{
					title: job.title,
					description: job.description,
					workplace_type: workplaceType,
					salary_min: salaryMin,
				},
				profile
			);

			await db
				.prepare(
					`INSERT OR REPLACE INTO job_profile_matches (job_id, profile_id, score, score_breakdown, matched_at)
					 VALUES (?, ?, ?, ?, ?)`
				)
				.bind(job.id, profile.id, score, JSON.stringify(breakdown), now)
				.run();
		}

		accepted++;
	}

	return c.json(
		{
			success: true as const,
			data: { accepted, skipped, batch_number, is_final },
		},
		200
	);
});

// Rescore all jobs against all profiles (e.g. after adding a new profile)
const rescoreRoute = createRoute({
	method: 'post',
	path: '/ingest/rescore',
	tags: ['Ingest'],
	summary: 'Rescore all jobs against all profiles',
	request: {
		body: {
			content: {
				'application/json': {
					schema: z.object({ profile_id: z.string().optional() }).openapi('RescoreRequest'),
				},
			},
		},
	},
	responses: {
		200: {
			description: 'Rescore complete',
			content: {
				'application/json': {
					schema: z
						.object({ success: z.literal(true), data: z.object({ scored: z.number() }) })
						.openapi('RescoreResponse'),
				},
			},
		},
	},
});

app.openapi(rescoreRoute, async (c) => {
	const db = c.env.JOB_PLATFORM_DB;
	const { profile_id } = c.req.valid('json');

	const profileRows = profile_id
		? await db
				.prepare('SELECT * FROM profiles WHERE id = ?')
				.bind(profile_id)
				.all<Record<string, unknown>>()
		: await db.prepare('SELECT * FROM profiles').all<Record<string, unknown>>();

	let scored = 0;
	for (const r of profileRows.results) {
		scored += await scoreProfileAgainstAllJobs(db, {
			id: r.id as string,
			keywords: JSON.parse(r.keywords as string) as string[],
			role_types: JSON.parse(r.role_types as string) as string[],
			remote_pref: r.remote_pref as string,
			min_salary: r.min_salary as number | null,
		});
	}

	return c.json({ success: true as const, data: { scored } });
});

// ============================================================================
// POST /ingest/backfill-slugs — one-off: parse (ats, slug) from job.url for
// existing rows where either field is NULL. Idempotent. Safe to re-run.
// ============================================================================

const backfillRoute = createRoute({
	method: 'post',
	path: '/ingest/backfill-slugs',
	tags: ['Ingest'],
	summary: 'Populate jobs.ats / jobs.slug from job.url for rows where either is NULL',
	description:
		'Bounded by `limit` (default 500) per call so a single invocation stays under ' +
		'the edge-router timeout even as the jobs table grows. Loop until `has_more` is false.',
	request: {
		query: z.object({
			limit: z.coerce
				.number()
				.int()
				.min(1)
				.max(2000)
				.default(500)
				.openapi({ description: 'Max rows to scan in this call' }),
		}),
	},
	responses: {
		200: {
			description: 'Backfill batch complete',
			content: {
				'application/json': {
					schema: z
						.object({
							success: z.literal(true),
							data: z.object({
								scanned: z.number(),
								updated: z.number(),
								unmatched: z.number(),
								remaining: z.number(),
								has_more: z.boolean(),
							}),
						})
						.openapi('BackfillSlugsResponse'),
				},
			},
		},
	},
});

app.openapi(backfillRoute, async (c) => {
	const { limit } = c.req.valid('query');
	const db = c.env.JOB_PLATFORM_DB;

	const rows = await db
		.prepare('SELECT id, url FROM jobs WHERE ats IS NULL OR slug IS NULL LIMIT ?')
		.bind(limit)
		.all<{ id: string; url: string }>();

	let updated = 0;
	let unmatched = 0;
	for (const row of rows.results) {
		const { ats, slug } = parseAtsSlug(row.url);
		if (ats === null && slug === null) {
			unmatched++;
			continue;
		}
		await db
			.prepare('UPDATE jobs SET ats = ?, slug = ? WHERE id = ?')
			.bind(ats, slug, row.id)
			.run();
		updated++;
	}

	// After the batch, count how many still need work. The unmatched rows from
	// this batch are still NULL in the DB (we didn't update them), so they're
	// included in `remaining`. Caller should stop looping when `remaining ===
	// unmatched` (nothing matchable left) rather than when `has_more` flips.
	const remainingRow = await db
		.prepare('SELECT COUNT(*) as n FROM jobs WHERE ats IS NULL OR slug IS NULL')
		.first<{ n: number }>();
	const remaining = remainingRow?.n ?? 0;

	return c.json({
		success: true as const,
		data: {
			scanned: rows.results.length,
			updated,
			unmatched,
			remaining,
			has_more: remaining > unmatched,
		},
	});
});

export const ingestRoutes = app;
