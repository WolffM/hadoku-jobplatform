/**
 * Profile view defaults (migration 0034): location, radius_miles, min_salary,
 * include_undisclosed_salary, us_only. Round-tripped by /profiles, and —
 * the point — outside the scoring criteria: editing one neither changes the
 * criteria hash nor rebuilds the precomputed ranking.
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BASE, createHarness, type Harness } from '../helpers/harness.ts';
import { seedJob } from '../helpers/seed.ts';

const ALICE = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const as = { tier: 'friend' as const, userId: ALICE };

interface Profile {
	id: string;
	name: string;
	keywords: string[];
	location: string | null;
	radius_miles: number;
	min_salary: number | null;
	include_undisclosed_salary: boolean;
	us_only: boolean;
}

let h: Harness;

before(async () => {
	h = await createHarness();
	for (let i = 0; i < 5; i++) await seedJob(h.db, { id: `j${i}`, title: 'Software Engineer' });
});

beforeEach(async () => {
	for (const t of [
		'job_profile_rank',
		'job_profile_rank_state',
		'profile_companies',
		'profiles',
		'profile_tombstones',
	])
		await h.db.prepare(`DELETE FROM ${t}`).run();
});

after(async () => {
	await h.dispose();
});

const create = (body: unknown) =>
	h.json<{ data: { profile: Profile } }>(`${BASE}/profiles`, {
		method: 'POST',
		...as,
		body: JSON.stringify(body),
	});
const update = (id: string, body: unknown) =>
	h.json<{ data: { profile: Profile } }>(`${BASE}/profiles/${id}`, {
		method: 'PUT',
		...as,
		body: JSON.stringify(body),
	});
const listed = async (id: string) =>
	(await h.json<{ data: { profiles: Profile[] } }>(`${BASE}/profiles`, as)).body.data.profiles.find(
		(p) => p.id === id
	)!;
const rankState = (id: string) =>
	h.db
		.prepare('SELECT criteria_hash, built_at FROM job_profile_rank_state WHERE profile_id = ?')
		.bind(id)
		.first<{ criteria_hash: string; built_at: string }>();
const settle = () => new Promise((r) => setTimeout(r, 300));

describe('profile view defaults', () => {
	it('defaults when omitted and round-trips when given', async () => {
		const plain = (await create({ name: 'Plain' })).body.data.profile;
		assert.deepEqual(
			[
				plain.location,
				plain.radius_miles,
				plain.min_salary,
				plain.include_undisclosed_salary,
				plain.us_only,
			],
			[null, 25, null, true, false]
		);
		const given = (
			await create({
				name: 'Seattle',
				location: 'Seattle, WA',
				radius_miles: 40,
				min_salary: 150000,
				include_undisclosed_salary: false,
				us_only: true,
			})
		).body.data.profile;
		const back = await listed(given.id);
		assert.deepEqual(
			[
				back.location,
				back.radius_miles,
				back.min_salary,
				back.include_undisclosed_salary,
				back.us_only,
			],
			['Seattle, WA', 40, 150000, false, true]
		);
	});

	it('PUT changes only what it names, and null clears location and min_salary', async () => {
		const p = (
			await create({ name: 'P', location: 'Austin, TX', min_salary: 120000, radius_miles: 10 })
		).body.data.profile;
		await update(p.id, { radius_miles: 60 });
		let back = await listed(p.id);
		assert.deepEqual(
			[back.location, back.radius_miles, back.min_salary],
			['Austin, TX', 60, 120000]
		);
		await update(p.id, { location: null, min_salary: null });
		back = await listed(p.id);
		assert.deepEqual([back.location, back.radius_miles, back.min_salary], [null, 60, null]);
	});

	it('editing a view default leaves the ranking alone; editing a criterion rebuilds it', async () => {
		const p = (await create({ name: 'Ranked', keywords: ['engineer'] })).body.data.profile;
		assert.equal(
			(
				await h.fetch(`${BASE}/ingest/rebuild-rank?profile_id=${p.id}`, {
					method: 'POST',
					tier: 'friend',
				})
			).status,
			200
		);
		const built = await rankState(p.id);
		assert.ok(built);

		await update(p.id, { location: 'Seattle, WA', radius_miles: 80, min_salary: 1, us_only: true });
		await settle();
		assert.deepEqual(await rankState(p.id), built, 'no rebuild, same hash');

		await update(p.id, { keywords: ['manager'] });
		await settle();
		const after = await rankState(p.id);
		assert.notEqual(after?.criteria_hash, built.criteria_hash);
	});

	it('PUT keeps the scoring criteria it does not name', async () => {
		const p = (
			await create({
				name: 'Keep',
				keywords: ['rust'],
				track: 'ic',
				levels: ['senior'],
				remote_pref: 'remote',
			})
		).body.data.profile;
		await update(p.id, { name: 'Renamed' });
		const back = (await listed(p.id)) as Profile & {
			track: string;
			levels: string[];
			remote_pref: string;
		};
		assert.deepEqual(
			[back.name, back.keywords, back.track, back.levels, back.remote_pref],
			['Renamed', ['rust'], 'ic', ['senior'], 'remote']
		);
	});

	it('400s an out-of-range radius', async () => {
		assert.equal((await create({ name: 'Bad', radius_miles: 0 })).status, 400);
		assert.equal((await create({ name: 'Bad', radius_miles: 501 })).status, 400);
	});
});
