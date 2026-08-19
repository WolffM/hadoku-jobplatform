import type { D1Database } from '@cloudflare/workers-types';
import type { RoleLevel } from './roleClassify.js';

/** What the profile wants on the IC-vs-manager axis. 'either' = no constraint. */
export type ProfileTrack = 'ic' | 'manager' | 'either';

// The subset of a profile the scorer needs. Loaded on demand for score-on-read;
// there is no precomputed job_profile_matches table any more.
//
// `track` isn't a score factor — it's applied as a hard SQL filter on
// jobs.role_track before anything is scored (see routes/jobs/feed.ts), the same way
// the profile's companies are. Asking for management roles and getting IC ones
// ranked slightly lower is not what anyone means by that request.
export interface ScorableProfile {
	keywords: string[];
	track: ProfileTrack;
	levels: RoleLevel[];
	remote_pref: string;
	stack: string[];
	interests_like: string[];
	interests_avoid: string[];
	salary_floor: number | null;
}

const NEUTRAL: ScorableProfile = {
	keywords: [],
	track: 'either',
	levels: [],
	remote_pref: 'any',
	stack: [],
	interests_like: [],
	interests_avoid: [],
	salary_floor: null,
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
		.prepare(
			'SELECT keywords, track, levels, remote_pref, stack, interests_like, interests_avoid, salary_floor FROM profiles WHERE id = ?'
		)
		.bind(profileId)
		.first<Record<string, unknown>>();
	if (!r) return NEUTRAL;
	const arr = (v: unknown): string[] => {
		try {
			const parsed = JSON.parse((v as string) || '[]') as unknown;
			return Array.isArray(parsed) ? (parsed as string[]) : [];
		} catch {
			return [];
		}
	};
	return {
		keywords: arr(r.keywords),
		track: r.track as ProfileTrack,
		levels: JSON.parse(r.levels as string) as RoleLevel[],
		remote_pref: r.remote_pref as string,
		stack: arr(r.stack),
		interests_like: arr(r.interests_like),
		interests_avoid: arr(r.interests_avoid),
		salary_floor: typeof r.salary_floor === 'number' ? r.salary_floor : null,
	};
}
