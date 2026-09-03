import type { OpenAPIHono } from '@hono/zod-openapi';
import { tierAtLeast, type HadokuAuthContext } from '@wolffm/worker-utils';
import { isIdentityError, resolveGranteeVia } from '@wolffm/worker-utils/identity';
import type { Fetcher } from '@cloudflare/workers-types';
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

/** The refusal body, shaped to match ErrorResponseSchema / IdentityErrorResponseSchema. */
export interface IdentityRefusal {
	status: 403 | 404 | 409 | 503;
	body: {
		success: false;
		error: string;
		message: string;
		code?: 'NO_REGISTRY' | 'NAME_NOT_FOUND' | 'NO_USER_ID';
	};
}

/** What `effectiveUserId` decided, or the response the caller should get. */
export type EffectiveUser =
	| { userId: string; onBehalfOf: string | null }
	| { error: IdentityRefusal };

export function isEffectiveUserError(v: EffectiveUser): v is { error: IdentityRefusal } {
	return 'error' in v;
}

/**
 * Whose rows this request operates on.
 *
 * Without `ownerName` it is the caller's own — the browser case, unchanged.
 *
 * With `ownerName`, the caller is asking to act as a named person. That is how the
 * PC-side form runner works at all: it authenticates as a SERVICE and the queue
 * is keyed to a PERSON, so without this the two can never see the same rows.
 * The runner drained its own service-owned queue for a day while the owner's
 * dashboard showed nothing, which is what this exists to fix.
 *
 * SERVICE OR ADMIN ONLY, and that gate is the whole security of it. A
 * friend-tier caller is a signed-in human in a browser; letting one pass
 * `ownerName=SomeoneElse` would turn every per-user route into a way to read and
 * mutate another person's queue. Friend gets 403 — not a 404, because the row
 * they are reaching for is real and refusing to say so would be misleading
 * about their OWN permissions rather than about someone else's data.
 *
 * The name is resolved, never trusted (R5). What comes back is a userId from
 * the registry; `ownerName` itself never reaches a database column.
 *
 * IT IS CALLED `ownerName`, NOT `owner`, AND THAT IS LOAD-BEARING. The field
 * carries a display NAME to be resolved — never an already-resolved identity —
 * and `owner` is one of the names the identity-model contract reserves for the
 * resolved kind (alongside userId/ownerUserId/ownerId), because there is no way
 * to re-resolve one of those and reading it off a body is therefore always
 * wrong. Under the old name this function's own call sites read as G3
 * violations while doing exactly the right thing, and the check could not tell
 * the difference from the field name alone — which is the point: if the two
 * kinds share a name, neither a reviewer nor a gate can separate them. Renamed
 * 2026-09-03. Keep any future on-behalf-of parameter in the `*Name` shape.
 */
export async function effectiveUserId(
	c: {
		req: { header: (name: string) => string | undefined };
		get: (k: 'authContext') => HadokuAuthContext;
		env: { EDGE?: Fetcher; SCRAPER_USER_KEY?: string };
	},
	ownerName: string | undefined
): Promise<EffectiveUser> {
	const callerId = await maybeUserId(c);
	if (!callerId) {
		return {
			error: {
				status: 403,
				body: { success: false as const, error: 'Forbidden', message: 'Authentication required' },
			},
		};
	}
	if (!ownerName || !ownerName.trim()) return { userId: callerId, onBehalfOf: null };

	if (!tierAtLeast(c.get('authContext'), 'service')) {
		return {
			error: {
				status: 403,
				body: {
					success: false as const,
					error: 'Forbidden',
					message: 'Only a service or admin caller may act on behalf of a named owner.',
				},
			},
		};
	}

	const resolved = await resolveGranteeVia(c.env.EDGE, {
		serviceKey: c.env.SCRAPER_USER_KEY ?? '',
		name: ownerName,
	});
	if (isIdentityError(resolved)) {
		// The three codes mean different things; 503 especially must not read as
		// "no such user" when it is our own resolver being unreachable.
		const status = ([404, 409, 503] as const).includes(resolved.status as 404 | 409 | 503)
			? (resolved.status as 404 | 409 | 503)
			: 503;
		return {
			error: {
				status,
				body: {
					success: false as const,
					error: status === 503 ? 'Unavailable' : status === 409 ? 'Conflict' : 'Not found',
					message: resolved.error,
					...(resolved.code ? { code: resolved.code } : {}),
				},
			},
		};
	}
	return { userId: resolved.userId, onBehalfOf: resolved.name };
}
