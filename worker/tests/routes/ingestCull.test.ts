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
