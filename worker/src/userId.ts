/**
 * Resolve the identity D1 rows are keyed by.
 *
 * `X-User-Id` — the stable per-user UUID that edge-router resolves from the key
 * registry and injects, having FIRST deleted any client-supplied copy. Its
 * presence is proof of identity (R1), and its value survives key rotation: a
 * rotation re-points which key maps to the userId, and the user's rows never
 * move.
 *
 * THERE IS NO FALLBACK, AND ITS ABSENCE IS THE POINT.
 *
 * Until 2026-08-28 this file also carried `userIdFromCredential` — SHA-256 of
 * the raw key, truncated — as "the legacy identity, retained only for callers
 * that bypass edge-router". Three things were wrong with that:
 *
 *   1. It was DERIVED FROM THE CREDENTIAL, so rotating a user's key produced a
 *      different id and orphaned every row they had (R3/R7).
 *   2. It MINTED. Only the registry may create a userId (R2); anything else
 *      silently invents an identity that no key can ever authenticate as
 *      again — and inventing one quietly is worse than refusing.
 *   3. It was documented as legacy and still reachable, which is the shape that
 *      reads as retired while running. The DATA was already clean — zero
 *      legacy ids across all six tables, verified 2026-08-27 — so the only
 *      thing the fallback still did was create new ones.
 *
 * A request with no `X-User-Id` did not come through the edge, so nobody has
 * established who is calling. That is an error, not a case to paper over.
 *
 * See docs/architecture/IDENTITY_MODEL.md in hadoku_site.
 */

/** Thrown when a request carries no edge-established identity. */
export class NoIdentityError extends Error {
	constructor() {
		super(
			'No X-User-Id on the request. Identity is established by edge-router and ' +
				'nowhere else — reach this worker through hadoku.me, not its workers.dev origin.'
		);
		this.name = 'NoIdentityError';
	}
}

export function resolveUserId(c: {
	req: { header: (name: string) => string | undefined };
}): Promise<string> {
	const injected = c.req.header('X-User-Id')?.trim();
	if (injected) return Promise.resolve(injected);
	throw new NoIdentityError();
}
