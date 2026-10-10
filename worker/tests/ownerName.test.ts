/**
 * The owner-name cache (issue #23): the apply runner names its owner every five
 * minutes, and each uncached resolve is a full key-registry scan at the edge.
 * These pin what the cache may and may not remember.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { isIdentityError } from '@wolffm/worker-utils/identity';
import { OWNER_NAME_TTL_MS, clearOwnerNameCache, resolveOwnerName } from '../src/ownerName.ts';

/** An edge stub that counts lookups and answers from a mutable name table. */
function countingEdge(table: Record<string, { status: number; body: unknown }>) {
	const calls: string[] = [];
	return {
		calls,
		edge: {
			async fetch(req: Request): Promise<Response> {
				const name = new URL(req.url).searchParams.get('name') ?? '';
				calls.push(name);
				const row = table[name.trim().toLowerCase()] ?? {
					status: 404,
					body: { error: 'No such name.', code: 'NAME_NOT_FOUND' },
				};
				return Response.json(row.body, { status: row.status });
			},
		},
	};
}

const HADOKU = { status: 200, body: { userId: 'user-hadoku', name: 'Hadoku', tier: 'admin' } };
const T0 = 1_000_000;

beforeEach(() => clearOwnerNameCache());

describe('resolveOwnerName', () => {
	it('asks the edge once per TTL window, whatever the spelling', async () => {
		const { edge, calls } = countingEdge({ hadoku: HADOKU });
		for (const [name, at] of [
			['Hadoku', T0],
			['hadoku', T0 + 5 * 60_000],
			[' HADOKU ', T0 + OWNER_NAME_TTL_MS - 1],
		] as const) {
			const r = await resolveOwnerName(edge, 'k', name, at);
			assert.ok(!isIdentityError(r));
			assert.equal(r.userId, 'user-hadoku');
		}
		assert.equal(calls.length, 1);

		await resolveOwnerName(edge, 'k', 'Hadoku', T0 + OWNER_NAME_TTL_MS);
		assert.equal(calls.length, 2, 'an expired entry is asked again');
	});

	it('shares one lookup between concurrent requests', async () => {
		const { edge, calls } = countingEdge({ hadoku: HADOKU });
		await Promise.all([1, 2, 3].map(() => resolveOwnerName(edge, 'k', 'Hadoku', T0)));
		assert.equal(calls.length, 1);
	});

	it('never remembers a 404 or 409, so a fixed name resolves on the next call', async () => {
		const table: Record<string, { status: number; body: unknown }> = {
			ghost: { status: 409, body: { error: 'Never signed in.', code: 'NO_USER_ID' } },
		};
		const { edge, calls } = countingEdge(table);

		const missing = await resolveOwnerName(edge, 'k', 'Hadoku', T0);
		assert.ok(isIdentityError(missing) && missing.status === 404);
		const ghost = await resolveOwnerName(edge, 'k', 'Ghost', T0);
		assert.ok(isIdentityError(ghost) && ghost.status === 409);

		table.hadoku = HADOKU;
		table.ghost = { status: 200, body: { userId: 'user-ghost', name: 'Ghost' } };
		const hadoku = await resolveOwnerName(edge, 'k', 'Hadoku', T0 + 1);
		const signedIn = await resolveOwnerName(edge, 'k', 'Ghost', T0 + 1);
		assert.ok(!isIdentityError(hadoku) && hadoku.userId === 'user-hadoku');
		assert.ok(!isIdentityError(signedIn) && signedIn.userId === 'user-ghost');
		assert.equal(calls.length, 4);
	});

	it('never remembers an outage', async () => {
		let up = false;
		const edge = {
			async fetch(): Promise<Response> {
				if (!up) throw new Error('edge down');
				return Response.json(HADOKU.body);
			},
		};
		const down = await resolveOwnerName(edge, 'k', 'Hadoku', T0);
		assert.ok(isIdentityError(down) && down.status === 503);
		up = true;
		const r = await resolveOwnerName(edge, 'k', 'Hadoku', T0 + 1);
		assert.ok(!isIdentityError(r) && r.userId === 'user-hadoku');
	});

	it('does not answer from cache when the edge binding is missing', async () => {
		const { edge } = countingEdge({ hadoku: HADOKU });
		await resolveOwnerName(edge, 'k', 'Hadoku', T0);
		const r = await resolveOwnerName(undefined, 'k', 'Hadoku', T0 + 1);
		assert.ok(isIdentityError(r));
		assert.equal(r.code, 'NO_REGISTRY');
	});
});
