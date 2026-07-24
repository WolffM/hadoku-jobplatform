import type { D1Database } from '@cloudflare/workers-types';
import { scoreJob } from './scoring.js';

export interface ScorableProfile {
	id: string;
	keywords: string[];
	role_types: string[];
	remote_pref: string;
	min_salary: number | null;
}

interface JobRowForScore {
	id: string;
	title: string;
	description: string;
	workplace_type: string;
	salary_min: number | null;
}

const BATCH = 100;

/**
 * Score every existing job against one profile and upsert job_profile_matches.
 * Run when a profile is created/materialized so its feed isn't empty until the
 * next ingest. Batched to keep D1 round-trips bounded; safe to run in the
 * background via executionCtx.waitUntil.
 */
export async function scoreProfileAgainstAllJobs(
	db: D1Database,
	profile: ScorableProfile
): Promise<number> {
	const rows = await db
		.prepare('SELECT id, title, description, workplace_type, salary_min FROM jobs')
		.all<JobRowForScore>();
	const now = new Date().toISOString();

	let batch: ReturnType<D1Database['prepare']>[] = [];
	const flush = async () => {
		if (batch.length) {
			await db.batch(batch);
			batch = [];
		}
	};

	for (const j of rows.results) {
		const { score, breakdown } = scoreJob(
			{
				title: j.title,
				description: j.description,
				workplace_type: j.workplace_type,
				salary_min: j.salary_min,
			},
			profile
		);
		batch.push(
			db
				.prepare(
					`INSERT OR REPLACE INTO job_profile_matches (job_id, profile_id, score, score_breakdown, matched_at)
					 VALUES (?, ?, ?, ?, ?)`
				)
				.bind(j.id, profile.id, score, JSON.stringify(breakdown), now)
		);
		if (batch.length >= BATCH) await flush();
	}
	await flush();
	return rows.results.length;
}
