/**
 * Known ATS test boards (testBoards.ts): LinkedIn's own Greenhouse and Lever
 * tenants never enter the corpus — not from a scrape, not from an import — and
 * migration 0032 removes what was stored, sparing anything a person touched.
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE, createHarness, splitStatements, type Harness } from '../helpers/harness.ts';
import { startScraper } from '../helpers/scraper.ts';
import { seedJob, seedJobState } from '../helpers/seed.ts';
import { isTestBoardPosting } from '../../src/testBoards.ts';

const MIGRATION = join(
	dirname(fileURLToPath(import.meta.url)),
	'..',
	'..',
	'migrations',
	'0032_drop_test_board_postings.sql'
);

const GH_TEST = 'https://job-boards.greenhouse.io/linkedin/jobs/5786210';
const LEVER_TEST = 'https://jobs.lever.co/linkedin/015f3bc6-e2e7-4bfd-8368-bb22a40bed96';

function posting(id: string, url: string, title: string) {
	return {
		id,
		url,
		source_site: 'greenhouse.io',
		title,
		company: 'linkedin',
		location: 'Remote',
		description: 'x',
	};
}

let h: Harness;
let scraper: Awaited<ReturnType<typeof startScraper>>;

before(async () => {
	scraper = await startScraper({
		[GH_TEST]: {
			job: {
				...posting('greenhouse_5786210', GH_TEST, 'Bug Bash Job [No Sensitive Questions] - 03/24'),
				job_type: 'unknown',
				workplace_type: 'unknown',
				salary: null,
				raw: {},
			},
			ats: 'greenhouse',
			board_slug: 'linkedin',
		},
	});
	h = await createHarness({ scraperUrl: scraper.url });
});

beforeEach(async () => {
	for (const t of ['job_events', 'job_states', 'job_feedback', 'applications', 'jobs'])
		await h.db.prepare(`DELETE FROM ${t}`).run();
});

after(async () => {
	await h.dispose();
	await scraper.stop();
});

const ids = async () =>
	(await h.db.prepare('SELECT id FROM jobs ORDER BY id').all<{ id: string }>()).results.map(
		(r) => r.id
	);

describe('isTestBoardPosting', () => {
	it('knows the two LinkedIn tenants, by URL or by the board the scraper names', () => {
		assert.equal(isTestBoardPosting(GH_TEST), true);
		assert.equal(isTestBoardPosting('https://boards.greenhouse.io/LinkedIn/jobs/1'), true);
		assert.equal(isTestBoardPosting(LEVER_TEST), true);
		assert.equal(
			isTestBoardPosting('https://example.com/x', { ats: 'greenhouse', slug: 'linkedin' }),
			true
		);
	});

	it('leaves every other board alone, whatever the title says', () => {
		assert.equal(isTestBoardPosting('https://job-boards.greenhouse.io/spacex/jobs/1'), false);
		assert.equal(isTestBoardPosting('https://jobs.lever.co/linkedin-learning/1'), false);
		assert.equal(isTestBoardPosting('https://www.linkedin.com/jobs/view/1'), false);
	});
});

describe('POST /ingest', () => {
	it('skips test-board postings and keeps the rest of the batch', async () => {
		const res = await h.json<{ data: { accepted: number; skipped: number } }>(`${BASE}/ingest`, {
			method: 'POST',
			tier: 'service',
			userId: 'cccccccc-5555-4555-8555-cccccccccccc', // the scraper's service identity
			body: JSON.stringify({
				jobs: [
					posting('greenhouse_5786210', GH_TEST, 'Bug Bash Job [No Sensitive Questions] - 03/24'),
					posting(
						'greenhouse_1',
						'https://job-boards.greenhouse.io/linkedin/jobs/1',
						'QA Engineer'
					),
					posting(
						'greenhouse_2',
						'https://job-boards.greenhouse.io/spacex/jobs/2',
						'RF Test Engineer'
					),
				],
				batch_number: 1,
				is_final: true,
				source: 'greenhouse',
			}),
		});
		assert.equal(res.status, 200);
		assert.deepEqual(res.body.data, { accepted: 1, skipped: 2, batch_number: 1, is_final: true });
		assert.deepEqual(await ids(), ['greenhouse_2']);
	});

	it('skips a whole batch the scraper says came from a test board', async () => {
		const res = await h.json<{ data: { accepted: number } }>(`${BASE}/ingest`, {
			method: 'POST',
			tier: 'service',
			userId: 'cccccccc-5555-4555-8555-cccccccccccc', // the scraper's service identity
			body: JSON.stringify({
				jobs: [posting('lever_x', LEVER_TEST, 'Rug Maker')],
				batch_number: 1,
				is_final: true,
				source: 'lever',
				board_slug: 'linkedin',
			}),
		});
		assert.equal(res.body.data.accepted, 0);
		assert.deepEqual(await ids(), []);
	});
});

describe('POST /jobs/import', () => {
	it('refuses a test-board posting with a 422 the person can read', async () => {
		const res = await h.json<{ message: string }>(`${BASE}/jobs/import`, {
			method: 'POST',
			tier: 'friend',
			userId: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
			body: JSON.stringify({ url: GH_TEST }),
		});
		assert.equal(res.status, 422);
		assert.match(res.body.message, /test postings/);
		assert.deepEqual(await ids(), []);
	});

	it('refuses it on the pasted URL alone, without asking the scraper', async () => {
		const before = scraper.calls.length;
		const res = await h.json<{ message: string }>(`${BASE}/jobs/import`, {
			method: 'POST',
			tier: 'friend',
			userId: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
			body: JSON.stringify({ url: 'https://job-boards.greenhouse.io/linkedin/jobs/999' }),
		});
		assert.equal(res.status, 422);
		assert.equal(scraper.calls.length, before);
	});
});

describe('migration 0032', () => {
	it('deletes untouched test-board rows and spares any a person touched', async () => {
		const board = (id: string, url: string, ats: string) =>
			seedJob(h.db, {
				id,
				url,
				ats,
				slug: 'linkedin',
				company: 'linkedin',
				title: 'EA Test - Most Questions',
			});
		await board('gh-untouched', 'https://job-boards.greenhouse.io/linkedin/jobs/10', 'greenhouse');
		await board('lv-untouched', 'https://jobs.lever.co/linkedin/abc', 'lever');
		await board('gh-tracked', 'https://job-boards.greenhouse.io/linkedin/jobs/11', 'greenhouse');
		await board('gh-voted', 'https://job-boards.greenhouse.io/linkedin/jobs/12', 'greenhouse');
		await board('gh-queued', 'https://job-boards.greenhouse.io/linkedin/jobs/13', 'greenhouse');
		await seedJob(h.db, {
			id: 'real',
			url: 'https://job-boards.greenhouse.io/spacex/jobs/1',
			title: 'Test Engineer',
		});
		await seedJobState(h.db, { job_id: 'gh-tracked', user_id: 'u1', state: 'saved' });
		await h.db
			.prepare(
				"INSERT INTO job_feedback (id, job_id, user_id, vote, reason, created_at) VALUES ('f1', 'gh-voted', 'u1', -1, '[]', 'now')"
			)
			.run();
		await h.db
			.prepare(
				`INSERT INTO applications (id, user_id, job_id, variant_slug, mode, status, evidence, created_at, updated_at)
				 VALUES ('a1', 'u1', 'gh-queued', 'v', 'review', 'queued', '{}', 'now', 'now')`
			)
			.run();

		for (const stmt of splitStatements(readFileSync(MIGRATION, 'utf8')))
			await h.db.prepare(stmt).run();

		assert.deepEqual(await ids(), ['gh-queued', 'gh-tracked', 'gh-voted', 'real']);
	});
});
