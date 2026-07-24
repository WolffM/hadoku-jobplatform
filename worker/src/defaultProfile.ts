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

export interface DefaultProfileSeed {
	name: string;
	keywords: string[];
	role_types: string[];
	min_salary: number | null;
	remote_pref: 'remote' | 'hybrid' | 'onsite' | 'any';
	experience_levels: string[];
}

export const DEFAULT_PROFILE: DefaultProfileSeed = {
	name: 'Default',
	keywords: ['software engineer', 'ai', 'ml', 'platform', 'backend', 'distributed systems'],
	role_types: ['senior', 'staff', 'principal', 'manager'],
	min_salary: null,
	remote_pref: 'remote',
	experience_levels: ['senior', 'staff', 'principal', 'lead'],
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
