import type { D1Database } from '@cloudflare/workers-types';
import type { RoleLevel } from './roleClassify.js';

/** What the profile wants on the IC-vs-manager axis. 'either' = no constraint. */
export type ProfileTrack = 'ic' | 'manager' | 'either';

// The subset of a profile the scorer needs. Loaded on demand for score-on-read;
// there is no precomputed job_profile_matches table any more.
//
// `track` isn't a score factor — it's applied as a hard SQL filter on
// jobs.role_track before anything is scored (see routes/jobs.ts), the same way
// the profile's companies are. Asking for management roles and getting IC ones
// ranked slightly lower is not what anyone means by that request.
export interface ScorableProfile {
	keywords: string[];
	track: ProfileTrack;
	levels: RoleLevel[];
	remote_pref: string;
}

const NEUTRAL: ScorableProfile = {
	keywords: [],
	track: 'either',
	levels: [],
	remote_pref: 'any',
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
		.prepare('SELECT keywords, track, levels, remote_pref FROM profiles WHERE id = ?')
		.bind(profileId)
		.first<Record<string, unknown>>();
	if (!r) return NEUTRAL;
	return {
		keywords: JSON.parse(r.keywords as string) as string[],
		track: r.track as ProfileTrack,
		levels: JSON.parse(r.levels as string) as RoleLevel[],
		remote_pref: r.remote_pref as string,
	};
}
