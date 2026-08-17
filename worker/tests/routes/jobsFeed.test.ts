/**
 * GET /jobs — the feed.
 *
 * Two code paths hide behind one route: the SQL-paginated "unscored" path when
 * no profile_id is given, and the score-on-read path when one is. They differ
 * in how they filter, sort and count, so both are exercised here against real
 * rows in real D1.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BASE, createHarness, type Harness } from '../helpers/harness.ts';
import { seedJob, seedProfile, seedProfileCompany, seedJobState } from '../helpers/seed.ts';

interface FeedBody {
	success: boolean;
	data: {
		jobs: Array<{
			id: string;
			title: string;
			score: number;
			state: string | null;
			salary_max: number | null;
			role_track: string;
			role_level: string | null;
			score_breakdown: Record<string, number>;
		}>;
		total: number;
		page: number;
		limit: number;
		has_more: boolean;
	};
}

let h: Harness;

before(async () => {
	h = await createHarness();

	// Three companies' worth of postings, deliberately varied on every axis the
	// feed filters or sorts by: track, level, salary, workplace type, recency.
	await seedJob(h.db, {
		id: 'g-1',
		title: 'Senior Software Engineer',
		company: 'Acme',
		ats: 'greenhouse',
		slug: 'acme',
		role_track: 'ic',
		role_level: 'senior',
		salary_max: 200000,
		salary_min: 150000,
		workplace_type: 'remote',
		description: 'Build distributed systems with Go and Kubernetes.',
		scraped_at: '2026-08-05T00:00:00.000Z',
	});
	await seedJob(h.db, {
		id: 'g-2',
		title: 'Staff Software Engineer',
		company: 'Acme',
		ats: 'greenhouse',
		slug: 'acme',
		role_track: 'ic',
		role_level: 'staff',
		salary_max: 260000,
		workplace_type: 'hybrid',
		description: 'Own the platform. Go, Kubernetes, terraform.',
		scraped_at: '2026-08-04T00:00:00.000Z',
	});
	await seedJob(h.db, {
		id: 'l-1',
		title: 'Engineering Manager',
		company: 'Globex',
		ats: 'lever',
		slug: 'globex',
		role_track: 'manager',
		role_level: 'manager',
		salary_max: null,
		workplace_type: 'onsite',
		description: 'Lead a team of engineers.',
		scraped_at: '2026-08-03T00:00:00.000Z',
	});
	await seedJob(h.db, {
		id: 'a-1',
		title: 'Product Manager',
		company: 'Initech',
		ats: 'ashby',
		slug: 'initech',
		role_track: 'ic',
		role_level: 'mid',
		salary_max: 180000,
		workplace_type: 'remote',
		description: 'Own the roadmap.',
		scraped_at: '2026-08-02T00:00:00.000Z',
	});

	await seedProfile(h.db, {
		id: 'p-ic',
		name: 'IC roles',
		keywords: ['Go', 'Kubernetes'],
		track: 'ic',
		levels: ['senior', 'staff'],
		remote_pref: 'any',
	});
	await seedProfile(h.db, {
		id: 'p-mgr',
		name: 'Manager roles',
		keywords: [],
		track: 'manager',
		levels: [],
	});
	// A profile whose slice is exactly one company — the INNER JOIN path.
	await seedProfile(h.db, { id: 'p-scoped', name: 'Acme only', keywords: [], track: 'either' });
	await seedProfileCompany(h.db, {
		id: 'pc-1',
		profile_id: 'p-scoped',
		ats: 'greenhouse',
		slug: 'acme',
	});
});

after(async () => {
	await h.dispose();
});

describe('GET /jobs — unscored path', () => {
	it('lists the whole corpus newest-first with neutral scores', async () => {
		const { status, body } = await h.json<FeedBody>(`${BASE}/jobs`);
		assert.equal(status, 200);
		assert.equal(body.success, true);
		assert.equal(body.data.total, 4);
		assert.deepEqual(
			body.data.jobs.map((j) => j.id),
			['g-1', 'g-2', 'l-1', 'a-1']
		);
		assert.equal(body.data.jobs[0].score, 0);
		assert.equal(body.data.has_more, false);
	});

	it('reports state as null when unauthenticated', async () => {
		const { body } = await h.json<FeedBody>(`${BASE}/jobs`);
		assert.ok(body.data.jobs.every((j) => j.state === null));
	});

	it('paginates in SQL and reports has_more', async () => {
		const { body } = await h.json<FeedBody>(`${BASE}/jobs?limit=2&page=1`);
		assert.equal(body.data.total, 4);
		assert.equal(body.data.jobs.length, 2);
		assert.equal(body.data.has_more, true);

		const page2 = await h.json<FeedBody>(`${BASE}/jobs?limit=2&page=2`);
		assert.deepEqual(
			page2.body.data.jobs.map((j) => j.id),
			['l-1', 'a-1']
		);
		assert.equal(page2.body.data.has_more, false);
	});

	it('sorts by salary with unlisted salaries last, not first', async () => {
		const { body } = await h.json<FeedBody>(`${BASE}/jobs?sort=salary`);
		assert.deepEqual(
			body.data.jobs.map((j) => j.id),
			['g-2', 'g-1', 'a-1', 'l-1']
		);
		// The posting with no stated salary sorts to the bottom.
		assert.equal(body.data.jobs[3].salary_max, null);
	});

	it('keeps jobs with no listed salary when min_salary is applied', async () => {
		const { body } = await h.json<FeedBody>(`${BASE}/jobs?min_salary=190000`);
		const ids = body.data.jobs.map((j) => j.id).sort();
		// g-1 (200k) and g-2 (260k) clear the bar; l-1 has no salary and survives;
		// a-1 (180k) is filtered out.
		assert.deepEqual(ids, ['g-1', 'g-2', 'l-1']);
	});
});

describe('GET /jobs — auth-dependent filters', () => {
	it('401s on state= without auth', async () => {
		const { status, body } = await h.json<{ success: boolean; error: string }>(
			`${BASE}/jobs?state=saved`
		);
		assert.equal(status, 401);
		assert.equal(body.success, false);
		assert.equal(body.error, 'Unauthorized');
	});

	it('treats hide_dismissed as a no-op when unauthed rather than erroring', async () => {
		const { status, body } = await h.json<FeedBody>(`${BASE}/jobs?hide_dismissed=true`);
		assert.equal(status, 200);
		assert.equal(body.data.total, 4);
	});

	it('degrades to public when the edge secret does not verify', async () => {
		const res = await h.fetch(`${BASE}/jobs?state=saved`, {
			headers: { 'X-Edge-Auth': 'wrong-secret', 'X-Hadoku-Tier': 'friend' },
		});
		assert.equal(res.status, 401);
	});

	it('surfaces per-user state and filters by it when authed', async () => {
		await seedJobState(h.db, { job_id: 'g-1', user_id: 'state-reader', state: 'saved' });
		await seedJobState(h.db, { job_id: 'l-1', user_id: 'state-reader', state: 'dismissed' });

		const all = await h.json<FeedBody>(`${BASE}/jobs`, {
			tier: 'friend',
			userId: 'state-reader',
		});
		const byId = Object.fromEntries(all.body.data.jobs.map((j) => [j.id, j.state]));
		assert.equal(byId['g-1'], 'saved');
		assert.equal(byId['l-1'], 'dismissed');
		assert.equal(byId['g-2'], 'new', 'no row means implicit "new"');

		const saved = await h.json<FeedBody>(`${BASE}/jobs?state=saved`, {
			tier: 'friend',
			userId: 'state-reader',
		});
		assert.deepEqual(
			saved.body.data.jobs.map((j) => j.id),
			['g-1']
		);
	});

	it('state=new matches the jobs with no state row', async () => {
		const { body } = await h.json<FeedBody>(`${BASE}/jobs?state=new`, {
			tier: 'friend',
			userId: 'state-reader',
		});
		assert.deepEqual(body.data.jobs.map((j) => j.id).sort(), ['a-1', 'g-2']);
	});

	it('hide_dismissed drops only the caller-dismissed rows', async () => {
		const { body } = await h.json<FeedBody>(`${BASE}/jobs?hide_dismissed=true`, {
			tier: 'friend',
			userId: 'state-reader',
		});
		assert.equal(body.data.total, 3);
		assert.ok(!body.data.jobs.some((j) => j.id === 'l-1'));
	});

	it("does not leak one user's state to another", async () => {
		const { body } = await h.json<FeedBody>(`${BASE}/jobs`, {
			tier: 'friend',
			userId: 'someone-else',
		});
		assert.ok(body.data.jobs.every((j) => j.state === 'new'));
	});
});

describe('GET /jobs — score-on-read path', () => {
	it('applies track as a hard filter, not a score penalty', async () => {
		const ic = await h.json<FeedBody>(`${BASE}/jobs?profile_id=p-ic`);
		assert.ok(
			ic.body.data.jobs.every((j) => j.role_track === 'ic'),
			'an ic profile must not return manager rows at all'
		);
		assert.ok(!ic.body.data.jobs.some((j) => j.id === 'l-1'));

		const mgr = await h.json<FeedBody>(`${BASE}/jobs?profile_id=p-mgr`);
		assert.deepEqual(
			mgr.body.data.jobs.map((j) => j.id),
			['l-1']
		);
	});

	it('scores against the profile and sorts highest first', async () => {
		const { body } = await h.json<FeedBody>(`${BASE}/jobs?profile_id=p-ic`);
		assert.ok(body.data.jobs.length >= 2);
		const scores = body.data.jobs.map((j) => j.score);
		assert.deepEqual(
			scores,
			[...scores].sort((a, b) => b - a),
			'not sorted by score desc'
		);
		assert.ok(scores[0] > 0, 'a keyword-matching posting should score above zero');
	});

	it('penalises an adjacent-discipline title instead of hiding it', async () => {
		const { body } = await h.json<FeedBody>(`${BASE}/jobs?profile_id=p-ic`);
		const pm = body.data.jobs.find((j) => j.id === 'a-1');
		assert.ok(pm, 'the Product Manager posting is still on the ic track and must appear');
		const eng = body.data.jobs.find((j) => j.id === 'g-1');
		assert.ok(eng && eng.score > pm.score);
	});

	it('scopes the feed to the profile companies when it has any', async () => {
		const { body } = await h.json<FeedBody>(`${BASE}/jobs?profile_id=p-scoped`);
		assert.deepEqual(
			body.data.jobs.map((j) => j.id).sort(),
			['g-1', 'g-2'],
			'only the Acme (greenhouse/acme) postings are in this slice'
		);
	});

	it('treats an unknown profile_id as no constraints rather than 500', async () => {
		const { status, body } = await h.json<FeedBody>(`${BASE}/jobs?profile_id=does-not-exist`);
		assert.equal(status, 200);
		assert.equal(body.data.total, 4);
	});

	it('drops rows below min_score', async () => {
		const unfiltered = await h.json<FeedBody>(`${BASE}/jobs?profile_id=p-ic`);
		const cutoff = unfiltered.body.data.jobs[0].score;
		const { body } = await h.json<FeedBody>(`${BASE}/jobs?profile_id=p-ic&min_score=${cutoff}`);
		assert.ok(body.data.jobs.every((j) => j.score >= cutoff));
		assert.ok(body.data.total < unfiltered.body.data.total);
	});

	it('paginates the scored set in memory and reports the pre-page total', async () => {
		const { body } = await h.json<FeedBody>(`${BASE}/jobs?profile_id=p-ic&limit=1&page=1`);
		assert.equal(body.data.jobs.length, 1);
		assert.equal(body.data.total, 3);
		assert.equal(body.data.has_more, true);
	});

	it('sorts the scored set by date and by salary on request', async () => {
		const byDate = await h.json<FeedBody>(`${BASE}/jobs?profile_id=p-ic&sort=date`);
		assert.deepEqual(
			byDate.body.data.jobs.map((j) => j.id),
			['g-1', 'g-2', 'a-1']
		);
		const bySalary = await h.json<FeedBody>(`${BASE}/jobs?profile_id=p-ic&sort=salary`);
		assert.deepEqual(
			bySalary.body.data.jobs.map((j) => j.id),
			['g-2', 'g-1', 'a-1']
		);
	});

	it('combines a profile with per-user state', async () => {
		const { body } = await h.json<FeedBody>(`${BASE}/jobs?profile_id=p-ic&state=saved`, {
			tier: 'friend',
			userId: 'state-reader',
		});
		assert.deepEqual(
			body.data.jobs.map((j) => j.id),
			['g-1']
		);
	});
});

describe('GET /jobs — request validation', () => {
	it('rejects a limit above the cap', async () => {
		const res = await h.fetch(`${BASE}/jobs?limit=101`);
		assert.equal(res.status, 400);
	});

	it('rejects an unknown sort', async () => {
		const res = await h.fetch(`${BASE}/jobs?sort=sideways`);
		assert.equal(res.status, 400);
	});

	it('rejects an unknown state', async () => {
		const res = await h.fetch(`${BASE}/jobs?state=procrastinating`);
		assert.equal(res.status, 400);
	});
});

describe('GET /jobs — two-stage scoring', () => {
	it('description-only keyword matches still reach the feed fully scored', async () => {
		// 'kubernetes' appears ONLY in descriptions (g-1, g-2), never in titles.
		// If stage 2 failed to fetch descriptions, keyword_match would be 0 for
		// everything and these jobs could not outrank non-matching ones.
		await seedProfile(h.db, {
			id: 'p-desc',
			name: 'Desc keywords',
			keywords: ['kubernetes'],
			track: 'either',
		});
		const { status, body } = await h.json<FeedBody>(`${BASE}/jobs?profile_id=p-desc&sort=score`);
		assert.equal(status, 200);
		const byId = Object.fromEntries(body.data.jobs.map((j) => [j.id, j]));
		assert.ok(byId['g-1'], 'g-1 present');
		assert.equal(byId['g-1'].score_breakdown.keyword_match, 1, 'description keyword scored');
		assert.ok(byId['g-1'].score > byId['a-1'].score, 'desc-matching job outranks non-matching');
	});
});
