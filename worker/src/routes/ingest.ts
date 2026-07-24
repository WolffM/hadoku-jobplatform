import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { AppEnv } from '../types.js';
import { requireUserType, type HadokuAuthContext } from '@wolffm/worker-utils';
import { IngestPayloadSchema, IngestResponseSchema } from '../schemas.js';
import { parseAtsSlug } from '../slugParse.js';

interface RouteContext {
	Bindings: AppEnv;
	Variables: { authContext: HadokuAuthContext };
}

const app = new OpenAPIHono<RouteContext>();

// /ingest is the scraper webhook target — hadoku-scrape's jobboards orchestrator
// POSTs batches with its HADOKU_SERVICE_KEY (service tier). Same shape as the
// monitoring-api/contact-api service-tier carve-outs for internal writes.
// /backfill-slugs stays admin/friend — an operator tool, not a webhook.
app.use('/ingest', requireUserType(['admin', 'friend', 'service']));
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
