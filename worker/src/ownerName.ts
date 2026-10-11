import type { D1Database } from '@cloudflare/workers-types';
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
 */
export async function resolveOwnerName(
	db: D1Database,
	edge: EdgeIdentityBinding | undefined,
	serviceKey: string,
	name: string,
	now: number = Date.now()
): Promise<IdentityResult> {
	if (!edge) return resolveGranteeVia(edge, { serviceKey, name });
	const key = name.trim().toLowerCase();
	const hit = await db
		.prepare(
			'SELECT user_id, name, tier FROM owner_name_cache WHERE name_key = ? AND expires_at > ?'
		)
		.bind(key, now)
		.first<{ user_id: string; name: string | null; tier: string | null }>();
	if (hit) return { userId: hit.user_id, name: hit.name, ...(hit.tier ? { tier: hit.tier } : {}) };

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
