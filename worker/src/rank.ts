/**
 * The feed's shortlist, precomputed.
 *
 * The light pass ranks candidates by `scoreJobLightAxes().bound` — a value
 * derived from the job's title/location/workplace/salary/level and the
 * profile's criteria, with no description involved. Computing it per request
 * meant reading every row in the corpus to sort 25, which is what made the feed
 * slow warm and fatal cold. Computing it on write instead lets the feed
 * ORDER BY / LIMIT in SQL.
 *
 * The bound is the same number either way. This module is only about WHERE it
 * is computed, and about being able to tell when the stored copy is no longer
 * trustworthy.
 */
import type { D1Database } from '@cloudflare/workers-types';
import { scoreJobLightAxes } from './scoring.js';
import type { ScorableProfile } from './profileScore.js';
import { asRoleLevel } from './routes/jobs/shared.js';

/** The job columns the bound is computed from. */
export interface RankableJob {
	id: string;
	title: string;
	location: string;
	workplace_type: string;
	salary_max: number | null;
	role_level: string | null;
}

/**
 * A fingerprint of exactly the profile fields the bound depends on.
 *
 * Not a timestamp: `profiles` has no updated_at, and a hash is the better
 * marker anyway — renaming a profile leaves the ranking valid, changing one
 * keyword does not. Arrays are sorted so a reordering that changes nothing
 * about the score does not force a 31k-row rebuild.
 */
export function criteriaHash(p: ScorableProfile): string {
	const norm = (xs: string[]) => [...xs].map((s) => s.trim().toLowerCase()).sort();
	return JSON.stringify([
		norm(p.keywords),
		p.track,
		norm(p.levels),
		p.remote_pref,
		norm(p.stack),
		norm(p.interests_like),
		norm(p.interests_avoid),
		p.salary_floor,
	]);
}

export function boundFor(job: RankableJob, profile: ScorableProfile) {
	const axes = scoreJobLightAxes(
		{
			title: job.title,
			location: job.location,
			workplace_type: job.workplace_type,
			salary_max: job.salary_max,
			role_level: asRoleLevel(job.role_level),
		},
		profile
	);
	return { bound: axes.bound, penalized: axes.penalized };
}

// D1 binds at most 100 parameters per statement; each row here binds four.
const ROWS_PER_STATEMENT = 20;
const STATEMENTS_PER_BATCH = 20;

/**
 * Write rank rows for these jobs under this profile, replacing any existing.
 *
 * Chunked twice over: by binds per statement, and by statements per batch, so a
 * full rebuild of a 31k-row corpus does not try to become one enormous write.
 */
export async function writeRanks(
	db: D1Database,
	profileId: string,
	profile: ScorableProfile,
	jobs: RankableJob[]
): Promise<number> {
	const stmts = [];
	for (let i = 0; i < jobs.length; i += ROWS_PER_STATEMENT) {
		const chunk = jobs.slice(i, i + ROWS_PER_STATEMENT);
		const values = chunk.map(() => '(?, ?, ?, ?)').join(', ');
		const binds: (string | number)[] = [];
		for (const job of chunk) {
			const { bound, penalized } = boundFor(job, profile);
			binds.push(profileId, job.id, bound, penalized ? 1 : 0);
		}
		stmts.push(
			db
				.prepare(
					`INSERT INTO job_profile_rank (profile_id, job_id, bound, penalized)
					 VALUES ${values}
					 ON CONFLICT (profile_id, job_id) DO UPDATE SET
					   bound = excluded.bound, penalized = excluded.penalized`
				)
				.bind(...binds)
		);
	}
	for (let i = 0; i < stmts.length; i += STATEMENTS_PER_BATCH) {
		await db.batch(stmts.slice(i, i + STATEMENTS_PER_BATCH));
	}
	return jobs.length;
}

export interface RankState {
	criteria_hash: string;
	max_job_rowid: number;
}

/**
 * Is this profile's stored ranking usable right now?
 *
 * Both checks are O(1) — a primary-key read and MAX(rowid), which costs one row
 * where COUNT(*) would read the whole table. Returning false is never wrong,
 * only slower: the caller ranks live instead.
 */
export async function rankIsCurrent(
	db: D1Database,
	profileId: string,
	profile: ScorableProfile
): Promise<boolean> {
	const [stateRes, headRes] = await db.batch<Record<string, unknown>>([
		db
			.prepare(
				'SELECT criteria_hash, max_job_rowid FROM job_profile_rank_state WHERE profile_id = ?'
			)
			.bind(profileId),
		db.prepare('SELECT MAX(rowid) AS head FROM jobs'),
	]);
	const state = stateRes.results[0] as unknown as RankState | undefined;
	if (!state) return false;
	if (state.criteria_hash !== criteriaHash(profile)) return false;
	const head = Number((headRes.results[0] as { head: number | null } | undefined)?.head ?? 0);
	return Number(state.max_job_rowid) >= head;
}

/** Record that this profile's ranking now covers the corpus as it stands. */
export async function markRankBuilt(
	db: D1Database,
	profileId: string,
	profile: ScorableProfile
): Promise<void> {
	const head = await db
		.prepare('SELECT MAX(rowid) AS head FROM jobs')
		.first<{ head: number | null }>();
	await db
		.prepare(
			`INSERT INTO job_profile_rank_state (profile_id, criteria_hash, max_job_rowid, built_at)
			 VALUES (?, ?, ?, ?)
			 ON CONFLICT (profile_id) DO UPDATE SET
			   criteria_hash = excluded.criteria_hash,
			   max_job_rowid = excluded.max_job_rowid,
			   built_at = excluded.built_at`
		)
		.bind(profileId, criteriaHash(profile), head?.head ?? 0, new Date().toISOString())
		.run();
}

/** Drop a profile's ranking — on delete, or before a rebuild under new criteria. */
export async function clearRank(db: D1Database, profileId: string): Promise<void> {
	await db.batch([
		db.prepare('DELETE FROM job_profile_rank WHERE profile_id = ?').bind(profileId),
		db.prepare('DELETE FROM job_profile_rank_state WHERE profile_id = ?').bind(profileId),
	]);
}

/** Every job the bound can be computed from, for a full rebuild. */
export async function loadRankableJobs(db: D1Database): Promise<RankableJob[]> {
	const res = await db
		.prepare('SELECT id, title, location, workplace_type, salary_max, role_level FROM jobs')
		.all<RankableJob>();
	return res.results;
}

/**
 * Build (or rebuild) one profile's ranking over the whole corpus.
 *
 * Clears first so rows for jobs that have since been culled cannot survive as
 * phantoms, and marks the state LAST — the marker is what the feed trusts, so
 * it must not claim coverage the table does not have. A failure part-way
 * therefore leaves the feed on the live path, which is slow and correct.
 */
export async function rebuildRank(
	db: D1Database,
	profileId: string,
	profile: ScorableProfile
): Promise<number> {
	await clearRank(db, profileId);
	const jobs = await loadRankableJobs(db);
	await writeRanks(db, profileId, profile, jobs);
	await markRankBuilt(db, profileId, profile);
	return jobs.length;
}
