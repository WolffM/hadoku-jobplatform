import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { AppEnv } from '../types.js';
import { requireMinTier, type HadokuAuthContext } from '@wolffm/worker-utils';
import { IngestPayloadSchema, IngestResponseSchema } from '../schemas.js';
import { parseAtsSlug } from '../slugParse.js';
import { classifyRole } from '../roleClassify.js';
import { parseSalaryRange } from '../salaryParse.js';

interface RouteContext {
	Bindings: AppEnv;
	Variables: { authContext: HadokuAuthContext };
}

const app = new OpenAPIHono<RouteContext>();

// All three gate at friend and up. Tiers rank (public < friend < service <
// admin), so naming the LOWEST legitimate caller admits every tier above it:
// /ingest is the scraper webhook target (hadoku-scrape POSTs batches with its
// HADOKU_SERVICE_KEY — service tier, which outranks friend); /backfill-slugs is
// an operator tool; /directives is pulled by the scraper each run and read by
// operators for debugging. None of them needs to enumerate tiers.

// ── 2-month cull (owner directive 2026-08-19) ────────────────────────────────
// A listing older than CULL_DAYS by its freshest signal — posted date, first
// scrape, or last time a scrape still saw it — is dead weight. Rows the owner
// touched are IMMUNE: job_states (triage, packets) and job_feedback (votes) are
// records and training data, never garbage. Board postings still listed keep
// last_seen_at advancing, so they never age into the cull while alive.
const CULL_DAYS = 60;
const CULL_BATCH = 500;

async function cullExpired(db: AppEnv['JOB_PLATFORM_DB']): Promise<number> {
	const cutoff = new Date(Date.now() - CULL_DAYS * 86_400_000).toISOString();
	const res = await db
		.prepare(
			`DELETE FROM jobs WHERE id IN (
				SELECT j.id FROM jobs j
				WHERE MAX(COALESCE(j.posted_date, ''), COALESCE(j.last_seen_at, ''), j.scraped_at) < ?
				  AND NOT EXISTS (SELECT 1 FROM job_states s WHERE s.job_id = j.id)
				  AND NOT EXISTS (SELECT 1 FROM job_feedback f WHERE f.job_id = j.id)
				LIMIT ${CULL_BATCH}
			)`
		)
		.bind(cutoff)
		.run();
	return res.meta?.changes ?? 0;
}

app.use('/ingest', requireMinTier('friend'));
app.use('/ingest/backfill-slugs', requireMinTier('friend'));
app.use('/ingest/backfill-roles', requireMinTier('friend'));
app.use('/ingest/backfill-salary', requireMinTier('friend'));
app.use('/ingest/cull', requireMinTier('friend'));
app.use('/directives', requireMinTier('friend'));

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

// One db.batch round trip can carry only so many statements comfortably;
// chunking keeps each D1 call bounded no matter how large a webhook batch the
// scraper sends.
const INGEST_BATCH_CHUNK = 100;

