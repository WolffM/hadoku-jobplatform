import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, type Harness } from '../helpers/harness.ts';
import { seedJob, seedJobState } from '../helpers/seed.ts';

const BASE = '/jobplatform/api';
const AUTH = {
	headers: { 'X-Edge-Auth': 'test-edge-secret', 'X-Hadoku-Tier': 'friend', 'X-User-Id': 'u-cull' },
};

let h: Harness;

before(async () => {
	h = await createHarness();
	const old = '2026-05-01T00:00:00.000Z'; // ~110 days before "now"
	const fresh = new Date().toISOString();
	await seedJob(h.db, { id: 'cull-old', title: 'Old dead posting', scraped_at: old });
	await h.db
		.prepare('UPDATE jobs SET last_seen_at = ?, posted_date = NULL WHERE id = ?')
		.bind(old, 'cull-old')
		.run();
	await seedJob(h.db, { id: 'cull-protected', title: 'Old but owner-touched', scraped_at: old });
	await h.db
		.prepare('UPDATE jobs SET last_seen_at = ? WHERE id = ?')
		.bind(old, 'cull-protected')
		.run();
	await seedJobState(h.db, { job_id: 'cull-protected', user_id: 'u-cull', state: 'applied' });
	await seedJob(h.db, { id: 'cull-fresh', title: 'Fresh posting', scraped_at: fresh });
	await h.db
		.prepare('UPDATE jobs SET last_seen_at = ? WHERE id = ?')
		.bind(fresh, 'cull-fresh')
		.run();
	// still-listed board job: posted long ago but seen this week
	await seedJob(h.db, { id: 'cull-alive', title: 'Old post still listed', scraped_at: old });
	await h.db
		.prepare('UPDATE jobs SET posted_date = ?, last_seen_at = ? WHERE id = ?')
		.bind(old, fresh, 'cull-alive')
		.run();
});

after(async () => {
	await h.dispose();
});

describe('POST /ingest/cull', () => {
	it('403s anonymously — maintenance is friend-gated', async () => {
		const res = await h.fetch(`${BASE}/ingest/cull`, { method: 'POST' });
		assert.equal(res.status, 403);
	});

	it('culls expired rows, spares owner-touched, fresh, and still-listed ones', async () => {
		const { status, body } = await h.json<{ success: boolean; data: { culled: number } }>(
			`${BASE}/ingest/cull`,
			{ method: 'POST', ...AUTH }
		);
		assert.equal(status, 200);
		assert.ok(body.data.culled >= 1, 'at least the dead row goes');
		const remaining = await h.db
			.prepare("SELECT id FROM jobs WHERE id LIKE 'cull-%' ORDER BY id")
			.all<{ id: string }>();
		assert.deepEqual(
			remaining.results.map((r) => r.id),
			['cull-alive', 'cull-fresh', 'cull-protected'],
			'only the untouchable dead row was deleted'
		);
	});
});

/** One minimal job as the scraper posts it. */
function job(over: { id: string; url: string }) {
	return {
		id: over.id,
		url: over.url,
		source_site: 'greenhouse',
		title: 'Engineer',
		company: 'Example',
		location: 'Remote',
		description: 'We build things.',
	};
}

async function ingest(
	jobs: ReturnType<typeof job>[],
	extra: { source: string; board_slug?: string }
) {
	return h.fetch(`${BASE}/ingest`, {
		method: 'POST',
		...AUTH,
		body: JSON.stringify({ jobs, batch_number: 1, is_final: false, ...extra }),
	});
}

