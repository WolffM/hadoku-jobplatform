import type { OpenAPIHono } from '@hono/zod-openapi';
import { tierAtLeast, type HadokuAuthContext } from '@wolffm/worker-utils';
import type { AppEnv } from '../../types.js';
import { resolveUserId } from '../../userId.js';
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
// migration). Falls back to the legacy credential hash only for callers that
// bypass the edge. See userId.ts.
export async function maybeUserId(c: {
	req: { header: (name: string) => string | undefined };
	get: (k: 'authContext') => HadokuAuthContext;
}): Promise<string | null> {
	const auth = c.get('authContext');
	if (tierAtLeast(auth, 'friend') && auth.credential) {
		return resolveUserId(c);
	}
	return null;
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
	title_match: 0,
	keyword_match: 0,
	level_match: 0,
	remote_match: 0,
};
