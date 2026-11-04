/**
 * The owner-name cache (issue #23): the apply runner names its owner every five
 * minutes, and each uncached resolve is a full key-registry scan at the edge.
 * These pin what the cache may and may not remember, against a real D1.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { isIdentityError } from '@wolffm/worker-utils/identity';
import {
	mayActOnBehalf,
	OWNER_NAME_REFRESH_AHEAD_MS,
	OWNER_NAME_TTL_MS,
	resolveOwnerName,
} from '../src/ownerName.ts';
import type { HadokuAuthContext } from '@wolffm/worker-utils';
import { createHarness, type Harness } from './helpers/harness.ts';

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

let h: Harness;
before(async () => {
	h = await createHarness();
});
after(async () => {
	await h.dispose();
});
beforeEach(async () => {
	await h.db.prepare('DELETE FROM owner_name_cache').run();
});

describe('resolveOwnerName', () => {
	it('asks the edge once per TTL window, whatever the spelling', async () => {
		const { edge, calls } = countingEdge({ hadoku: HADOKU });
		for (const [name, at] of [
			['Hadoku', T0],
			['hadoku', T0 + 5 * 60_000],
			[' HADOKU ', T0 + OWNER_NAME_TTL_MS - 1],
		] as const) {
			const r = await resolveOwnerName(h.db, edge, 'k', name, at);
			assert.ok(!isIdentityError(r));
			assert.deepEqual(r, { userId: 'user-hadoku', name: 'Hadoku', tier: 'admin' });
		}
		assert.equal(calls.length, 1);

		await resolveOwnerName(h.db, edge, 'k', 'Hadoku', T0 + OWNER_NAME_TTL_MS);
		assert.equal(calls.length, 2, 'an expired row is asked again');
	});

	it('never remembers a 404 or 409, so a fixed name resolves on the next call', async () => {
		const table: Record<string, { status: number; body: unknown }> = {
			ghost: { status: 409, body: { error: 'Never signed in.', code: 'NO_USER_ID' } },
		};
		const { edge, calls } = countingEdge(table);

		const missing = await resolveOwnerName(h.db, edge, 'k', 'Hadoku', T0);
		assert.ok(isIdentityError(missing) && missing.status === 404);
		const ghost = await resolveOwnerName(h.db, edge, 'k', 'Ghost', T0);
		assert.ok(isIdentityError(ghost) && ghost.status === 409);

		table.hadoku = HADOKU;
		table.ghost = { status: 200, body: { userId: 'user-ghost', name: 'Ghost' } };
		const hadoku = await resolveOwnerName(h.db, edge, 'k', 'Hadoku', T0 + 1);
		const signedIn = await resolveOwnerName(h.db, edge, 'k', 'Ghost', T0 + 1);
		assert.ok(!isIdentityError(hadoku) && hadoku.userId === 'user-hadoku');
		assert.ok(!isIdentityError(signedIn) && signedIn.userId === 'user-ghost');
		assert.equal(calls.length, 4);
	});

	it('drops a remembered name the moment the edge says it is gone', async () => {
		const table: Record<string, { status: number; body: unknown }> = { hadoku: HADOKU };
		const { edge } = countingEdge(table);
		await resolveOwnerName(h.db, edge, 'k', 'Hadoku', T0);

		delete table.hadoku;
		const expired = T0 + OWNER_NAME_TTL_MS;
		const gone = await resolveOwnerName(h.db, edge, 'k', 'Hadoku', expired);
		assert.ok(isIdentityError(gone) && gone.status === 404);
		const rows = await h.db
			.prepare('SELECT COUNT(*) AS n FROM owner_name_cache')
			.first<{ n: number }>();
		assert.equal(rows?.n, 0);
	});

	it('never remembers an outage', async () => {
		let up = false;
		const edge = {
			async fetch(): Promise<Response> {
				if (!up) throw new Error('edge down');
				return Response.json(HADOKU.body);
			},
		};
		const down = await resolveOwnerName(h.db, edge, 'k', 'Hadoku', T0);
		assert.ok(isIdentityError(down) && down.status === 503);
		up = true;
		const r = await resolveOwnerName(h.db, edge, 'k', 'Hadoku', T0 + 1);
		assert.ok(!isIdentityError(r) && r.userId === 'user-hadoku');
	});

	it('does not answer from cache when the edge binding is missing', async () => {
		const { edge } = countingEdge({ hadoku: HADOKU });
		await resolveOwnerName(h.db, edge, 'k', 'Hadoku', T0);
		const r = await resolveOwnerName(h.db, undefined, 'k', 'Hadoku', T0 + 1);
		assert.ok(isIdentityError(r));
		assert.equal(r.code, 'NO_REGISTRY');
	});
});

/** Collects what resolveOwnerName hands to waitUntil, so a test can run it when it chooses. */
function collectingDefer() {
	const deferred: { label: string; work: Promise<unknown> }[] = [];
	return {
		deferred,
		defer: (label: string, work: Promise<unknown>) => deferred.push({ label, work }),
	};
}

const expiresAt = async () =>
	(
		await h.db
			.prepare("SELECT expires_at FROM owner_name_cache WHERE name_key = 'hadoku'")
			.first<{ expires_at: number }>()
	)?.expires_at;

