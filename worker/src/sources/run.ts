/**
 * Run one task of the plan: list the source, fetch descriptions for the
 * postings the corpus does not hold yet, and write the lot through
 * writeJobBatch, the same write POST /ingest uses.
 *
 * Bounded per call so one invocation stays inside the edge timeout and the
 * Workers subrequest cap: at most DETAIL_CAP detail requests, DETAIL_CONCURRENCY
 * at a time. New postings past the cap are left for the next call of the same
 * task (`again`), which finds the ones written now already known.
 */
import type { AppEnv } from '../types.js';
import { writeJobBatch, type IngestJob } from '../ingestWrite.js';
import * as arbeitsagentur from './arbeitsagentur.js';
import * as personio from './personio.js';
import * as smartrecruiters from './smartrecruiters.js';
import { pooled } from './http.js';
import type { Listing, SourceContext, SourceTask } from './types.js';

type DB = AppEnv['JOB_PLATFORM_DB'];

export const DETAIL_CAP = 40;
const DETAIL_CONCURRENCY = 4;

export interface TaskResult {
	/** Postings the source listed (after dropping duplicates within the listing). */
	listed: number;
	/** New rows written. */
	accepted: number;
	/** Listed postings the corpus already held; their last_seen_at was bumped. */
	already_known: number;
	details_fetched: number;
	/** Detail requests that failed; those postings are retried on the next run. */
	details_failed: number;
	/** New postings left for the next call because of DETAIL_CAP. */
	deferred: number;
	/**
	 * Call the same task again: postings were deferred, and this call made
	 * progress (a call whose every detail failed would only repeat itself).
	 */
	again: boolean;
}

function listTask(task: SourceTask, ctx: SourceContext): Promise<Listing[]> {
	switch (task.source) {
		case 'arbeitsagentur':
			return arbeitsagentur.list(task, ctx);
		case 'personio':
			return personio.list(task, ctx);
		case 'smartrecruiters':
			return smartrecruiters.list(task, ctx);
	}
}

function fetchDetail(
	task: SourceTask,
	job: IngestJob,
	url: string,
	ctx: SourceContext
): Promise<IngestJob> {
	switch (task.source) {
		case 'arbeitsagentur':
			return arbeitsagentur.fetchDetail(job, url, ctx);
		case 'smartrecruiters':
			return smartrecruiters.fetchDetail(job, url, ctx);
		case 'personio':
			// Personio listings carry their descriptions and never ask for this.
			return Promise.resolve(job);
	}
}

/** The batch label and board slug the write records, like a scraper batch's. */
function batchLabels(task: SourceTask): { source: string; board_slug?: string } {
	switch (task.source) {
		case 'arbeitsagentur':
			return { source: 'arbeitsagentur' };
		case 'personio':
			return { source: 'personio', board_slug: task.slug.toLowerCase() };
		case 'smartrecruiters':
			return { source: 'smartrecruiters', board_slug: task.company.toLowerCase() };
	}
}

/** Which of these postings the corpus already holds, by id or url. */
async function knownIds(db: DB, jobs: IngestJob[]): Promise<Set<string>> {
	const known = new Set<string>();
	// 45 per chunk keeps url + id binds at 90, under D1's 100.
	const CHUNK = 45;
	const reads = [];
	for (let i = 0; i < jobs.length; i += CHUNK) {
		const chunk = jobs.slice(i, i + CHUNK);
		const inList = chunk.map(() => '?').join(',');
		reads.push(
			db
				.prepare(`SELECT id, url FROM jobs WHERE id IN (${inList}) OR url IN (${inList})`)
				.bind(...chunk.map((j) => j.id), ...chunk.map((j) => j.url))
		);
	}
	if (reads.length === 0) return known;
	const byUrl = new Map(jobs.map((j) => [j.url, j.id]));
	for (const r of await db.batch<{ id: string; url: string }>(reads)) {
		for (const row of r.results) {
			known.add(row.id);
			const id = byUrl.get(row.url);
			if (id) known.add(id);
		}
	}
	return known;
}

export async function runTask(
	db: DB,
	task: SourceTask,
	ctx: SourceContext,
	now: string = new Date().toISOString()
): Promise<TaskResult> {
	const seenIds = new Set<string>();
	const listings = (await listTask(task, ctx)).filter((l) => {
		if (seenIds.has(l.job.id)) return false;
		seenIds.add(l.job.id);
		return true;
	});

	const known = await knownIds(
		db,
		listings.map((l) => l.job)
	);
	const toWrite: IngestJob[] = [];
	const needDetail: Listing[] = [];
	for (const l of listings) {
		if (known.has(l.job.id) || !l.detailUrl) toWrite.push(l.job);
		else needDetail.push(l);
	}

	const batch = needDetail.slice(0, DETAIL_CAP);
	const deferred = needDetail.length - batch.length;
	const details = await pooled(batch, DETAIL_CONCURRENCY, (l) =>
		fetchDetail(task, l.job, l.detailUrl!, ctx)
	);
	let failed = 0;
	for (const d of details) {
		// A posting whose detail failed is not written without its text: the
		// next run lists it again as new and retries.
		if (d instanceof Error) failed++;
		else toWrite.push(d);
	}

	const inserted = toWrite.length
		? await writeJobBatch(db, toWrite, { ...batchLabels(task), now })
		: [];
	const accepted = inserted.filter(Boolean).length;
	return {
		listed: listings.length,
		accepted,
		already_known: inserted.length - accepted,
		details_fetched: batch.length - failed,
		details_failed: failed,
		deferred,
		again: deferred > 0 && batch.length > failed,
	};
}
