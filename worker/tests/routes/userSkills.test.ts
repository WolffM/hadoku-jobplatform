/**
 * GET/POST/DELETE /skills and GET /jobs/:id/match.
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BASE, createHarness, type Harness } from '../helpers/harness.ts';
import { seedJob, seedProfile } from '../helpers/seed.ts';

const ALICE = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const BOB = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

interface Skill {
	id: number;
	name: string;
	category: string | null;
	proficiency: string;
}
interface Match {
	matched: string[];
	missing: string[];
	detected: string[];
	score: number;
	summary: string;
	against: string;
}

let h: Harness;

before(async () => {
	h = await createHarness();
	await seedJob(h.db, {
		id: 'k8s',
		title: 'Platform Engineer',
		description: '<p>We run Kubernetes on AWS and write Golang and Python.</p>',
	});
	await seedJob(h.db, {
		id: 'plain',
		title: 'Office Manager',
		description: 'Keep the office running.',
	});
});

beforeEach(async () => {
	await h.db.prepare('DELETE FROM user_skills').run();
	await h.db.prepare('DELETE FROM profiles').run();
});

after(async () => {
	await h.dispose();
});

const as = (userId: string) => ({ tier: 'friend' as const, userId });
const add = (userId: string, body: unknown) =>
	h.json<{ data: { skill: Skill }; message?: string }>(`${BASE}/skills`, {
		method: 'POST',
		...as(userId),
		body: JSON.stringify(body),
	});
const list = async (userId: string) =>
	(await h.json<{ data: { skills: Skill[] } }>(`${BASE}/skills`, as(userId))).body.data.skills;
const match = (userId: string, id = 'k8s') =>
	h.json<{ data: Match }>(`${BASE}/jobs/${id}/match`, as(userId));

describe('/skills', () => {
	it('adds, lists by name, and keeps each person to their own', async () => {
		const res = await add(ALICE, { name: 'Python', category: 'Languages', proficiency: 'expert' });
		assert.equal(res.status, 201);
		assert.deepEqual(
			{
				name: res.body.data.skill.name,
				category: res.body.data.skill.category,
				proficiency: res.body.data.skill.proficiency,
			},
			{ name: 'Python', category: 'Languages', proficiency: 'expert' }
		);
		assert.equal(typeof res.body.data.skill.id, 'number');
		await add(ALICE, { name: 'aws' });
		assert.deepEqual(
			(await list(ALICE)).map((s) => [s.name, s.proficiency]),
			[
				['aws', 'intermediate'],
				['Python', 'expert'],
			]
		);
		assert.deepEqual(await list(BOB), []);
	});

	it('409s a skill already listed under another spelling', async () => {
		await add(ALICE, { name: 'Kubernetes' });
		const again = await add(ALICE, { name: 'k8s' });
		assert.equal(again.status, 409);
		assert.match(again.body.message ?? '', /already/);
	});

	it('deletes only the caller’s own row', async () => {
		const id = (await add(ALICE, { name: 'Rust' })).body.data.skill.id;
		assert.equal(
			(await h.fetch(`${BASE}/skills/${id}`, { method: 'DELETE', ...as(BOB) })).status,
			404
		);
		assert.equal(
			(await h.fetch(`${BASE}/skills/${id}`, { method: 'DELETE', ...as(ALICE) })).status,
			200
		);
		assert.deepEqual(await list(ALICE), []);
	});

	it('400s a bad body and 403s an anonymous caller', async () => {
		assert.equal((await add(ALICE, { name: '' })).status, 400);
		assert.equal((await add(ALICE, { name: 'x', proficiency: 'guru' })).status, 400);
		assert.equal((await h.fetch(`${BASE}/skills`)).status, 403);
	});
});

describe('GET /jobs/:id/match', () => {
	it('splits the posting’s skills into matched and missing against the list', async () => {
		await add(ALICE, { name: 'k8s' });
		await add(ALICE, { name: 'Python' });
		const res = await match(ALICE);
		assert.equal(res.status, 200);
		assert.deepEqual(
			new Set(res.body.data.detected),
			new Set(['python', 'go', 'kubernetes', 'aws'])
		);
		assert.deepEqual(new Set(res.body.data.matched), new Set(['python', 'kubernetes']));
		assert.deepEqual(new Set(res.body.data.missing), new Set(['go', 'aws']));
		assert.equal(res.body.data.score, 50);
		assert.equal(res.body.data.against, 'skills');
		assert.match(res.body.data.summary, /2 of the 4/);
	});

	it('falls back to the caller’s profiles’ stack when the list is empty', async () => {
		await seedProfile(h.db, { id: 'p1', user_id: BOB, keywords: ['engineer'] });
		await h.db.prepare(`UPDATE profiles SET stack = '["golang","AWS"]' WHERE id = 'p1'`).run();
		const res = await match(BOB);
		assert.deepEqual(new Set(res.body.data.matched), new Set(['go', 'aws']));
		assert.equal(res.body.data.against, 'profile_stack');
	});

	it('says so when the caller has no skills anywhere, or the posting names none', async () => {
		const none = await match(BOB);
		assert.equal(none.body.data.against, 'none');
		assert.equal(none.body.data.score, 0);
		assert.deepEqual(none.body.data.matched, []);
		const plain = await match(ALICE, 'plain');
		assert.deepEqual(plain.body.data.detected, []);
		assert.match(plain.body.data.summary, /names none/);
	});

	it('404s an unknown posting', async () => {
		assert.equal((await match(ALICE, 'nope')).status, 404);
	});
});
