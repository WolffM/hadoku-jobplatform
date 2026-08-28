/**
 * Where a userId comes from — and, more importantly, where it does NOT.
 *
 * This file used to have a sibling behaviour worth stating plainly: when a
 * request carried no `X-User-Id`, the worker SYNTHESISED one by hashing the
 * caller's raw credential. It was documented as legacy and it was still
 * reachable, which is the shape that reads as retired while running.
 *
 * Three things were wrong with it, and the tests below pin all three shut:
 *
 *   R1  only edge-router establishes identity. A request with no `X-User-Id`
 *       did not come through the edge, so nobody has said who is calling.
 *   R2  only the registry mints a userId. Anything else invents an identity
 *       that no key can ever authenticate as — quietly, which is worse than
 *       refusing.
 *   R3/R7 the hash was DERIVED FROM THE CREDENTIAL, so rotating a user's key
 *       produced a different id and orphaned every row they owned.
 *
 * See docs/architecture/IDENTITY_MODEL.md in hadoku_site.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { NoIdentityError, resolveUserId } from '../src/userId.ts';

const UID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';

const ctx = (headers: Record<string, string>) => ({
	req: { header: (name: string) => headers[name] },
});

describe('resolveUserId', () => {
	it('returns the edge-injected identity', async () => {
		assert.equal(await resolveUserId(ctx({ 'X-User-Id': UID })), UID);
	});

	it('trims, so a header with stray whitespace still resolves', async () => {
		assert.equal(await resolveUserId(ctx({ 'X-User-Id': `  ${UID}  ` })), UID);
	});

	it('THROWS rather than synthesising one when the header is absent', async () => {
		// The regression. It used to return sha256(credential)[:16] here.
		assert.throws(() => resolveUserId(ctx({})), NoIdentityError);
	});

	it('throws for an empty or whitespace-only header too', () => {
		assert.throws(() => resolveUserId(ctx({ 'X-User-Id': '' })), NoIdentityError);
		assert.throws(() => resolveUserId(ctx({ 'X-User-Id': '   ' })), NoIdentityError);
	});

	it('does not consult the credential at all', async () => {
		// The header wins outright; nothing reads a key. If a credential could
		// still influence the answer, rotation could still orphan rows.
		let credentialRead = false;
		const c = {
			req: { header: (n: string) => (n === 'X-User-Id' ? UID : undefined) },
			get: () => {
				credentialRead = true;
				return { credential: 'some-raw-key' };
			},
		};
		assert.equal(await resolveUserId(c), UID);
		assert.equal(credentialRead, false);
	});

	it('is opaque downstream — it stores whatever the edge resolved (R6)', async () => {
		// The counterpart to the study incident's wrong lesson. This code is an
		// INTERIOR: it was handed a resolved id, so it does not parse or
		// shape-check it. Validation belongs at the boundary that ACCEPTS a
		// reference from outside, which is not this.
		const odd = 'de5c2a05-573f-4b26-a27f-705bb604fd69';
		assert.equal(await resolveUserId(ctx({ 'X-User-Id': odd })), odd);
	});
});
