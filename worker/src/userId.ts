/**
 * LEGACY identity: SHA-256 of the raw credential, hex, truncated to 16 chars.
 *
 * This was the D1 `user_id` before the move to registry-backed identity. It is
 * derived FROM THE KEY, so rotating a user's key produced a different id and
 * ORPHANED all of their rows. Retained only as a fallback for callers that
 * bypass edge-router (direct *.workers.dev) and therefore get no X-User-Id.
 */
export async function userIdFromCredential(credential: string): Promise<string> {
	const data = new TextEncoder().encode(credential);
	const hash = await crypto.subtle.digest('SHA-256', data);
	return Array.from(new Uint8Array(hash))
		.slice(0, 8)
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

/**
 * Resolve the identity D1 rows are keyed by.
 *
 * Prefers `X-User-Id` — the stable per-user UUID that edge-router resolves from
 * the key registry and injects. It is decoupled from the key value, so it
 * survives key rotation: a rotation only re-points which key maps to the userId,
 * and the user's rows never move. This is the identity all rows are keyed by
 * after the one-time migration.
 *
 * Falls back to the legacy credential hash only when the request did not come
 * through the edge (no injection possible).
 */
export async function resolveUserId(c: {
	req: { header: (name: string) => string | undefined };
	get: (k: 'authContext') => { credential?: string } | undefined;
}): Promise<string> {
	const injected = c.req.header('X-User-Id');
	if (injected) return injected;
	const auth = c.get('authContext');
	if (!auth?.credential) {
		throw new Error('credential missing on authenticated route');
	}
	return userIdFromCredential(auth.credential);
}
