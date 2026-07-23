/**
 * The shared default profile.
 *
 * Seeded from code (not the DB): every user sees this until they edit it
 * (copy-on-write into a real per-user row) or delete it (tombstone). The
 * reserved public id `default` addresses it in the API regardless of whether
 * the caller is seeing the code seed or their own edited copy — see
 * routes/profiles.ts.
 *
 * These are sensible owner-flavored starting values; any user is expected to
 * tailor them via the UI immediately. Bump the values here to change what new
 * users start from; it does NOT retroactively change users who already edited.
 */

export const DEFAULT_PROFILE_ID = 'default';

export interface DefaultProfileSeed {
	name: string;
	keywords: string[];
	target_companies: string[];
	role_types: string[];
	min_salary: number | null;
	remote_pref: 'remote' | 'hybrid' | 'onsite' | 'any';
	experience_levels: string[];
}

export const DEFAULT_PROFILE: DefaultProfileSeed = {
	name: 'Default',
	keywords: ['software engineer', 'ai', 'ml', 'platform', 'backend', 'distributed systems'],
	target_companies: [],
	role_types: ['senior', 'staff', 'principal', 'engineering manager'],
	min_salary: null,
	remote_pref: 'remote',
	experience_levels: ['senior', 'staff', 'principal', 'lead'],
};

// A stable, clearly-synthetic timestamp so the seed sorts first and never looks
// like a real creation time. Real per-user copies get a genuine created_at.
export const DEFAULT_PROFILE_CREATED_AT = '1970-01-01T00:00:00.000Z';
