/**
 * POST /jobs/import — put a posting someone found elsewhere into the corpus
 * and their pipeline, from its URL.
 *
 * The scraper reads the posting (POST /api/v1/jobboards/extract): a Greenhouse,
 * Lever or Ashby URL through the board's API and the nightly search's own
 * parser, anything else from the page's JSON-LD. It comes back in the ingest
 * webhook's shape and is written by the SAME statement /ingest uses
 * (ingestWrite.ts), so it is classified, salaried, placed and ranked like any
 * scraped posting — and since the board path yields the nightly id and
 * canonical URL, importing a posting the corpus already holds lands on that
 * row rather than beside it.
 *
 * Then it joins the caller's pipeline, as `state` (default saved), with the
 * timeline row PUT /state would have written. A posting the caller already
 * tracks keeps its state: importing an application you have sent must never
 * move it back to saved.
 *
 * `manual` is the fallback for a page nothing can be read from (no JSON-LD, a
 * login wall, a posting its board has already taken down): the person types
 * the title and company themselves and nothing is scraped. What they typed is
 * unverified, so it is stored as `source_site = 'manual'` and the feed shows it
 * to no one but a person tracking it (feed.ts) — the corpus is shared, and one
 * person's notes must not become everyone's listing. Its description is their
 * text, escaped, never HTML.
 */
import { createRoute, z } from '@hono/zod-openapi';
import {
	ErrorResponseSchema,
	IdentityErrorResponseSchema,
	IngestJobSchema,
	JobStateSchema,
} from '../../schemas.js';
import { extractPosting, ScraperClientError } from '../../clients/scraper.js';
import { insertJobStatement, MANUAL_SOURCE, rankNewJobs } from '../../ingestWrite.js';
import { isTestBoardPosting } from '../../testBoards.js';
import {
	effectiveUserId,
	gateAuthed,
	isEffectiveUserError,
	ownerNameQuery,
	type JobsApp,
} from './shared.js';
import type { AppEnv } from '../../types.js';

type DB = AppEnv['JOB_PLATFORM_DB'];

const ImportJobSchema = z
	.object({
		url: z.string().trim().url().max(2000),
		/** Where it lands in the pipeline when it is new to the caller. */
		state: JobStateSchema.exclude(['dismissed']).default('saved'),
		/** Typed by the person: store this instead of reading the page. */
		manual: z
			.object({
				title: z.string().trim().min(1).max(300),
				company: z.string().trim().min(1).max(200),
				location: z.string().trim().max(200).default(''),
				description: z.string().trim().max(20000).default(''),
			})
			.optional(),
	})
	.openapi('ImportJob');

const ImportedSchema = z
	.object({
		success: z.literal(true),
		data: z.object({
			job: z.object({
				id: z.string(),
				title: z.string(),
				company: z.string(),
				location: z.string(),
				url: z.string(),
			}),
			/** The posting was new to the corpus (false: it was already there). */
			created: z.boolean(),
			/** The caller's state for it now. */
			state: JobStateSchema,
			/** The caller already tracked it, so its state was left alone. */
			already_tracked: z.boolean(),
		}),
	})
	.openapi('ImportedJob');

function failure(status: number, message: string) {
	return {
		success: false as const,
		error: status === 422 ? 'Unprocessable' : 'Bad gateway',
		message,
	};
}

interface JobRow {
	id: string;
	title: string;
	company: string;
	location: string;
	url: string;
}

const JOB_COLS = 'id, title, company, location, url';

const escapeHtml = (text: string) =>
	text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Typed notes as the drawer's HTML: escaped, a paragraph per blank-line block,
 * <br> for a single newline. Always wrapped in <p>, so the drawer reads it as
 * HTML rather than collapsing an entity-escaped plain string.
 */