describe('board_slug — the scraper knows which board it fetched', () => {
	/**
	 * `parseAtsSlug` guesses the slug from the hostname whenever an employer
	 * hosts its own careers site. Measured 2026-09-01, that guess is wrong for
	 * 12 of 37 employer-hosted Greenhouse boards — 1,633 postings — and the
	 * failure is silent: a wrong slug still looks like a slug, and only shows up
	 * when something tries to USE it (a derived apply URL 404s).
	 */
	it('prefers the scraper slug over the hostname guess', async () => {
		await ingest(
			[
				job({
					id: 'pin-1',
					url: 'https://www.pinterestcareers.com/jobs/?gh_jid=7888329',
				}),
			],
			{ source: 'greenhouse', board_slug: 'pinterest' }
		);
		const row = await h.db
			.prepare('SELECT ats, slug FROM jobs WHERE id = ?')
			.bind('pin-1')
			.first<{ ats: string; slug: string }>();
		assert.equal(row?.slug, 'pinterest', 'hostname says pinterestcareers; the board is pinterest');
		assert.equal(row?.ats, 'greenhouse');
	});

	it('still parses the URL when no board slug is sent', async () => {
		await ingest([job({ id: 'gh-1', url: 'https://boards.greenhouse.io/anthropic/jobs/123456' })], {
			source: 'greenhouse',
		});
		const row = await h.db
			.prepare('SELECT ats, slug FROM jobs WHERE id = ?')
			.bind('gh-1')
			.first<{ ats: string; slug: string }>();
		assert.equal(row?.slug, 'anthropic');
		assert.equal(row?.ats, 'greenhouse');
	});

	it('records that the scraper supplied the slug', async () => {
		await ingest([job({ id: 'prov-1', url: 'https://x.example.com/?gh_jid=1' })], {
			source: 'greenhouse',
			board_slug: 'pinterest',
		});
		const row = await h.db
			.prepare('SELECT slug_source FROM jobs WHERE id = ?')
			.bind('prov-1')
			.first<{ slug_source: string }>();
		assert.equal(row?.slug_source, 'scraped');
	});

	it('marks a hostname-derived slug as a guess', async () => {
		// The whole point: 'pinterestcareers' and 'pinterest' are both strings.
		// Only provenance tells a consumer which one it may build a URL from.
		await ingest([job({ id: 'prov-2', url: 'https://www.pinterestcareers.com/?gh_jid=2' })], {
			source: 'greenhouse',
		});
		const row = await h.db
			.prepare('SELECT slug, slug_source FROM jobs WHERE id = ?')
			.bind('prov-2')
			.first<{ slug: string; slug_source: string }>();
		assert.equal(row?.slug, 'pinterestcareers');
		assert.equal(row?.slug_source, 'guessed');
	});

	it('promotes a guess to scraped when the board is later named', async () => {
		await ingest([job({ id: 'prov-3', url: 'https://www.pinterestcareers.com/?gh_jid=3' })], {
			source: 'greenhouse',
		});
		await ingest([job({ id: 'prov-3', url: 'https://www.pinterestcareers.com/?gh_jid=3' })], {
			source: 'greenhouse',
			board_slug: 'pinterest',
		});
		const row = await h.db
			.prepare('SELECT slug, slug_source FROM jobs WHERE id = ?')
			.bind('prov-3')
			.first<{ slug: string; slug_source: string }>();
		assert.equal(row?.slug, 'pinterest');
		assert.equal(row?.slug_source, 'scraped');
	});

	it('heals a row already carrying the hostname guess', async () => {
		// Otherwise the rows written before this change keep a slug that derives
		// a 404 apply URL until someone runs a backfill.
		await ingest([job({ id: 'pin-2', url: 'https://www.pinterestcareers.com/jobs/?gh_jid=1' })], {
			source: 'greenhouse',
		});
		const before = await h.db
			.prepare('SELECT slug FROM jobs WHERE id = ?')
			.bind('pin-2')
			.first<{ slug: string }>();
		assert.equal(before?.slug, 'pinterestcareers');

		await ingest([job({ id: 'pin-2', url: 'https://www.pinterestcareers.com/jobs/?gh_jid=1' })], {
			source: 'greenhouse',
			board_slug: 'pinterest',
		});
		const after = await h.db
			.prepare('SELECT slug FROM jobs WHERE id = ?')
			.bind('pin-2')
			.first<{ slug: string }>();
		assert.equal(after?.slug, 'pinterest', 'a re-scrape corrects it');
	});
});

/**
 * The cull runs on every ingest — 2,027 calls in the week this was measured —
 * and its filter is a computed expression, so without a matching expression
 * index SQLite scans the whole jobs table: 31,271 rows and ~195ms per call, to
 * delete about two.
 *
 * SQLite only uses an expression index when the query's expression matches the
 * index's. Nothing fails when they stop matching: the cull still returns the
 * right rows, just by scanning again. So the plan itself is the assertion.
 */
describe('cull query plan', () => {
	it('seeks on idx_jobs_freshness rather than scanning jobs', async () => {
		const cutoff = new Date(Date.now() - 60 * 86_400_000).toISOString();
		const plan = await h.db
			.prepare(
				`EXPLAIN QUERY PLAN
				 SELECT j.id FROM jobs j
				 WHERE MAX(COALESCE(j.posted_date, ''), COALESCE(j.last_seen_at, ''), j.scraped_at) < ?
				   AND NOT EXISTS (SELECT 1 FROM job_states s WHERE s.job_id = j.id)
				   AND NOT EXISTS (SELECT 1 FROM job_feedback f WHERE f.job_id = j.id)
				 LIMIT 500`
			)
			.bind(cutoff)
			.all<{ detail: string }>();
		const details = plan.results.map((r) => r.detail).join('\n');
		assert.match(
			details,
			/USING INDEX idx_jobs_freshness/,
			`the cull stopped using its index — check that the expression in cullExpired() still ` +
				`matches migration 0019 exactly.\nplan was:\n${details}`
		);
		assert.doesNotMatch(details, /^SCAN j\b/m, `plan was:\n${details}`);
	});

	it('the dropped indexes are gone, and the ones covering them remain', async () => {
		const rows = await h.db
			.prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
			.all<{ name: string }>();
		const names = new Set(rows.results.map((r) => r.name));
		for (const dropped of [
			'idx_job_states_user',
			'idx_job_feedback_user',
			'idx_profiles_user',
			'idx_jobs_company',
		]) {
			assert.ok(!names.has(dropped), `${dropped} should have been dropped by 0019`);
		}
		// Each drop was safe only because a wider index still serves the lookup.
		for (const kept of ['idx_job_states_user_state', 'idx_profiles_user_default']) {
			assert.ok(names.has(kept), `${kept} is what makes dropping its prefix safe`);
		}
	});
});
