/**
 * GET /jobs q= / source= / track= — server-side search and the filters a
 * caller without a profile needs. Exercised on the plain path, the live
 * score-on-read path, and the precomputed (job_profile_rank) path, and in the
 * COUNT that pages them.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BASE, createHarness, type Harness } from '../helpers/harness.ts';
import { seedJob, seedProfile } from '../helpers/seed.ts';

const ALICE = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';

interface Feed {
	data: { jobs: { id: string }[]; total: number };
}

let h: Harness;

before(async () => {
	h = await createHarness();
	const rows = [
		{
			id: 'k8s',
			title: 'Platform Engineer, Kubernetes',
			company: 'Acme',
			location: 'Seattle, WA',
			ats: 'greenhouse',
			source_site: 'greenhouse.io',
			role_track: 'ic',
		},
		{
			id: 'data',
			title: 'Data Engineer',
			company: 'Globex',
			location: 'Remote - US',
			ats: 'ashby',
			source_site: 'ashbyhq.com',
			role_track: 'ic',
		},
		{
			id: 'mgr',
			title: 'Engineering Manager, Platform',
			company: 'Initech',
			location: 'Austin, TX',
			ats: 'lever',
			source_site: 'lever.co',
			role_track: 'manager',
		},
		{
			id: 'ro',
			title: 'Backend Developer',
			company: 'Platformly',
			location: 'Anywhere',
			ats: null,
			source_site: 'remoteok.com',
			role_track: 'ic',
		},
		{
			id: 'pct',
			title: 'Growth 100% Remote',
			company: 'Hooli',
			location: 'Remote',
			ats: 'greenhouse',
			source_site: 'greenhouse.io',
			role_track: 'ic',
		},
	];
	for (const [i, r] of rows.entries()) {
		await seedJob(h.db, {
			...r,
			slug: r.ats ? 'b' : null,
			url: `https://example.com/${r.id}`,
			scraped_at: `2026-08-0${i + 1}T00:00:00.000Z`,
		});
	}
	await seedProfile(h.db, { id: 'p1', user_id: ALICE, keywords: ['engineer'] });
});

after(async () => {
	await h.dispose();
});

const ids = async (qs: string, authed = false) => {
	const res = await h.json<Feed>(
		`${BASE}/jobs?${qs}`,
		authed ? { tier: 'friend', userId: ALICE } : {}
	);
	assert.equal(res.status, 200, JSON.stringify(res.body));
	return { ids: res.body.data.jobs.map((j) => j.id).sort(), total: res.body.data.total };
};

describe('GET /jobs q=', () => {
	it('matches title, company or location, case-insensitively', async () => {
		assert.deepEqual((await ids('q=platform')).ids, ['k8s', 'mgr', 'ro']); // title ×2, company
		assert.deepEqual((await ids('q=SEATTLE')).ids, ['k8s']);
		assert.deepEqual((await ids('q=globex')).ids, ['data']);
	});

	it('ANDs the words, each anywhere in the three fields', async () => {
		assert.deepEqual((await ids('q=platform%20seattle')).ids, ['k8s']);
		assert.deepEqual((await ids('q=platform%20nowhere')).ids, []);
	});

	it('pages and counts the matches, not the corpus', async () => {
		const r = await ids('q=engineer&limit=1');
		assert.equal(r.total, 3);
	});

	it('treats % and _ as plain characters', async () => {
		assert.deepEqual((await ids('q=100%25')).ids, ['pct']);
		assert.deepEqual((await ids('q=%25')).ids, ['pct']);
		assert.deepEqual((await ids('q=_')).ids, []);
	});

	it('applies on the live score-on-read path', async () => {
		assert.deepEqual((await ids('q=platform&profile_id=p1', true)).ids, ['k8s', 'mgr', 'ro']);
	});

	it('applies on the precomputed ranking', async () => {
		const built = await h.fetch(`${BASE}/ingest/rebuild-rank?profile_id=p1`, {
			method: 'POST',
			tier: 'friend',
		});
		assert.equal(built.status, 200);
		const n = await h.db
			.prepare('SELECT COUNT(*) AS n FROM job_profile_rank WHERE profile_id = ?')
			.bind('p1')
			.first<{ n: number }>();
		assert.equal(n?.n, 5);
		assert.deepEqual((await ids('q=platform%20seattle&profile_id=p1', true)).ids, ['k8s']);
	});

	it('400s a query over 100 characters', async () => {
		const res = await h.fetch(`${BASE}/jobs?q=${'a'.repeat(101)}`);
		assert.equal(res.status, 400);
	});
});

describe('GET /jobs source= and track=', () => {
	it('filters by ATS or by site', async () => {
		assert.deepEqual((await ids('source=greenhouse')).ids, ['k8s', 'pct']);
		assert.deepEqual((await ids('source=ashby')).ids, ['data']);
		assert.deepEqual((await ids('source=remoteok')).ids, ['ro']);
		assert.equal((await ids('source=greenhouse&limit=1')).total, 2);
	});

	it('filters by role track without a profile', async () => {
		assert.deepEqual((await ids('track=manager')).ids, ['mgr']);
		assert.deepEqual((await ids('track=ic&q=platform')).ids, ['k8s', 'ro']);
	});

	it('400s an unknown track', async () => {
		assert.equal((await h.fetch(`${BASE}/jobs?track=either`)).status, 400);
	});
});