export function manualDescriptionHtml(text: string): string {
	if (!text) return '';
	return text
		.split(/\n\s*\n/)
		.map((para) => `<p>${escapeHtml(para.trim()).replace(/\n/g, '<br>')}</p>`)
		.join('');
}

/** Stable per URL, so typing the same posting twice lands on one row. */
async function manualId(url: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url));
	const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
	return `manual_${hex.slice(0, 16)}`;
}

/**
 * The board behind an employer-hosted Greenhouse page (`?gh_jid=`), from the
 * postings the scraper has already delivered for the same host. Such pages
 * rarely name their board — careers.withwaymo.com is "waymo" — and this is the
 * one place that knows. A range over the UNIQUE url index, not a LIKE.
 */
async function greenhouseSlugFor(db: DB, url: string): Promise<string | undefined> {
	const parsed = new URL(url);
	if (!parsed.searchParams.has('gh_jid')) return undefined;
	const prefix = `${parsed.protocol}//${parsed.host}/`;
	const row = await db
		.prepare(
			`SELECT slug FROM jobs
			 WHERE url >= ? AND url < ? AND ats = 'greenhouse' AND slug IS NOT NULL
			   AND slug_source = 'scraped'
			 LIMIT 1`
		)
		// '0' is the character after '/', so this is every url under the host.
		.bind(prefix, `${prefix.slice(0, -1)}0`)
		.first<{ slug: string }>();
	return row?.slug;
}

