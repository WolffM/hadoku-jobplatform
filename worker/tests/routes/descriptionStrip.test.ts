import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, type Harness } from '../helpers/harness.ts';
import { seedJob, seedJobState } from '../helpers/seed.ts';

const BASE = '/jobplatform/api';
const AUTH = {
	headers: { 'X-Edge-Auth': 'test-edge-secret', 'X-Hadoku-Tier': 'friend', 'X-User-Id': 'u-strip' },
};
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();

let h: Harness;

async function description(id: string): Promise<string | undefined> {
	const row = await h.db
		.prepare('SELECT description FROM jobs WHERE id = ?')
		.bind(id)
		.first<{ description: string }>();
	return row?.description;
}

before(async () => {
	h = await createHarness();
	// Taken down three weeks ago: inside the 60-day cull, past the 14-day strip.
	await seedJob(h.db, { id: 'strip-gone', scraped_at: daysAgo(40), last_seen_at: daysAgo(21) });
	await seedJob(h.db, { id: 'strip-listed', scraped_at: daysAgo(40), last_seen_at: daysAgo(1) });
	await seedJob(h.db, { id: 'strip-recent', scraped_at: daysAgo(40), last_seen_at: daysAgo(10) });
	await seedJob(h.db, { id: 'strip-triaged', scraped_at: daysAgo(40), last_seen_at: daysAgo(21) });
	await seedJobState(h.db, { job_id: 'strip-triaged', user_id: 'u-strip', state: 'applied' });
	await seedJob(h.db, { id: 'strip-voted', scraped_at: daysAgo(40), last_seen_at: daysAgo(21) });
	await h.db
		.prepare(
			`INSERT INTO job_feedback (id, user_id, job_id, vote, created_at)
			 VALUES ('fb-1', 'u-strip', 'strip-voted', 1, ?)`
		)
		.bind(daysAgo(30))
		.run();
	// Older rows predate liveness and carry no last_seen_at at all.
	await seedJob(h.db, { id: 'strip-unstamped', scraped_at: daysAgo(30), last_seen_at: null });
});

after(async () => {
	await h.dispose();
});

describe('description strip', () => {
	it('blanks descriptions unseen for 14 days, keeping the row', async () => {
		const { status, body } = await h.json<{
			data: { culled: number; stripped: number; has_more: boolean };
		}>(`${BASE}/ingest/cull`, { method: 'POST', ...AUTH });
		assert.equal(status, 200);
		assert.equal(body.data.culled, 0, 'nothing here is old enough to cull');
		assert.equal(body.data.stripped, 2);
		assert.equal(body.data.has_more, false);
		assert.equal(await description('strip-gone'), '');
		assert.equal(await description('strip-unstamped'), '');
	});

	it('spares listed, recently seen, and owner-touched postings', async () => {
		for (const id of ['strip-listed', 'strip-recent', 'strip-triaged', 'strip-voted']) {
			assert.equal(await description(id), 'We build things.', id);
		}
	});

	it('restores the description when a stripped posting is scraped again', async () => {
		const res = await h.fetch(`${BASE}/ingest`, {
			method: 'POST',
			...AUTH,
			body: JSON.stringify({
				jobs: [
					{
						id: 'strip-gone',
						url: 'https://boards.greenhouse.io/acme/jobs/strip-gone',
						source_site: 'greenhouse',
						title: 'Software Engineer',
						company: 'Acme',
						location: 'Remote',
						description: 'Back on the board.',
					},
				],
				batch_number: 1,
				is_final: false,
				source: 'greenhouse',
			}),
		});
		assert.equal(res.status, 200);
		assert.equal(await description('strip-gone'), 'Back on the board.');
	});

	it('leaves an intact description alone on a re-scrape', async () => {
		// Ingest never overwrites a known posting's fields; only a blanked one heals.
		await h.fetch(`${BASE}/ingest`, {
			method: 'POST',
			...AUTH,
			body: JSON.stringify({
				jobs: [
					{
						id: 'strip-listed',
						url: 'https://boards.greenhouse.io/acme/jobs/strip-listed',
						source_site: 'greenhouse',
						title: 'Software Engineer',
						company: 'Acme',
						location: 'Remote',
						description: 'Edited upstream.',
					},
				],
				batch_number: 1,
				is_final: false,
				source: 'greenhouse',
			}),
		});
		assert.equal(await description('strip-listed'), 'We build things.');
	});

	it('seeks on idx_jobs_scraped_at rather than scanning jobs', async () => {
		const cutoff = daysAgo(14);
		const plan = await h.db
			.prepare(
				`EXPLAIN QUERY PLAN
				 SELECT j.id FROM jobs j
				 WHERE j.scraped_at < ?
				   AND MAX(COALESCE(j.last_seen_at, ''), j.scraped_at) < ?
				   AND j.description <> ''
				   AND NOT EXISTS (SELECT 1 FROM job_states s WHERE s.job_id = j.id)
				   AND NOT EXISTS (SELECT 1 FROM job_feedback f WHERE f.job_id = j.id)
				 LIMIT 500`
			)
			.bind(cutoff, cutoff)
			.all<{ detail: string }>();
		const details = plan.results.map((r) => r.detail).join('\n');
		assert.match(details, /USING INDEX idx_jobs_scraped_at/, `plan was:\n${details}`);
		assert.doesNotMatch(details, /^SCAN j\b/m, `plan was:\n${details}`);
	});
});

describe('0026', () => {
	it('dropped user_companies and its indexes', async () => {
		const rows = await h.db
			.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%user_companies%'")
			.all<{ name: string }>();
		assert.deepEqual(rows.results, []);
	});
});
