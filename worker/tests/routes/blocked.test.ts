/**
 * Blocked companies — the routes in routes/jobs/blocked.ts, and the filter
 * they drive in GET /jobs, on both the unscored and the score-on-read path.
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BASE, createHarness, type Harness } from '../helpers/harness.ts';
import { seedJob, seedJobState, seedProfile } from '../helpers/seed.ts';

const ALICE = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const BOB = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

interface Blocked {
	company: string;
	company_key: string;
}

let h: Harness;

before(async () => {
	h = await createHarness();
	await seedJob(h.db, { id: 'b-acme', company: 'Acme', title: 'Software Engineer' });
	// The corpus spells the same employer with stray whitespace and case.
	await seedJob(h.db, { id: 'b-acme-2', company: '  ACME ', title: 'Platform Engineer' });
	await seedJob(h.db, { id: 'b-globex', company: 'Globex', title: 'Software Engineer' });
	await seedProfile(h.db, { id: 'bp', user_id: ALICE, keywords: ['engineer'] });
});

beforeEach(async () => {
	await h.db.prepare('DELETE FROM blocked_companies').run();
	await h.db.prepare('DELETE FROM job_states').run();
});

after(async () => {
	await h.dispose();
});

function call<T>(path: string, method = 'GET', body?: unknown, userId = ALICE) {
	return h.json<T>(`${BASE}${path}`, {
		method,
		tier: 'friend',
		userId,
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
}

const block = (company: string, userId = ALICE) =>
	call<{ data: { company: Blocked } }>('/blocked-companies', 'PUT', { company }, userId);
const list = (userId = ALICE) =>
	call<{ data: { companies: Blocked[] } }>('/blocked-companies', 'GET', undefined, userId);
const feedIds = async (qs = '', userId = ALICE) =>
	(
		await call<{ data: { jobs: { id: string }[] } }>(`/jobs${qs}`, 'GET', undefined, userId)
	).body.data.jobs
		.map((j) => j.id)
		.sort();

describe('routes', () => {
	it('403s an unauthenticated caller', async () => {
		const res = await h.fetch(`${BASE}/blocked-companies`);
		assert.equal(res.status, 403);
	});

	it('blocks idempotently, keyed case- and space-insensitively, keeping the first spelling', async () => {
		assert.equal((await block('Acme')).status, 200);
		const again = await block('  ACME ');
		assert.equal(again.status, 200);
		assert.deepEqual(
			{ company: again.body.data.company.company, key: again.body.data.company.company_key },
			{ company: 'Acme', key: 'acme' }
		);
		assert.equal((await list()).body.data.companies.length, 1);
	});

	it('400s a blank company', async () => {
		assert.equal((await block('   ')).status, 400);
	});

	it('unblocks by any spelling, and says when nothing was blocked', async () => {
		await block('Acme');
		const gone = await call<{ data: { deleted: boolean } }>(
			'/blocked-companies?company=aCmE',
			'DELETE'
		);
		assert.equal(gone.body.data.deleted, true);
		const none = await call<{ data: { deleted: boolean } }>(
			'/blocked-companies?company=Acme',
			'DELETE'
		);
		assert.equal(none.body.data.deleted, false);
	});

	it('is per person', async () => {
		await block('Acme');
		assert.equal((await list(BOB)).body.data.companies.length, 0);
	});
});

describe('GET /jobs', () => {
	it("hides every spelling of a blocked employer from the caller's unscored feed", async () => {
		await block('acme');
		assert.deepEqual(await feedIds(), ['b-globex']);
	});

	it('hides it on the score-on-read path too', async () => {
		await block('Acme');
		assert.deepEqual(await feedIds('?profile_id=bp'), ['b-globex']);
	});

	it("leaves everyone else's feed alone", async () => {
		await block('Acme');
		assert.deepEqual(await feedIds('', BOB), ['b-acme', 'b-acme-2', 'b-globex']);
	});

	it('still finds a posting the person saved, when they ask for that state', async () => {
		await seedJobState(h.db, { job_id: 'b-acme', user_id: ALICE, state: 'saved' });
		await block('Acme');
		assert.deepEqual(await feedIds('?state=saved'), ['b-acme']);
	});

	it('changes nothing for an anonymous visitor', async () => {
		await block('Acme');
		const res = await h.json<{ data: { jobs: { id: string }[] } }>(`${BASE}/jobs`);
		assert.equal(res.body.data.jobs.length, 3);
	});
});
