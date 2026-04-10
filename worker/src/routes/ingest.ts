import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { AppEnv } from '../types.js';
import { requireUserType, type HadokuAuthContext } from '@wolffm/worker-utils';
import { IngestPayloadSchema, IngestResponseSchema } from '../schemas.js';
import { scoreJob } from '../scoring.js';

interface RouteContext {
	Bindings: AppEnv;
	Variables: { authContext: HadokuAuthContext };
}

const app = new OpenAPIHono<RouteContext>();

app.use('/ingest', requireUserType(['admin', 'friend']));
app.use('/ingest/rescore', requireUserType(['admin', 'friend']));

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
		'Called by hadoku-scrape after each batch. Requires admin or friend auth via X-User-Key.',
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
		target_companies: JSON.parse(r.target_companies as string) as string[],
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

		await db
			.prepare(
				`INSERT INTO jobs (
					id, url, source_site, title, company, location,
					job_type, workplace_type, salary_min, salary_max,
					description, posted_date, application_url, department,
					scraper_used, raw, scraped_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
				now
			)
			.run();

		// Score against every profile
		for (const profile of profiles) {
			const { score, breakdown } = scoreJob(
				{
					title: job.title,
					description: job.description,
					company: job.company,
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
	const now = new Date().toISOString();

	const jobRows = await db
		.prepare('SELECT id, title, description, company, workplace_type, salary_min FROM jobs')
		.all<{
			id: string;
			title: string;
			description: string;
			company: string;
			workplace_type: string;
			salary_min: number | null;
		}>();

	const profileQuery = profile_id
		? 'SELECT * FROM profiles WHERE id = ?'
		: 'SELECT * FROM profiles';
	const profileRows = profile_id
		? await db.prepare(profileQuery).bind(profile_id).all<Record<string, unknown>>()
		: await db.prepare(profileQuery).all<Record<string, unknown>>();

	let scored = 0;
	for (const job of jobRows.results) {
		for (const r of profileRows.results) {
			const profile = {
				id: r.id as string,
				keywords: JSON.parse(r.keywords as string) as string[],
				target_companies: JSON.parse(r.target_companies as string) as string[],
				role_types: JSON.parse(r.role_types as string) as string[],
				remote_pref: r.remote_pref as string,
				min_salary: r.min_salary as number | null,
			};

			const { score, breakdown } = scoreJob(job, profile);
			await db
				.prepare(
					`INSERT OR REPLACE INTO job_profile_matches (job_id, profile_id, score, score_breakdown, matched_at)
					 VALUES (?, ?, ?, ?, ?)`
				)
				.bind(job.id, profile.id, score, JSON.stringify(breakdown), now)
				.run();
			scored++;
		}
	}

	return c.json({ success: true as const, data: { scored } });
});

export const ingestRoutes = app;