app.openapi(ingestRoute, async (c) => {
	const { jobs, batch_number, is_final } = c.req.valid('json');
	const db = c.env.JOB_PLATFORM_DB;
	const now = new Date().toISOString();

	// Same-source dedup rides the UNIQUE index on jobs.url: INSERT OR IGNORE
	// makes the whole write one batched round trip per chunk instead of a
	// SELECT + INSERT per job. The old per-job loop cost 2 D1 subrequests per
	// posting — a large batch could blow the 1,000-subrequest invocation cap,
	// and a full corpus refresh burned ~2 round trips per job for nothing.
	const stmts = jobs.map((job) => {
		const workplaceType = normalizeWorkplaceType(job.workplace_type);
		// Structured salary wins; otherwise mine the description prose —
		// pay-transparency ranges usually live there, not in the ATS fields.
		const structuredMin = job.salary?.min ?? null;
		const structuredMax = job.salary?.max ?? null;
		const prose =
			structuredMin === null && structuredMax === null ? parseSalaryRange(job.description) : null;
		const salaryMin = structuredMin ?? prose?.min ?? null;
		const salaryMax = structuredMax ?? prose?.max ?? null;
		const { ats, slug } = parseAtsSlug(job.url);
		// No ATS publishes a track or a level, so we infer both here — once, at
		// write time — rather than re-deriving them from the title on every read.
		const role = classifyRole(job.title, job.description);

		return db
			.prepare(
				`INSERT OR IGNORE INTO jobs (
					id, url, source_site, title, company, location,
					job_type, workplace_type, salary_min, salary_max,
					description, posted_date, application_url, department,
					scraper_used, raw, scraped_at, last_seen_at, ats, slug,
					role_track, role_level
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
				now,
				ats,
				slug,
				role.track,
				role.level
			);
	});

	let accepted = 0;
	for (let i = 0; i < stmts.length; i += INGEST_BATCH_CHUNK) {
		const results = await db.batch(stmts.slice(i, i + INGEST_BATCH_CHUNK));
		for (const r of results) accepted += r.meta?.changes ?? 0;
	}
	const skipped = jobs.length - accepted;

	// Liveness: every URL in this payload was just seen on its source — bump
	// last_seen_at for the skipped (already-known) rows too. A board posting
	// whose last_seen_at stops advancing has been taken down.
	const urls = jobs.map((j) => j.url);
	const seenStmts = [];
	for (let i = 0; i < urls.length; i += 90) {
		const chunk = urls.slice(i, i + 90);
		seenStmts.push(
			db
				.prepare(
					`UPDATE jobs SET last_seen_at = ? WHERE url IN (${chunk.map(() => '?').join(',')})`
				)
				.bind(now, ...chunk)
		);
	}
	if (seenStmts.length) await db.batch(seenStmts);

	// End of a scrape run: sweep one bounded batch of expired listings. Repeated
	// runs converge; the manual /ingest/cull endpoint exists for full sweeps.
	let culled = 0;
	if (is_final) {
		culled = await cullExpired(db);
	}

	return c.json(
		{
			success: true as const,
			data: { accepted, skipped, batch_number, is_final, culled },
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

// ============================================================================
// POST /ingest/backfill-roles — classify (role_track, role_level) for rows
// ingested before migration 0009. Idempotent, but only touches rows still at
// the 'unknown' default, so re-running is cheap and re-classifying after a
// classifier change needs an explicit `reclassify=true`.
// ============================================================================

const backfillRolesRoute = createRoute({
	method: 'post',
	path: '/ingest/backfill-roles',
	tags: ['Ingest'],
	summary: 'Populate jobs.role_track / jobs.role_level from title + description',
	description:
		'Bounded by `limit` (default 500) per call so a single invocation stays under ' +
		'the edge-router timeout. Loop until `has_more` is false. Pass `reclassify=true` ' +
		'to re-run over every row after a classifier change, not just unclassified ones.',
	request: {
		query: z.object({
			limit: z.coerce
				.number()
				.int()
				.min(1)
				.max(2000)
				.default(500)
				.openapi({ description: 'Max rows to scan in this call' }),
			reclassify: z.enum(['true', 'false']).default('false').openapi({
				description: 'Re-classify every row, not just those still at role_track = unknown',
			}),
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
								unclassifiable: z.number(),
								remaining: z.number(),
								has_more: z.boolean(),
							}),
						})
						.openapi('BackfillRolesResponse'),
				},
			},
		},
	},
});

app.openapi(backfillRolesRoute, async (c) => {
	const { limit, reclassify } = c.req.valid('query');
	const db = c.env.JOB_PLATFORM_DB;
	const all = reclassify === 'true';

	// When reclassifying we walk the whole table; the "remaining" count below is
	// then meaningless as a stop condition, so the caller pages by scanned count
	// instead. Ordering by id keeps the walk stable across calls.
	const rows = await db
		.prepare(
			all
				? 'SELECT id, title, description FROM jobs ORDER BY id LIMIT ?'
				: "SELECT id, title, description FROM jobs WHERE role_track = 'unknown' LIMIT ?"
		)
		.bind(limit)
		.all<{ id: string; title: string; description: string }>();

	let updated = 0;
	let unclassifiable = 0;
	const stmts = rows.results.map((row) => {
		const role = classifyRole(row.title, row.description);
		if (role.track === 'unknown') unclassifiable++;
		else updated++;
		return db
			.prepare('UPDATE jobs SET role_track = ?, role_level = ? WHERE id = ?')
			.bind(role.track, role.level, row.id);
	});
	if (stmts.length) await db.batch(stmts);

	const remainingRow = await db
		.prepare("SELECT COUNT(*) as n FROM jobs WHERE role_track = 'unknown'")
		.first<{ n: number }>();
	const remaining = remainingRow?.n ?? 0;

	// A blank-titled row classifies straight back to 'unknown' and stays in the
	// WHERE clause, so "remaining > 0" alone would loop forever. Those rows are
	// counted as `unclassifiable` and excluded from the stop condition — same
	// contract as /ingest/backfill-slugs' `unmatched`.
	return c.json({
		success: true as const,
		data: {
			scanned: rows.results.length,
			updated,
			unclassifiable,
			remaining,
			has_more: all ? rows.results.length === limit : remaining > unclassifiable,
		},
	});
});

// ============================================================================
// GET /directives — the union of every profile's scrape directives.
//
// The single source of truth for what the scraper should fetch. hadoku-scrape
// pulls this at the start of each run: it scrapes every company board and runs
// every keyword against its keyword-search providers (Remotive/RemoteOK/Muse).
// Companies and keywords are unified here — both are just "things a profile
// asked to be scraped" — so the scraper learns them the same way (pull), rather
// than companies being pushed target-by-target.
// ============================================================================

const directivesRoute = createRoute({
	method: 'get',
	path: '/directives',
	tags: ['Ingest'],
	summary: 'Scrape directives — union of all profiles’ companies + keywords',
	description:
		'Pulled by hadoku-scrape each run. `companies` = distinct (ats, slug) across ' +
		'every profile_companies row; `keywords` = the deduped (case-insensitive) union ' +
		'of every profile’s keywords. The scraper scrapes each company board and runs ' +
		'each keyword against its keyword-search providers.',
	responses: {
		200: {
			description: 'Directive set',
			content: {
				'application/json': {
					schema: z
						.object({
							success: z.literal(true),
							data: z.object({
								companies: z.array(z.object({ ats: z.string(), slug: z.string() })),
								keywords: z.array(z.string()),
							}),
						})
						.openapi('DirectivesResponse'),
				},
			},
		},
	},
});

app.openapi(directivesRoute, async (c) => {
	const db = c.env.JOB_PLATFORM_DB;

	const companyRows = await db
		.prepare('SELECT DISTINCT ats, slug FROM profile_companies ORDER BY ats, slug')
		.all<{ ats: string; slug: string }>();

	const profileRows = await db.prepare('SELECT keywords FROM profiles').all<{ keywords: string }>();

	// Union keywords across all profiles, case-insensitively deduped but keeping
	// the first-seen casing (what the scraper searches with).
	const seen = new Set<string>();
	const keywords: string[] = [];
	for (const r of profileRows.results) {
		let arr: string[] = [];
		try {
			arr = JSON.parse(r.keywords) as string[];
		} catch {
			arr = [];
		}
		for (const raw of arr) {
			const kw = typeof raw === 'string' ? raw.trim() : '';
			if (!kw) continue;
			const key = kw.toLowerCase();
			if (seen.has(key)) continue;
			seen.add(key);
			keywords.push(kw);
		}
	}

	return c.json(
		{
			success: true as const,
			data: { companies: companyRows.results, keywords },
		},
		200
	);
});

// ── POST /ingest/backfill-salary — mine prose salary ranges for NULL rows ────
// Cursor-paged by id: unparseable rows stay NULL forever, so a WHERE-count stop
// condition would loop. Loop while has_more, passing back `cursor`.
const backfillSalaryRoute = createRoute({
	method: 'post',
	path: '/ingest/backfill-salary',
	tags: ['Ingest'],
	summary: 'Populate jobs.salary_min/max from description prose where NULL',
	request: {
		query: z.object({
			limit: z.coerce.number().int().min(1).max(2000).default(500),
			cursor: z.string().default('').openapi({ description: 'Last id from the previous call' }),
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
								cursor: z.string(),
								has_more: z.boolean(),
							}),
						})
						.openapi('BackfillSalaryResponse'),
				},
			},
		},
	},
});

app.openapi(backfillSalaryRoute, async (c) => {
	const { limit, cursor } = c.req.valid('query');
	const db = c.env.JOB_PLATFORM_DB;

	const rows = await db
		.prepare(
			'SELECT id, description FROM jobs WHERE salary_max IS NULL AND id > ? ORDER BY id LIMIT ?'
		)
		.bind(cursor, limit)
		.all<{ id: string; description: string }>();

	let updated = 0;
	const stmts = [];
	for (const row of rows.results) {
		const parsed = parseSalaryRange(row.description);
		if (!parsed) continue;
		updated++;
		stmts.push(
			db
				.prepare('UPDATE jobs SET salary_min = ?, salary_max = ? WHERE id = ?')
				.bind(parsed.min, parsed.max, row.id)
		);
	}
	if (stmts.length) await db.batch(stmts);

	const last = rows.results.at(-1)?.id ?? cursor;
	return c.json({
		success: true as const,
		data: {
			scanned: rows.results.length,
			updated,
			cursor: last,
			has_more: rows.results.length === limit,
		},
	});
});

// ── POST /ingest/cull — manual full sweep of expired listings ────────────────
const cullRoute = createRoute({
	method: 'post',
	path: '/ingest/cull',
	tags: ['Ingest'],
	summary: `Delete listings older than ${CULL_DAYS} days (freshest of posted/first-seen/last-seen), sparing rows with owner activity`,
	responses: {
		200: {
			description: 'Cull batch complete',
			content: {
				'application/json': {
					schema: z
						.object({
							success: z.literal(true),
							data: z.object({ culled: z.number(), has_more: z.boolean() }),
						})
						.openapi('CullResponse'),
				},
			},
		},
	},
});

app.openapi(cullRoute, async (c) => {
	const culled = await cullExpired(c.env.JOB_PLATFORM_DB);
	return c.json({ success: true as const, data: { culled, has_more: culled === CULL_BATCH } }, 200);
});

export const ingestRoutes = app;
