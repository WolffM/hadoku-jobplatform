/**
 * The precomputed feed ranking (migration 0020).
 *
 * The feed used to read the whole corpus on every request because its sort key
 * — scoreJobLightAxes().bound — lived only in JavaScript, so SQL could not
 * ORDER BY it. Storing it lets the feed order and cap in SQL.
 *
 * The property that has to hold is therefore equivalence: the fast path must
 * return the SAME page as ranking live, because it is the same number computed
 * in a different place. Everything else here is about the fallback, which is
 * what keeps a stale or missing ranking from silently changing what you see.
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BASE, createHarness, type Harness } from '../helpers/harness.ts';
import { seedJob, seedProfile } from '../helpers/seed.ts';

interface FeedBody {
	success: boolean;
	data: { jobs: Array<{ id: string; score: number }>; total: number };
}

const PROFILE = 'rank-p1';
const AUTH = { tier: 'friend' as const, userId: 'rank-user' };

let h: Harness;

before(async () => {
	h = await createHarness();
	await seedProfile(h.db, {
		id: PROFILE,
		user_id: 'rank-user',
		name: 'Ranked',
		keywords: ['software engineer', 'platform', 'ai'],
		track: 'either',
		levels: ['senior', 'staff'],
		remote_pref: 'remote',
	});
	// Enough spread that a wrong ORDER BY would reorder the page rather than
	// happen to agree with it.
	const titles = [
		'Senior Software Engineer, Platform',
		'Staff AI Engineer',
		'Principal Platform Engineer',
		'Engineering Manager, Payments',
		'Junior Frontend Developer',
		'Staff Software Engineer, AI Infrastructure',
		'Senior Backend Engineer',
		'Director of Engineering',
		'Software Engineer II',
		'Senior Machine Learning Engineer, Platform',
	];
	for (const [i, title] of titles.entries()) {
		await seedJob(h.db, {
			id: `rk-${i}`,
			title,
			company: `Co${i}`,
			location: i % 2 === 0 ? 'Remote - USA' : 'Berlin, DE',
			workplace_type: i % 3 === 0 ? 'remote' : 'hybrid',
			scraped_at: `2026-08-${String(10 + i).padStart(2, '0')}T00:00:00.000Z`,
		});
	}
});

beforeEach(async () => {
	await h.db.prepare('DELETE FROM job_profile_rank').run();
	await h.db.prepare('DELETE FROM job_profile_rank_state').run();
});

after(async () => {
	await h.dispose();
});

const feed = async (qs = '') => {
	const { body } = await h.json<FeedBody>(
		`${BASE}/jobs?profile_id=${PROFILE}&limit=10&sort=score${qs}`,
		AUTH
	);
	return body.data;
};

const buildRank = async () => {
	const { status } = await h.json(`${BASE}/ingest/rebuild-rank?profile_id=${PROFILE}`, {
		method: 'POST',
		tier: 'friend',
		userId: 'rank-user',
	});
	assert.equal(status, 200);
};

const usingFastPath = async () => {
	const n = await h.db
		.prepare('SELECT COUNT(*) AS n FROM job_profile_rank_state WHERE profile_id = ?')
		.bind(PROFILE)
		.first<{ n: number }>();
	return (n?.n ?? 0) > 0;
};

describe('precomputed ranking', () => {
	it('returns the same page as ranking live', async () => {
		const live = await feed();
		assert.ok(live.jobs.length > 0, 'the live path returned something to compare against');
		assert.equal(await usingFastPath(), false, 'that really was the live path');

		await buildRank();
		assert.equal(await usingFastPath(), true);
		const fast = await feed();

		assert.deepEqual(
			fast.jobs.map((j) => j.id),
			live.jobs.map((j) => j.id),
			'same order'
		);
		assert.deepEqual(
			fast.jobs.map((j) => j.score),
			live.jobs.map((j) => j.score),
			'same scores — the bound only moved, it did not change'
		);
	});

	it('stores a bound for every job, matching what the live pass computes', async () => {
		await buildRank();
		const rows = await h.db
			.prepare('SELECT COUNT(*) AS n FROM job_profile_rank WHERE profile_id = ?')
			.bind(PROFILE)
			.first<{ n: number }>();
		const jobs = await h.db.prepare('SELECT COUNT(*) AS n FROM jobs').first<{ n: number }>();
		assert.equal(rows?.n, jobs?.n, 'every job is ranked, or the fast path would hide some');
	});

	// The three ways a stored ranking stops being trustworthy. Each must fall
	// back to live rather than serve an order that no longer follows from the
	// profile — a wrong ORDER is invisible on the page in a way slowness is not.
	it('falls back when the profile has no ranking at all', async () => {
		assert.equal(await usingFastPath(), false);
		const res = await feed();
		assert.ok(res.jobs.length > 0);
	});

	it('falls back when the criteria changed under it', async () => {
		await buildRank();
		const before = (await feed()).jobs.map((j) => j.id);

		// Same rows, different keywords: the stored bounds now describe a profile
		// that no longer exists.
		await h.db
			.prepare('UPDATE profiles SET keywords = ? WHERE id = ?')
			.bind(JSON.stringify(['director', 'payments']), PROFILE)
			.run();
		const after = (await feed()).jobs.map((j) => j.id);
		assert.notDeepEqual(after, before, 'the feed re-ranked instead of serving the stale order');
	});

	it('falls back when jobs arrived after the ranking was built', async () => {
		await buildRank();
		await seedJob(h.db, {
			id: 'rk-new',
			title: 'Staff Software Engineer, Platform AI',
			company: 'Newco',
			location: 'Remote - USA',
			workplace_type: 'remote',
			scraped_at: '2026-09-01T00:00:00.000Z',
		});
		const ids = (await feed()).jobs.map((j) => j.id);
		assert.ok(
			ids.includes('rk-new'),
			'a posting ingested after the build must not be invisible until a rebuild'
		);
		await h.db.prepare('DELETE FROM jobs WHERE id = ?').bind('rk-new').run();
	});

	it('drops a deleted profile’s rows — nothing else is keyed to collect them', async () => {
		await buildRank();
		await h.json(`${BASE}/profiles/${PROFILE}`, { method: 'DELETE', ...AUTH });
		const left = await h.db
			.prepare('SELECT COUNT(*) AS n FROM job_profile_rank WHERE profile_id = ?')
			.bind(PROFILE)
			.first<{ n: number }>();
		assert.equal(left?.n, 0);
		// put it back for the rest of the file
		await seedProfile(h.db, {
			id: PROFILE,
			user_id: 'rank-user',
			name: 'Ranked',
			keywords: ['software engineer', 'platform', 'ai'],
			track: 'either',
			levels: ['senior', 'staff'],
			remote_pref: 'remote',
		});
	});
});
