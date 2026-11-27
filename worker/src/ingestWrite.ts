/**
 * Writing postings into the corpus — the one path both POST /ingest (the
 * scraper's nightly batches) and POST /jobs/import (one posting a person
 * pasted) go through, so an imported posting is classified, salaried, placed
 * and ranked exactly as a scraped one is.
 */
import type { z } from '@hono/zod-openapi';
import type { AppEnv } from './types.js';
import type { IngestJobSchema } from './schemas.js';
import { parseAtsSlug } from './slugParse.js';
import { classifyRole } from './roleClassify.js';
import { geoKeys } from './geo.js';
import { parseSalaryRange } from './salaryParse.js';
import { loadScorableProfile } from './profileScore.js';
import { criteriaHash, jobsHead, markRankBuilt, writeRanks, type RankableJob } from './rank.js';

type DB = AppEnv['JOB_PLATFORM_DB'];

/**
 * The `source_site` of a posting a person typed in by hand (POST /jobs/import's
 * `manual`). Nothing verified it, so the feed shows it only to people tracking it.
 */
export const MANUAL_SOURCE = 'manual';

/**
 * What jobs.url (NOT NULL UNIQUE) holds for a posting typed in by hand with no
 * link: an internal key, never a URL. publicUrl() turns it into null in every
 * response, so no UI renders it as a link.
 */
export const NO_URL_PREFIX = 'hadoku:manual/';

/** jobs.url as an API returns it: null for a hand-typed posting with no link. */
export function publicUrl(url: string): string | null {
	return url.startsWith(NO_URL_PREFIX) ? null : url;
}
export type IngestJob = z.infer<typeof IngestJobSchema>;

/** Normalize workplace_type values from scraper to our canonical set. */
function normalizeWorkplaceType(wt: string): string {
	if (wt === 'on_site') return 'onsite';
	return wt;
}

/**
 * The INSERT OR IGNORE for one posting. Ignored when its url (UNIQUE) or id
 * is already stored — an already-known posting keeps the fields it has.
 *
 * `source` is the batch label; `board_slug` the board the scraper actually
 * fetched, when it says so.
 */
export function insertJobStatement(
	db: DB,
	job: IngestJob,
	{ source, board_slug, now }: { source: string; board_slug?: string; now: string }
) {
	const workplaceType = normalizeWorkplaceType(job.workplace_type);
	// Structured salary wins; otherwise mine the description prose —
	// pay-transparency ranges usually live there, not in the ATS fields.
	const structuredMin = job.salary?.min ?? null;
	const structuredMax = job.salary?.max ?? null;
	const prose =
		structuredMin === null && structuredMax === null ? parseSalaryRange(job.description) : null;
	const salaryMin = structuredMin ?? prose?.min ?? null;
	const salaryMax = structuredMax ?? prose?.max ?? null;
	// The scraper's own board slug beats anything parsed out of the URL: it
	// is what it actually fetched, where the parse is a hostname guess.
	const parsed = parseAtsSlug(job.url);
	const ats = parsed.ats ?? (board_slug ? source : null);
	const slug = board_slug ?? parsed.slug;
	// Record which of the two wrote it. Without this a hostname guess is
	// indistinguishable from a slug the scraper actually fetched, and the
	// only way to find out is for something downstream to build a URL from
	// it and get a 404.
	const slugSource = slug === null ? null : board_slug ? 'scraped' : 'guessed';
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
				role_track, role_level, slug_source, geo_keys
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
			role.level,
			slugSource,
			geoKeys(job.location)
		);
}

/**
 * Extend every current ranking to cover the jobs inserted since it was built.
 *
 * Selected by rowid past each profile's marker rather than from the payload:
 * ingest only ever INSERTs (an already-known posting is ignored, its fields
 * untouched), so a job that was ranked once keeps the same bound and needs no
 * new write. Re-ranking the whole payload whenever any of it was new used to
 * upsert ~25 rows per profile per batch for one new job — 35% of the
 * database's daily writes. The rowid range also picks up jobs a previous,
 * failed extension missed, which a payload-only pass never would.
 *
 * A profile whose criteria changed since its ranking was built is left alone:
 * extending it under the new criteria and moving its marker would bless the
 * old rows as current. The feed sees the stale hash and rebuilds it.
 */
