/**
 * The shared default profile — the starting "hiring slice" every user gets.
 *
 * Seeded from code. On a user's first GET /profiles it's materialized into a
 * real per-user `profiles` row (flagged is_default=1) plus its seed companies,
 * so it participates in scoring and can own companies like any profile. Editing
 * it just updates that row; deleting it writes a tombstone so it isn't
 * re-created. Bump these values to change what NEW users start from; it does
 * not retroactively change users who already have the row.
 */

import type { RoleLevel } from './roleClassify.js';
import type { ProfileTrack } from './profileScore.js';

export interface DefaultProfileSeed {
	name: string;
	keywords: string[];
	track: ProfileTrack;
	levels: RoleLevel[];
	remote_pref: 'remote' | 'hybrid' | 'onsite' | 'any';
}

export const DEFAULT_PROFILE: DefaultProfileSeed = {
	name: 'Default',
	keywords: ['software engineer', 'ai', 'ml', 'platform', 'backend', 'distributed systems'],
	// 'either' out of the box: the old seed asked for senior/staff/principal AND
	// manager, which under the new hard track filter would otherwise silently
	// halve a new user's feed.
	track: 'either',
	levels: ['senior', 'staff', 'principal', 'manager'],
	remote_pref: 'remote',
};

export interface DefaultCompany {
	ats: string;
	slug: string;
	display_name: string;
}

/** Companies the default profile ships with — a useful starter set of real,
 * currently-hiring boards so the profile works out of the box. */
export const DEFAULT_PROFILE_COMPANIES: DefaultCompany[] = [
	{ ats: 'greenhouse', slug: 'anthropic', display_name: 'Anthropic' },
	{ ats: 'greenhouse', slug: 'databricks', display_name: 'Databricks' },
	{ ats: 'greenhouse', slug: 'stripe', display_name: 'Stripe' },
	{ ats: 'greenhouse', slug: 'waymo', display_name: 'Waymo' },
	{ ats: 'greenhouse', slug: 'scaleai', display_name: 'Scale AI' },
	{ ats: 'ashby', slug: 'openai', display_name: 'OpenAI' },
	{ ats: 'lever', slug: 'anyscale', display_name: 'Anyscale' },
	{ ats: 'lever', slug: 'mistral', display_name: 'Mistral' },
	{ ats: 'lever', slug: 'plaid', display_name: 'Plaid' },
];
