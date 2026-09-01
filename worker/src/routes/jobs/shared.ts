import type { OpenAPIHono } from '@hono/zod-openapi';
import { tierAtLeast, type HadokuAuthContext } from '@wolffm/worker-utils';
import type { AppEnv } from '../../types.js';
import { NoIdentityError, resolveUserId } from '../../userId.js';
import { ALL_LEVELS, type RoleLevel } from '../../roleClassify.js';

export interface RouteContext {
	Bindings: AppEnv;
	Variables: { authContext: HadokuAuthContext };
}

/** The app every module in this directory registers onto. */
export type JobsApp = OpenAPIHono<RouteContext>;

// D1 hands back plain TEXT for the classified columns. Narrow it here so a row
// written before 0009 (or by a future classifier that learned a new rung)
// degrades to null/'unknown' instead of leaking a bogus value into the response
// and failing the OpenAPI enum.
export function asRoleLevel(v: string | null): RoleLevel | null {
	return v !== null && (ALL_LEVELS as readonly string[]).includes(v) ? (v as RoleLevel) : null;
}

export function asRoleTrack(v: string): 'ic' | 'manager' | 'unknown' {
	return v === 'ic' || v === 'manager' ? v : 'unknown';
}

// Resolve the caller to a user id, or null when unauthenticated.
//
// Prefers the edge-injected X-User-Id (the registry UUID that survives key
// rotation, and the identity job_states rows are keyed by after the one-time
// migration).
//
// Returns null when there is no identity to have — a public caller, or an
// authenticated one whose request never passed through the edge. The legacy
// credential-hash fallback that used to fill that gap is gone: it MINTED an id
// nothing could authenticate as, and derived it from the credential, so a
// rotation orphaned every row. See userId.ts.
export async function maybeUserId(c: {
	req: { header: (name: string) => string | undefined };
	get: (k: 'authContext') => HadokuAuthContext;
}): Promise<string | null> {
	const auth = c.get('authContext');
	if (!tierAtLeast(auth, 'friend') || !auth.credential) return null;
	try {
		return await resolveUserId(c);
	} catch (err) {
		// "maybe" is exactly what this means: authenticated, but nobody
		// established WHO, so there is no identity to scope rows to.
		if (err instanceof NoIdentityError) return null;
		throw err;
	}
}

/** Middleware for the mutating routes: admin/friend and above only. */
export async function gateAuthed(
	c: { get: (k: 'authContext') => HadokuAuthContext; json: (b: unknown, s?: number) => Response },
	next: () => Promise<void>
) {
	const auth = c.get('authContext');
	if (!tierAtLeast(auth, 'friend')) {
		return c.json(
			{ success: false as const, error: 'Forbidden', message: 'Authentication required' },
			403
		);
	}
	await next();
	return;
}

/** The score shape returned when nothing was scored. */
export const ZERO_BREAKDOWN = {
	relevance: 0,
	level_match: 0,
	geo_fit: 0,
	comp_fit: 0,
	stack_fit: 0,
	domain_interest: 0,
	discipline_factor: 0,
};

/**
 * Narrow jobs.slug_source to the values the API promises.
 *
 * Anything unrecognised — including the NULL on every row written before
 * migration 0018 — becomes 'guessed', which is the SAFE reading: a consumer
 * that will not build a URL from an unverified slug should treat "we don't
 * know where this came from" exactly like "we made it up".
 */
export function asSlugSource(value: string | null): 'scraped' | 'guessed' | 'verified' | null {
	if (value === null) return null;
	return value === 'scraped' || value === 'verified' ? value : 'guessed';
}