export async function rankNewJobs(db: AppEnv['JOB_PLATFORM_DB']): Promise<void> {
	const ranked = await db
		.prepare('SELECT profile_id, criteria_hash, max_job_rowid FROM job_profile_rank_state')
		.all<{ profile_id: string; criteria_hash: string; max_job_rowid: number }>();
	if (ranked.results.length === 0) return;

	// Read once, before any row is selected, so a job a concurrent ingest
	// inserts after this point lies past the marker and is ranked next time.
	const head = await jobsHead(db);

	for (const state of ranked.results) {
		const from = Number(state.max_job_rowid);
		if (from >= head) continue;
		const profile = await loadScorableProfile(db, state.profile_id);
		if (criteriaHash(profile) !== state.criteria_hash) continue;
		const rows = await db
			.prepare(
				`SELECT id, title, location, workplace_type, salary_max, role_level
				 FROM jobs WHERE rowid > ? AND rowid <= ?`
			)
			.bind(from, head)
			.all<RankableJob>();
		await writeRanks(db, state.profile_id, profile, rows.results);
		await markRankBuilt(db, state.profile_id, profile, head);
	}
}

/** Optional Server-Timing hooks, so POST /ingest keeps naming its steps. */
export interface WriteTimer {
	start(step: 'insert' | 'seen' | 'rank'): void;
	end(step: 'insert' | 'seen' | 'rank'): void;
}

// One db.batch round trip can carry only so many statements comfortably;
// chunking keeps each D1 call bounded no matter how large a batch is.
const WRITE_BATCH_CHUNK = 100;

/**
 * Write one batch of postings: insert the new ones, mark the known ones as
 * still listed, give a stripped description back, and extend the rankings.
 *
 * This is POST /ingest's write, moved here unchanged so the keyword and board
 * sources the worker pulls itself (sources/run.ts) store postings exactly the
 * way a scraper batch does. Returns, per posting, whether it landed as a new row.
 */
