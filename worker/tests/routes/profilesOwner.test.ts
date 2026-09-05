/**
 * Acting as a named owner on the profile routes.
 *
 * Needed because the directives that decide WHAT GETS SCRAPED are built from
 * profile_companies, and four of them held a hostname guess
 * ('pinterestcareers' for the board 'pinterest'). Repointing them means writing
 * to the owner's rows from a service caller.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, type Harness } from '../helpers/harness.ts';

const BASE = '/jobplatform/api';
const HADOKU = 'user-hadoku';
const SERVICE = 'the-service';

let h: Harness;

before(async () => {
	h = await createHarness();
});
after(async () => {
	await h.dispose();
});
beforeEach(async () => {
	await h.db.prepare('DELETE FROM profile_companies').run();
	await h.db.prepare('DELETE FROM profiles').run();
	await h.db.prepare('DELETE FROM profile_tombstones').run();
});

function get<T>(path: string, tier = 'service', userId = SERVICE) {
	return h.json<T & { message: string; code?: string }>(`${BASE}${path}`, {
		method: 'GET',
		tier,
		userId,
	});
}

async function seedOwnerProfile(): Promise<string> {
	const id = 'prof-hadoku';
	const now = new Date().toISOString();
	await h.db
		.prepare(
			`INSERT INTO profiles (id, user_id, name, keywords, target_companies, track, levels, remote_pref, created_at)
			 VALUES (?, ?, 'Owner', '[]', '[]', 'ic', '[]', 'any', ?)`
		)
		.bind(id, HADOKU, now)
		.run();
	await h.db
		.prepare(
			`INSERT INTO profile_companies (id, profile_id, ats, slug, display_name, added_at)
			 VALUES ('pc1', ?, 'greenhouse', 'pinterestcareers', 'Pinterest', ?)`
		)
		.bind(id, now)
		.run();
	return id;
}

describe('profiles ?owner', () => {
	it("lists the owner's profiles, not the caller's", async () => {
		await seedOwnerProfile();
		const mine = await get<{ data: { profiles: { id: string }[] } }>('/profiles');
		assert.ok(
			!mine.body.data.profiles.some((p) => p.id === 'prof-haduku'),
			'the service sees its own'
		);

		const theirs = await get<{ data: { profiles: { id: string }[] } }>('/profiles?owner=Hadoku');
		assert.ok(theirs.body.data.profiles.some((p) => p.id === 'prof-hadoku'));
	});

	it("reaches the owner's companies — the rows the directives are built from", async () => {
		const pid = await seedOwnerProfile();
		const { body } = await get<{ data: { companies: { slug: string }[] } }>(
			`/profiles/${pid}/companies?owner=Hadoku`
		);
		assert.deepEqual(
			body.data.companies.map((c) => c.slug),
			['pinterestcareers']
		);
	});

	it('refuses a friend-tier caller naming someone else', async () => {
		// The gate. Otherwise any signed-in human could edit another person's
		// scoring profiles and, through the directives, what the fleet scrapes.
		await seedOwnerProfile();
		const { status, body } = await get('/profiles?owner=Hadoku', 'friend', 'some-human');
		assert.equal(status, 403);
		assert.match(body.message, /service or admin/i);
	});

	it('an unknown owner is 404, never a silent fallback to the caller', async () => {
		const { status, body } = await get('/profiles?owner=Nobody');
		assert.equal(status, 404);
		assert.equal(body.code, 'NAME_NOT_FOUND');
	});

	it('still serves a caller their own profiles with no owner named', async () => {
		const { status } = await get('/profiles');
		assert.equal(status, 200);
	});
});
