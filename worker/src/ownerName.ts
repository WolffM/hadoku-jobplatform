import type { D1Database } from '@cloudflare/workers-types';
import { tierAtLeast, type HadokuAuthContext } from '@wolffm/worker-utils';
import {
	isIdentityError,
	resolveGranteeVia,
	type EdgeIdentityBinding,
	type IdentityResult,
} from '@wolffm/worker-utils/identity';

/**
 * How long a resolved owner name is trusted before edge-router is asked again.
 *
 * Every resolve is a full key-registry scan at the edge — one KV `list` over
 * ~870 rows — and `hs apply run --owner hadoku` asks the same name every five
 * minutes, which was most of the account's KV reads (issue #23). Fifteen
 * minutes is three ticks per scan instead of one, and it is also the bound on
 * how long a rename or retire can go unnoticed: a name that moved to someone
 * else keeps resolving to its previous holder until the row expires.
 */
export const OWNER_NAME_TTL_MS = 15 * 60_000;

/**
 * When a remembered name has less than this left, a hit answers from the row
 * AND re-asks the edge behind the response.
 *
 * Without it every third tick of the five-minute runner was a miss: the row
 * expired between ticks, and that request paid the edge's registry scan,
 * 500-1000ms and once 15s (issue #26; 74% of all `GET /applications` time on
 * 2026-11-03). Half the TTL means a caller that asks at least that often keeps
 * the row fresh and never waits on the edge. An expired row is still never
 * answered from, so the rename bound above is unchanged.
 */
export const OWNER_NAME_REFRESH_AHEAD_MS = OWNER_NAME_TTL_MS / 2;

/** Hands work to `waitUntil`; see `runAfterResponse` in background.ts. */
export type Defer = (label: string, work: Promise<unknown>) => void;

/** Ask the edge and record what it said: a success is kept, a 404/409 forgets the name. */
async function resolveAndRemember(
	db: D1Database,
	edge: EdgeIdentityBinding,
	serviceKey: string,
	name: string,
	key: string,
	now: number
): Promise<IdentityResult> {
	const result = await resolveGranteeVia(edge, { serviceKey, name });
	if (!isIdentityError(result)) {
		await db
			.prepare(
				`INSERT OR REPLACE INTO owner_name_cache (name_key, user_id, name, tier, expires_at)
				 VALUES (?, ?, ?, ?, ?)`
			)
			.bind(key, result.userId, result.name, result.tier ?? null, now + OWNER_NAME_TTL_MS)
			.run();
	} else if (result.status === 404 || result.status === 409) {
		await db.prepare('DELETE FROM owner_name_cache WHERE name_key = ?').bind(key).run();
	}
	return result;
}

/**
 * `resolveGranteeVia`, remembered for {@link OWNER_NAME_TTL_MS} in D1.
 *
 * D1, not an in-isolate Map: the Map was measured missing on requests 20s
 * apart, because consecutive requests rarely share an isolate.
 *
 * The contract is unchanged: callers pass a NAME and get back a userId the
 * edge resolved — this only stops asking it the same question every tick.
 * Only a success is kept. A 404/409 deletes the row, so a retired or renamed
 * name is never answered from cache once the edge has said so, and a 503 is an
 * outage, never an answer worth keeping. An unbound `EDGE` skips the cache:
 * that is a deployment fault and must keep reporting NO_REGISTRY.
 *
 * With `defer`, a hit inside {@link OWNER_NAME_REFRESH_AHEAD_MS} of expiry is
 * refreshed behind the response. Without it the row simply runs out.
 */
export async function resolveOwnerName(
	db: D1Database,
	edge: EdgeIdentityBinding | undefined,
	serviceKey: string,
	name: string,
	now: number = Date.now(),
	defer?: Defer
): Promise<IdentityResult> {
	if (!edge) return resolveGranteeVia(edge, { serviceKey, name });
	const key = name.trim().toLowerCase();
	const hit = await db
		.prepare(
			'SELECT user_id, name, tier, expires_at FROM owner_name_cache WHERE name_key = ? AND expires_at > ?'
		)
		.bind(key, now)
		.first<{ user_id: string; name: string | null; tier: string | null; expires_at: number }>();
	if (hit) {
		if (defer && hit.expires_at - now <= OWNER_NAME_REFRESH_AHEAD_MS) {
			defer('owner name refresh', resolveAndRemember(db, edge, serviceKey, name, key, now));
		}
		return { userId: hit.user_id, name: hit.name, ...(hit.tier ? { tier: hit.tier } : {}) };
	}
	return resolveAndRemember(db, edge, serviceKey, name, key, now);
}

/**
 * Whether this caller may act for a named owner (`ownerName`): admin, or a
 * service caller whose registry userId is in `ON_BEHALF_CALLER_USER_IDS`.
 *
 * Service tier alone used to be enough, and service tier is every service key
 * in the fleet plus every person holding a service grant, so any of them could
 * read and rewrite anyone's jobs, applications, answers and profiles. One
 * caller sends it (the scraper's apply queue); the list names that one. The
 * userId is compared whole: it is the edge-injected identity, never a name.
 */
/** What a caller that may not act for a named owner is told. */
export const ON_BEHALF_REFUSAL =
	'Only admin, or a service caller named in ON_BEHALF_CALLER_USER_IDS, may act on behalf of a named owner.';

export function mayActOnBehalf(
	auth: HadokuAuthContext,
	callerId: string | null | undefined,
	allowed: string | undefined
): boolean {
	if (tierAtLeast(auth, 'admin')) return true;
	if (!tierAtLeast(auth, 'service') || !callerId) return false;
	return (allowed ?? '')
		.split(',')
		.map((id) => id.trim())
		.filter(Boolean)
		.includes(callerId);
}
