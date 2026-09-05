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
		// Let the build this request scheduled finish before removing the job it
		// is ranking — otherwise the delete races the insert and trips the
		// foreign key. Production survives that race (the build fails, the marker
		// is not set, the feed falls back and the next request retries), but a
		// test should not be asserting through it.
		await h.settle();
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

/**
 * The ranking installs itself.
 *
 * It used to appear only when an operator remembered to POST
 * /ingest/rebuild-rank, so a profile created today silently used the slow path
 * forever. Building it on first VIEW instead of on creation is deliberate: a
 * Default profile is materialised for every identity that so much as calls GET
 * /profiles, and ranking those eagerly is what put 64,452 rows in the table for
 * two identities that had never used the app.
 *
 * The harness calls app.fetch with no executionCtx, so the background work runs
 * unattached — hence the poll. That is also the real fallback path: the request
 * that triggers a build is served live and must still be correct.
 */
describe('lazy rank building', () => {
	const waitForRanking = async (ms = 8000) => {
		const deadline = Date.now() + ms;
		while (Date.now() < deadline) {
			const row = await h.db
				.prepare('SELECT COUNT(*) AS n FROM job_profile_rank_state WHERE profile_id = ?')
				.bind(PROFILE)
				.first<{ n: number }>();
			if ((row?.n ?? 0) > 0) return true;
			await new Promise((r) => setTimeout(r, 50));
		}
		return false;
	};

	it('builds the ranking behind the first feed request that needs it', async () => {
		assert.equal(await usingFastPath(), false, 'starts with nothing stored');

		const first = await feed();
		assert.ok(first.jobs.length > 0, 'the request that triggers the build is still served');

		assert.ok(await waitForRanking(), 'a ranking appeared without anyone asking for one');

		// And it is the same feed, now off the fast path.
		const second = await feed();
		assert.equal(await usingFastPath(), true);
		assert.deepEqual(
			second.jobs.map((j) => j.id),
			first.jobs.map((j) => j.id)
		);
	});

	it('does not build for a profile nobody looks at', async () => {
		// Materialising a Default costs one row; ranking it costs one per job. So
		// merely having a profile must not be enough to earn a ranking.
		await seedProfile(h.db, {
			id: 'rank-unused',
			user_id: 'someone-who-never-visits',
			name: 'Default',
			keywords: ['platform'],
			track: 'either',
			levels: ['senior'],
			remote_pref: 'any',
		});
		await feed(); // exercise the OTHER profile's feed
		await new Promise((r) => setTimeout(r, 300));
		const row = await h.db
			.prepare('SELECT COUNT(*) AS n FROM job_profile_rank WHERE profile_id = ?')
			.bind('rank-unused')
			.first<{ n: number }>();
		assert.equal(row?.n, 0, 'an unopened profile has no rank rows');
		await h.db.prepare('DELETE FROM profiles WHERE id = ?').bind('rank-unused').run();
	});

	it('rebuilds after a profile edit, against the new criteria', async () => {
		await buildRank();
		const stored = async () =>
			(
				await h.db
					.prepare('SELECT criteria_hash FROM job_profile_rank_state WHERE profile_id = ?')
					.bind(PROFILE)
					.first<{ criteria_hash: string }>()
			)?.criteria_hash;
		const before = await stored();

		const { status } = await h.json(`${BASE}/profiles/${PROFILE}`, {
			method: 'PUT',
			...AUTH,
			body: JSON.stringify({
				name: 'Ranked',
				keywords: ['director', 'payments'],
				track: 'either',
				levels: ['senior', 'staff'],
				remote_pref: 'remote',
			}),
		});
		assert.equal(status, 200);

		const deadline = Date.now() + 8000;
		let after = before;
		while (Date.now() < deadline && after === before) {
			await new Promise((r) => setTimeout(r, 50));
			after = await stored();
		}
		assert.notEqual(after, before, 'the ranking was rebuilt against the saved criteria');
	});
});
