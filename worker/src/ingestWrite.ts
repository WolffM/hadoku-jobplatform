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