describe('resolveOwnerName: refresh ahead of expiry (issue #26)', () => {
	it('leaves a fresh row alone', async () => {
		const { edge, calls } = countingEdge({ hadoku: HADOKU });
		await resolveOwnerName(h.db, edge, 'k', 'Hadoku', T0);
		const { deferred, defer } = collectingDefer();
		const r = await resolveOwnerName(
			h.db,
			edge,
			'k',
			'Hadoku',
			T0 + OWNER_NAME_TTL_MS - OWNER_NAME_REFRESH_AHEAD_MS - 1,
			defer
		);
		assert.ok(!isIdentityError(r) && r.userId === 'user-hadoku');
		assert.equal(deferred.length, 0);
		assert.equal(calls.length, 1);
	});

	it('answers from the row, and re-asks the edge only behind the response', async () => {
		const { edge, calls } = countingEdge({ hadoku: HADOKU });
		await resolveOwnerName(h.db, edge, 'k', 'Hadoku', T0);
		const late = T0 + OWNER_NAME_TTL_MS - OWNER_NAME_REFRESH_AHEAD_MS;
		const { deferred, defer } = collectingDefer();

		const r = await resolveOwnerName(h.db, edge, 'k', 'Hadoku', late, defer);
		assert.ok(!isIdentityError(r) && r.userId === 'user-hadoku');
		assert.equal(deferred.length, 1, 'the refresh was handed to waitUntil');
		assert.equal(deferred[0].label, 'owner name refresh');

		await deferred[0].work;
		assert.equal(calls.length, 2);
		assert.equal(
			await expiresAt(),
			late + OWNER_NAME_TTL_MS,
			'the row now runs a full TTL from the refresh'
		);
	});

	it('keeps a runner that asks every five minutes off the edge entirely', async () => {
		// After the first resolve, every edge call hangs until released. A tick
		// that waited on one would never return; a deferred refresh just sits
		// there until the test lets it through.
		const held: (() => void)[] = [];
		let first = true;
		const edge = {
			async fetch(): Promise<Response> {
				if (!first) await new Promise<void>((release) => held.push(release));
				first = false;
				return Response.json(HADOKU.body);
			},
		};
		const { deferred, defer } = collectingDefer();
		for (let tick = 0; tick < 12; tick++) {
			const r = await resolveOwnerName(h.db, edge, 'k', 'Hadoku', T0 + tick * 5 * 60_000, defer);
			assert.ok(!isIdentityError(r) && r.userId === 'user-hadoku', `tick ${tick}`);
			for (const release of held.splice(0)) release();
			await Promise.all(deferred.splice(0).map((d) => d.work));
		}
	});

	it('forgets the name when the refresh learns it is gone', async () => {
		const table: Record<string, { status: number; body: unknown }> = { hadoku: HADOKU };
		const { edge } = countingEdge(table);
		await resolveOwnerName(h.db, edge, 'k', 'Hadoku', T0);
		delete table.hadoku;
		const { deferred, defer } = collectingDefer();
		await resolveOwnerName(h.db, edge, 'k', 'Hadoku', T0 + OWNER_NAME_TTL_MS - 1, defer);
		await deferred[0].work;
		assert.equal(await expiresAt(), undefined);
	});

	it('still never answers from an expired row', async () => {
		const table: Record<string, { status: number; body: unknown }> = { hadoku: HADOKU };
		const { edge } = countingEdge(table);
		await resolveOwnerName(h.db, edge, 'k', 'Hadoku', T0);
		delete table.hadoku;
		const { deferred, defer } = collectingDefer();
		const r = await resolveOwnerName(h.db, edge, 'k', 'Hadoku', T0 + OWNER_NAME_TTL_MS, defer);
		assert.ok(isIdentityError(r) && r.status === 404);
		assert.equal(deferred.length, 0);
	});
});

describe('mayActOnBehalf: who may name an owner other than themselves', () => {
	const at = (userType: string) => ({ userType }) as unknown as HadokuAuthContext;
	const NAMED = 'svc-a, svc-b';

	it('admits admin whatever the list says', () => {
		assert.equal(mayActOnBehalf(at('admin'), 'anyone', undefined), true);
	});

	it('admits a service caller the list names, and no other', () => {
		assert.equal(mayActOnBehalf(at('service'), 'svc-b', NAMED), true);
		assert.equal(mayActOnBehalf(at('service'), 'svc-c', NAMED), false);
	});

	it('never admits below service, even when named', () => {
		assert.equal(mayActOnBehalf(at('friend'), 'svc-a', NAMED), false);
	});

	it('an unset or empty list is admin only', () => {
		assert.equal(mayActOnBehalf(at('service'), 'svc-a', undefined), false);
		assert.equal(mayActOnBehalf(at('service'), 'svc-a', ' , '), false);
	});

	it('matches the userId whole, never a prefix, and needs one', () => {
		assert.equal(mayActOnBehalf(at('service'), 'svc', NAMED), false);
		assert.equal(mayActOnBehalf(at('service'), null, NAMED), false);
	});
});
