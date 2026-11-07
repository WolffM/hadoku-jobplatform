/**
 * Where a posting is (jobs.geo_keys, migration 0030): written at ingest,
 * backfilled for older rows, and read by the feed's near= radius filter.
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BASE, createHarness, type Harness } from '../helpers/harness.ts';
import { seedJob, seedProfile } from '../helpers/seed.ts';

const SERVICE = { tier: 'service' as const, userId: 'geo-service' };

let h: Harness;

const geoOf = async (id: string) =>
	(
		await h.db
			.prepare('SELECT geo_keys FROM jobs WHERE id = ?')
			.bind(id)
			.first<{ geo_keys: string | null }>()
	)?.geo_keys;

const feedIds = async (qs: string) => {
	const { status, body } = await h.json<{ data: { jobs: { id: string }[] } }>(`${BASE}/jobs${qs}`);
	assert.equal(status, 200, qs);
	return body.data.jobs.map((j) => j.id).sort();
};

const backfill = (qs = '') =>
	h.json<{
		data: {
			scanned: number;
			placed: number;
			remaining: number | null;
			next_after: string | null;
			has_more: boolean;
		};
	}>(`${BASE}/ingest/backfill-geo${qs}`, { method: 'POST', ...SERVICE });

before(async () => {
	h = await createHarness();
	// Seeded straight into D1, so geo_keys starts NULL — a pre-0030 row.
	await seedJob(h.db, { id: 'g-sea', location: 'Seattle, WA', workplace_type: 'onsite' });
	await seedJob(h.db, { id: 'g-bel', location: 'Bellevue, WA', workplace_type: 'hybrid' });
	await seedJob(h.db, { id: 'g-sf', location: 'San Francisco, CA', workplace_type: 'onsite' });
	await seedJob(h.db, { id: 'g-rem', location: 'Remote - USA', workplace_type: 'remote' });
	await seedJob(h.db, { id: 'g-nowhere', location: 'Hybrid', workplace_type: 'hybrid' });
	await seedProfile(h.db, { id: 'gp', keywords: ['engineer'] });
});

after(async () => {
	await h.dispose();
});

describe('POST /ingest/backfill-geo', () => {
	beforeEach(async () => {
		await h.db.prepare('UPDATE jobs SET geo_keys = NULL').run();
	});

	it('403s below friend', async () => {
		const res = await h.fetch(`${BASE}/ingest/backfill-geo`, { method: 'POST' });
		assert.equal(res.status, 403);
	});

	it('fills every NULL row and stops — an unplaced row is "" so it is not read again', async () => {
		const first = await backfill('?limit=3');
		assert.deepEqual(
			{ scanned: first.body.data.scanned, has_more: first.body.data.has_more },
			{ scanned: 3, has_more: true }
		);
		const second = await backfill('?limit=3');
		assert.equal(second.body.data.has_more, false);
		assert.equal(second.body.data.remaining, 0);
		assert.equal(await geoOf('g-sea'), '|seattle-wa|');
		assert.equal(await geoOf('g-nowhere'), '');
	});

	it('rereads every row by id when asked, paging with next_after', async () => {
		let after = '';
		let scanned = 0;
		for (let i = 0; i < 10; i++) {
			const { body } = await backfill(`?reread=true&limit=2&after=${encodeURIComponent(after)}`);
			scanned += body.data.scanned;
			if (!body.data.has_more) break;
			after = body.data.next_after!;
		}
		const total = (await h.db.prepare('SELECT COUNT(*) AS n FROM jobs').first<{ n: number }>())!.n;
		assert.equal(scanned, total);
		assert.equal(await geoOf('g-sf'), '|san-francisco-ca|');
	});
});

describe('POST /ingest — writes geo_keys for a new posting', () => {
	it('places it at write time', async () => {
		const { status } = await h.json(`${BASE}/ingest`, {
			method: 'POST',
			...SERVICE,
			body: JSON.stringify({
				jobs: [
					{
						id: 'g-new',
						url: 'https://boards.greenhouse.io/acme/jobs/g-new',
						source_site: 'greenhouse',
						title: 'Software Engineer',
						company: 'Acme',
						location: 'Cambridge, MA',
						description: 'x',
					},
				],
				batch_number: 1,
				is_final: false,
				source: 'greenhouse',
				board_slug: 'acme',
			}),
		});
		assert.equal(status, 200);
		assert.equal(await geoOf('g-new'), '|cambridge-ma|');
		await h.db.prepare("DELETE FROM jobs WHERE id = 'g-new'").run();
	});
});

describe('GET /jobs?near=', () => {
	before(async () => {
		await h.db.prepare('UPDATE jobs SET geo_keys = NULL').run();
		await backfill('?limit=2000');
	});

	it('keeps postings within the radius, plus remote ones', async () => {
		assert.deepEqual(await feedIds('?near=seattle-wa&radius_miles=25'), [
			'g-bel',
			'g-rem',
			'g-sea',
		]);
	});

	it('takes free text for the centre', async () => {
		assert.deepEqual(await feedIds('?near=Seattle,%20WA&radius_miles=5'), ['g-rem', 'g-sea']);
	});

	it('drops remote postings when include_remote=false', async () => {
		assert.deepEqual(await feedIds('?near=seattle-wa&include_remote=false'), ['g-bel', 'g-sea']);
	});

	it('applies on the score-on-read path too', async () => {
		assert.deepEqual(await feedIds('?near=seattle-wa&include_remote=false&profile_id=gp'), [
			'g-bel',
			'g-sea',
		]);
	});

	it('400s a centre it cannot place', async () => {
		const res = await h.fetch(`${BASE}/jobs?near=Atlantis`);
		assert.equal(res.status, 400);
	});
});

describe('GET /locations', () => {
	it('answers keys and labels, prefix matches first, without auth', async () => {
		const { status, body } = await h.json<{
			data: { locations: { key: string; label: string }[] };
		}>(`${BASE}/locations?q=seat`);
		assert.equal(status, 200);
		assert.deepEqual(body.data.locations[0], {
			key: 'seattle-wa',
			label: 'Seattle, WA',
			lat: 47.6062,
			lng: -122.3321,
		});
	});

	it('400s an empty query', async () => {
		assert.equal((await h.fetch(`${BASE}/locations?q=`)).status, 400);
	});
});