export async function writeJobBatch(
	db: DB,
	jobs: IngestJob[],
	{ source, board_slug, now }: { source: string; board_slug?: string; now: string },
	timer?: WriteTimer
): Promise<boolean[]> {
	// Same-source dedup rides the UNIQUE index on jobs.url: INSERT OR IGNORE
	// makes the whole write one batched round trip per chunk instead of a
	// SELECT + INSERT per job. The old per-job loop cost 2 D1 subrequests per
	// posting — a large batch could blow the 1,000-subrequest invocation cap,
	// and a full corpus refresh burned ~2 round trips per job for nothing.
	const stmts = jobs.map((job) => insertJobStatement(db, job, { source, board_slug, now }));

	// inserted[i] — did jobs[i] land as a new row (true) or hit an existing URL
	// or id and get ignored (false)? Each statement reports its own changes.
	const inserted: boolean[] = [];
	timer?.start('insert');
	for (let i = 0; i < stmts.length; i += WRITE_BATCH_CHUNK) {
		const results = await db.batch(stmts.slice(i, i + WRITE_BATCH_CHUNK));
		for (const r of results) inserted.push((r.meta?.changes ?? 0) > 0);
	}
	timer?.end('insert');

	// Liveness: every URL in this payload was just seen on its source — bump
	// last_seen_at for the skipped (already-known) rows too. A board posting
	// whose last_seen_at stops advancing has been taken down. Rows inserted
	// just now already carry `now`, so only the ones the insert ignored need it.
	//
	// This is the database's largest write by volume (every listed posting,
	// every scrape), so it touches nothing it does not have to: last_seen_at is
	// in no index since 0025, which makes each bump one written row. Folding the
	// slug correction into the same UPDATE, as this used to, also rewrote the
	// (ats, slug) index entry of every row on every scrape — 3 rows per posting
	// to change, on all but a handful, nothing.
	const seen = jobs.filter((_, i) => !inserted[i]);

	// What is stored for the postings the insert skipped. Matched on url OR id:
	// a board can move a posting's URL while its id stays (Ashby recasing
	// jobs.ashbyhq.com/adaptive/… to /Adaptive/…, a board moving to its own
	// careers domain). The insert is then ignored on the id, and a bump keyed
	// on url alone matched nothing, so a listed posting looked delisted for
	// good: its description was stripped and the cull would have deleted it.
	// 388 live postings were stuck that way on 2026-11-09.
	//
	// 45 per chunk keeps url + id binds at 90, under D1's 100.
	const SEEN_CHUNK = 45;
	const storedReads = [];
	for (let i = 0; i < seen.length; i += SEEN_CHUNK) {
		const chunk = seen.slice(i, i + SEEN_CHUNK);
		const inList = chunk.map(() => '?').join(',');
		storedReads.push(
			db
				.prepare(
					`SELECT id, url, description = '' AS blank FROM jobs
					 WHERE url IN (${inList}) OR id IN (${inList})`
				)
				.bind(...chunk.map((j) => j.url), ...chunk.map((j) => j.id))
		);
	}
	timer?.start('seen');
	const stored = storedReads.length
		? (await db.batch<{ id: string; url: string; blank: number }>(storedReads)).flatMap(
				(r) => r.results
			)
		: [];
	const byUrl = new Map(stored.map((r) => [r.url, r]));
	const byId = new Map(stored.map((r) => [r.id, r]));

	const writes = [];
	const sameUrl = seen.filter((j) => byUrl.has(j.url)).map((j) => j.url);
	for (let i = 0; i < sameUrl.length; i += 90) {
		const chunk = sameUrl.slice(i, i + 90);
		const inList = chunk.map(() => '?').join(',');
		writes.push(
			db.prepare(`UPDATE jobs SET last_seen_at = ? WHERE url IN (${inList})`).bind(now, ...chunk)
		);
		if (board_slug) {
			// Correct the slug on rows written before the scraper sent an
			// authoritative one, so postings carrying a hostname guess heal on
			// their next scrape instead of needing a backfill. Only ever narrows
			// to the truth: this runs solely when the scraper told us which board
			// it fetched — and only on the rows where that differs.
			writes.push(
				db
					.prepare(
						`UPDATE jobs SET slug = ?, slug_source = 'scraped'
						 WHERE url IN (${inList})
						   AND (slug IS NOT ? OR slug_source IS NOT 'scraped')`
					)
					.bind(board_slug, ...chunk, board_slug)
			);
		}
	}
	// The drifted: known by id under an older URL. Bump them by id, and adopt
	// the board's current URL so the next scrape matches the cheap way. OR
	// IGNORE because another row could already hold that URL; the bump stands
	// either way.
	for (const j of seen) {
		const row = byId.get(j.id);
		if (!row || row.url === j.url) continue;
		writes.push(db.prepare('UPDATE jobs SET last_seen_at = ? WHERE id = ?').bind(now, row.id));
		writes.push(db.prepare('UPDATE OR IGNORE jobs SET url = ? WHERE id = ?').bind(j.url, row.id));
	}
	// A posting back on its board after its description was stripped gets it
	// back. Found by the read above, so the rows that never lost theirs —
	// nearly all of them — cost no extra write.
	for (const j of seen) {
		const row = byUrl.get(j.url) ?? byId.get(j.id);
		if (row?.blank && j.description !== '') {
			writes.push(
				db
					.prepare(`UPDATE jobs SET description = ? WHERE id = ? AND description = ''`)
					.bind(j.description, row.id)
			);
		}
	}
	for (let i = 0; i < writes.length; i += WRITE_BATCH_CHUNK) {
		await db.batch(writes.slice(i, i + WRITE_BATCH_CHUNK));
	}
	timer?.end('seen');

	// Keep every profile's precomputed ranking covering the newest postings.
	//
	// A job with no rank row is invisible to the feed's fast path, and new jobs
	// are exactly the ones worth seeing — so this runs before the marker moves.
	// markRankBuilt is what tells the feed the ranking is current; if this
	// throws, the marker stays behind and the feed falls back to ranking live
	// rather than quietly omitting the postings that just landed.
	if (inserted.some(Boolean)) {
		timer?.start('rank');
		await rankNewJobs(db);
		timer?.end('rank');
	}
	return inserted;
}