export function registerImportRoute(app: JobsApp): void {
	app.post('/jobs/import', gateAuthed);

	app.openapi(
		createRoute({
			method: 'post',
			path: '/jobs/import',
			tags: ['Pipeline'],
			summary: 'Import a posting from its URL into the corpus and the caller’s pipeline',
			request: {
				query: ownerNameQuery,
				body: { content: { 'application/json': { schema: ImportJobSchema } } },
			},
			responses: {
				200: {
					description: 'Imported (or found, and added to the pipeline)',
					content: { 'application/json': { schema: ImportedSchema } },
				},
				403: {
					description: 'Forbidden',
					content: { 'application/json': { schema: IdentityErrorResponseSchema } },
				},
				404: {
					description: 'The board no longer lists that posting, or no such owner name',
					content: { 'application/json': { schema: IdentityErrorResponseSchema } },
				},
				409: {
					description: 'That owner name has never signed in',
					content: { 'application/json': { schema: IdentityErrorResponseSchema } },
				},
				422: {
					description: 'No posting could be read from that page (or it is a LinkedIn URL)',
					content: { 'application/json': { schema: ErrorResponseSchema } },
				},
				502: {
					description: 'The site, or the scraper, could not be reached',
					content: { 'application/json': { schema: ErrorResponseSchema } },
				},
				503: {
					description: 'Identity could not be resolved right now — retry',
					content: { 'application/json': { schema: IdentityErrorResponseSchema } },
				},
			},
		}),
		async (c) => {
			const { url, state, manual } = c.req.valid('json');
			const { ownerName } = c.req.valid('query');
			const who = await effectiveUserId(c, ownerName);
			if (isEffectiveUserError(who)) return c.json(who.error.body, who.error.status);
			const db = c.env.JOB_PLATFORM_DB;

			// Already in the corpus under exactly this URL: no scrape needed.
			let row = await db
				.prepare(`SELECT ${JOB_COLS} FROM jobs WHERE url = ?`)
				.bind(url)
				.first<JobRow>();
			let created = false;

			if (!row && manual) {
				const now = new Date().toISOString();
				const id = await manualId(url);
				const [res] = await db.batch([
					insertJobStatement(
						db,
						{
							id,
							url,
							source_site: MANUAL_SOURCE,
							title: manual.title,
							company: manual.company,
							location: manual.location,
							job_type: 'unknown',
							workplace_type: 'unknown',
							salary: null,
							description: manualDescriptionHtml(manual.description),
							posted_date: null,
							application_url: url,
							department: null,
							scraper_used: null,
							raw: {},
						},
						{ source: MANUAL_SOURCE, now }
					),
				]);
				created = (res.meta?.changes ?? 0) > 0;
				row = await db
					.prepare(`SELECT ${JOB_COLS} FROM jobs WHERE id = ?`)
					.bind(id)
					.first<JobRow>();
				if (!row) throw new Error(`import: manual ${id} neither inserted nor found`);
				// A new row past the ranking's head marks every ranking stale, so
				// it is ranked like any other (the feed still keeps it to its owner).
				if (created) await rankNewJobs(db);
			}

			if (!row) {
				let extracted;
				try {
					extracted = await extractPosting(c.env, url, await greenhouseSlugFor(db, url));
				} catch (err) {
					if (!(err instanceof ScraperClientError)) throw err;
					// The scraper's own words are written for the person.
					if (err.status === 404) {
						return c.json(
							{ success: false as const, error: 'Not found', message: err.message },
							404
						);
					}
					if (err.status === 400 || err.status === 422) {
						return c.json(failure(422, err.message), 422);
					}
					return c.json(failure(502, `Could not read that posting: ${err.message}`), 502);
				}
				const job = IngestJobSchema.safeParse(extracted.job);
				if (!job.success) {
					return c.json(
						failure(
							502,
							`The scraper returned a posting this API cannot store: ${job.error.message}`
						),
						502
					);
				}
				if (isTestBoardPosting(job.data.url, { ats: extracted.ats, slug: extracted.board_slug })) {
					return c.json(
						failure(422, "That board holds LinkedIn's ATS test postings, not real jobs."),
						422
					);
				}
				const now = new Date().toISOString();
				const [res] = await db.batch([
					insertJobStatement(db, job.data, {
						source: extracted.ats ?? 'import',
						board_slug: extracted.board_slug ?? undefined,
						now,
					}),
				]);
				created = (res.meta?.changes ?? 0) > 0;
				// Its url or id is already stored (the board's canonical url
				// differs from what was pasted): that row is the posting.
				row = await db
					.prepare(`SELECT ${JOB_COLS} FROM jobs WHERE url = ? OR id = ? LIMIT 1`)
					.bind(job.data.url, job.data.id)
					.first<JobRow>();
				if (!row) throw new Error(`import: ${job.data.id} neither inserted nor found`);
				// Same reason /ingest does it: a job with no rank row is invisible
				// to the feed's fast path.
				if (created) await rankNewJobs(db);
			}

			const prev = await db
				.prepare('SELECT state FROM job_states WHERE job_id = ? AND user_id = ?')
				.bind(row.id, who.userId)
				.first<{ state: string }>();
			if (prev) {
				const kept = JobStateSchema.safeParse(prev.state);
				return c.json(
					{
						success: true as const,
						data: {
							job: row,
							created,
							state: kept.success ? kept.data : state,
							already_tracked: true,
						},
					},
					200
				);
			}

			const now = new Date().toISOString();
			// The event goes first, guarded on there being no state row yet, so a
			// concurrent import cannot log a second "added" for one transition.
			await db.batch([
				db
					.prepare(
						`INSERT INTO job_events (job_id, user_id, kind, from_state, to_state, occurred_at, created_at)
						 SELECT ?, ?, 'state', NULL, ?, ?, ?
						 WHERE NOT EXISTS (SELECT 1 FROM job_states WHERE job_id = ? AND user_id = ?)`
					)
					.bind(row.id, who.userId, state, now, now, row.id, who.userId),
				db
					.prepare(
						`INSERT INTO job_states (job_id, user_id, state, updated_at) VALUES (?, ?, ?, ?)
						 ON CONFLICT (job_id, user_id) DO NOTHING`
					)
					.bind(row.id, who.userId, state, now),
			]);
			return c.json(
				{ success: true as const, data: { job: row, created, state, already_tracked: false } },
				200
			);
		}
	);
}
