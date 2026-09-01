/**
 * Row builders for the integration tests.
 *
 * These write straight to D1 with the same columns the ingest route does. They
 * are deliberately thin — the point is that the route under test reads real
 * rows through real SQL, so the only thing worth abstracting is the tedium of
 * naming every NOT NULL column.
 */
import type { D1Database } from '@cloudflare/workers-types';

export interface JobSeed {
	id: string;
	url?: string;
	source_site?: string;
	title?: string;
	company?: string;
	location?: string;
	job_type?: string;
	workplace_type?: string;
	salary_min?: number | null;
	salary_max?: number | null;
	description?: string;
	posted_date?: string | null;
	application_url?: string | null;
	department?: string | null;
	scraper_used?: string | null;
	scraped_at?: string;
	run_id?: string | null;
	ats?: string | null;
	slug?: string | null;
	/** Liveness stamp (migration 0013). Defaults to scraped_at, as ingest does. */
	last_seen_at?: string | null;
	role_track?: string;
	role_level?: string | null;
}

export async function seedJob(db: D1Database, job: JobSeed): Promise<void> {
	await db
		.prepare(
			`INSERT INTO jobs (
				id, url, source_site, title, company, location, job_type, workplace_type,
				salary_min, salary_max, description, posted_date, application_url,
				department, scraper_used, raw, scraped_at, run_id, ats, slug,
				role_track, role_level, last_seen_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, ?, ?, ?)`
		)
		.bind(
			job.id,
			job.url ?? `https://boards.greenhouse.io/acme/jobs/${job.id}`,
			job.source_site ?? 'greenhouse',
			job.title ?? 'Software Engineer',
			job.company ?? 'Acme',
			job.location ?? 'Remote',
			job.job_type ?? 'full_time',
			job.workplace_type ?? 'remote',
			job.salary_min ?? null,
			job.salary_max ?? null,
			job.description ?? 'We build things.',
			job.posted_date ?? null,
			job.application_url ?? null,
			job.department ?? null,
			job.scraper_used ?? null,
			job.scraped_at ?? '2026-08-01T00:00:00.000Z',
			job.run_id ?? null,
			// `??` would swallow an explicit null, and a keyword-feed job (no
			// board, hence no ats/slug) is a case the tests must be able to build.
			job.ats !== undefined ? job.ats : 'greenhouse',
			job.slug !== undefined ? job.slug : 'acme',
			job.role_track ?? 'ic',
			job.role_level ?? null,
			job.last_seen_at !== undefined ? job.last_seen_at : (job.scraped_at ?? null)
		)
		.run();
}

export interface ProfileSeed {
	id: string;
	user_id?: string;
	name?: string;
	keywords?: string[];
	track?: 'ic' | 'manager' | 'either';
	levels?: string[];
	remote_pref?: string;
	is_default?: boolean;
}

export async function seedProfile(db: D1Database, profile: ProfileSeed): Promise<void> {
	await db
		.prepare(
			`INSERT INTO profiles (
				id, user_id, name, keywords, target_companies, remote_pref,
				created_at, is_default, track, levels
			) VALUES (?, ?, ?, ?, '[]', ?, ?, ?, ?, ?)`
		)
		.bind(
			profile.id,
			profile.user_id ?? 'user-one',
			profile.name ?? 'Test Profile',
			JSON.stringify(profile.keywords ?? []),
			profile.remote_pref ?? 'any',
			'2026-08-01T00:00:00.000Z',
			profile.is_default ? 1 : 0,
			profile.track ?? 'either',
			JSON.stringify(profile.levels ?? [])
		)
		.run();
}

export async function seedProfileCompany(
	db: D1Database,
	row: { id: string; profile_id: string; ats: string; slug: string; display_name?: string }
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO profile_companies (id, profile_id, ats, slug, display_name, target_id, added_at)
			 VALUES (?, ?, ?, ?, ?, NULL, ?)`
		)
		.bind(
			row.id,
			row.profile_id,
			row.ats,
			row.slug,
			row.display_name ?? row.slug,
			'2026-08-01T00:00:00.000Z'
		)
		.run();
}

export async function seedJobState(
	db: D1Database,
	row: { job_id: string; user_id: string; state: string; variant_slug?: string | null }
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO job_states (job_id, user_id, state, notes, updated_at, variant_slug)
			 VALUES (?, ?, ?, NULL, ?, ?)`
		)
		.bind(row.job_id, row.user_id, row.state, '2026-08-01T00:00:00.000Z', row.variant_slug ?? null)
		.run();
}
