import type { D1Database } from '@cloudflare/workers-types';

// The subset of a profile the scorer needs. Loaded on demand for score-on-read;
// there is no precomputed job_profile_matches table any more.
export interface ScorableProfile {
	keywords: string[];
	role_types: string[];
	remote_pref: string;
	min_salary: number | null;
}

const NEUTRAL: ScorableProfile = {
	keywords: [],
	role_types: [],
	remote_pref: 'any',
	min_salary: null,
};

/**
 * Load a profile's scoring criteria by id, or a neutral profile when the id is
 * unknown (so a stale profile_id degrades to "no constraints" rather than 500).
 */
export async function loadScorableProfile(
	db: D1Database,
	profileId: string
): Promise<ScorableProfile> {
	const r = await db
		.prepare('SELECT keywords, role_types, remote_pref, min_salary FROM profiles WHERE id = ?')
		.bind(profileId)
		.first<Record<string, unknown>>();
	if (!r) return NEUTRAL;
	return {
		keywords: JSON.parse(r.keywords as string) as string[],
		role_types: JSON.parse(r.role_types as string) as string[],
		remote_pref: r.remote_pref as string,
		min_salary: r.min_salary as number | null,
	};
}
