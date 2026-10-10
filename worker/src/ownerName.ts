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
 * else keeps resolving to its previous holder until the entry expires.
 */
export const OWNER_NAME_TTL_MS = 15 * 60_000;

interface Entry {
	result: Promise<IdentityResult>;
	expiresAt: number;
}

/**
 * name → resolution, per isolate. Keyed the way the registry itself matches
 * (trimmed, lowercased), so "Hadoku" and "hadoku " are one lookup, as they are
 * one row. The PROMISE is stored, so concurrent requests for a name that is
 * not cached yet share one scan rather than each starting their own.
 */
const cache = new Map<string, Entry>();

/**
 * `resolveGranteeVia`, remembered for {@link OWNER_NAME_TTL_MS}.
 *
 * The contract is unchanged: callers pass a NAME and get back a userId the
 * edge resolved — this only stops asking it the same question every tick.
 * Only a success is kept. A 404/409 evicts the name, so the next request asks
 * again rather than inheriting a verdict, and a 503 is an outage, never an
 * answer worth keeping. An unbound `EDGE` skips the cache entirely: that is a
 * deployment fault and must keep reporting NO_REGISTRY, not serve a userId it
 * once resolved.
 */
export function resolveOwnerName(
	edge: EdgeIdentityBinding | undefined,
	serviceKey: string,
	name: string,
	now: number = Date.now()
): Promise<IdentityResult> {
	if (!edge) return resolveGranteeVia(edge, { serviceKey, name });
	const key = name.trim().toLowerCase();
	const hit = cache.get(key);
	if (hit && hit.expiresAt > now) return hit.result;

	const entry: Entry = {
		result: resolveGranteeVia(edge, { serviceKey, name }),
		expiresAt: now + OWNER_NAME_TTL_MS,
	};
	cache.set(key, entry);
	void entry.result.then(
		(result) => {
			if (isIdentityError(result) && cache.get(key) === entry) cache.delete(key);
		},
		() => {
			if (cache.get(key) === entry) cache.delete(key);
		}
	);
	return entry.result;
}

/** Forget every resolution. For tests, which share one isolate across cases. */
export function clearOwnerNameCache(): void {
	cache.clear();
}
