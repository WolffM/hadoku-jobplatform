/**
 * POST /jobs/import — a pasted posting URL into the corpus and the caller's
 * pipeline, through a loopback stand-in for the scraper's /extract.
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BASE, createHarness, type Harness } from '../helpers/harness.ts';
import { startScraper, type ExtractAnswer } from '../helpers/scraper.ts';
import { seedJob, seedJobState, seedProfile } from '../helpers/seed.ts';

const ALICE = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const BOB = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

function posting(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: 'greenhouse_9001',
		url: 'https://job-boards.greenhouse.io/globex/jobs/9001',
		source_site: 'greenhouse.io',
		title: 'Senior Platform Engineer',
		company: 'globex',
		location: 'Seattle, WA',
		job_type: 'full_time',
		workplace_type: 'hybrid',
		experience_level: 'unknown',
		salary: null,
		description: 'Run the platform. Pay range $180,000 - $220,000.',
		requirements: [],
		qualifications: [],
		benefits: [],
		responsibilities: [],
		posted_date: '2026-11-01T00:00:00+00:00',
		application_url: 'https://job-boards.greenhouse.io/globex/jobs/9001',
		applicant_count: null,
		department: 'Engineering',
		team: null,
		scraped_at: '2026-11-08T00:00:00+00:00',
		scraper_used: 'greenhouse',
		...over,
	};
}

const PASTED = 'https://boards.greenhouse.io/globex/jobs/9001?gh_src=newsletter';

const ANSWERS: Record<string, ExtractAnswer> = {
	[PASTED]: { job: posting(), ats: 'greenhouse', board_slug: 'globex' },
	'https://www.linkedin.com/jobs/view/1': {
		status: 422,
		detail: "LinkedIn postings can't be imported. Open the job on the employer's own site.",
	},
	'https://job-boards.greenhouse.io/globex/jobs/404': {
		status: 404,
		detail: 'That posting no longer exists on its board (404).',
	},
	'https://down.example/job': { status: 502, detail: 'down.example answered 503.' },
	'https://odd.example/job': { job: { title: 'no id or url' } },
	// The board's canonical URL differs from the one pasted, and the corpus
	// already holds the posting under its id.
	'https://boards.greenhouse.io/acme/jobs/known?utm=x': {
		job: posting({ id: 'known-id', url: 'https://job-boards.greenhouse.io/acme/jobs/known' }),
		ats: 'greenhouse',
		board_slug: 'acme',
	},
	'https://careers.acme.example/jobs?gh_jid=2': {
		job: posting({ id: 'greenhouse_2', url: 'https://careers.acme.example/jobs?gh_jid=2' }),
		ats: 'greenhouse',
		board_slug: 'acme',
	},
};

let h: Harness;
let scraper: Awaited<ReturnType<typeof startScraper>>;

before(async () => {
	scraper = await startScraper(ANSWERS);
	h = await createHarness({ scraperUrl: scraper.url });
});

beforeEach(async () => {
	for (const t of ['job_events', 'job_states', 'jobs'])
		await h.db.prepare(`DELETE FROM ${t}`).run();
	scraper.calls.length = 0;
});

after(async () => {
	await h.dispose();
	await scraper.stop();
});

interface Imported {
	data: {
		job: { id: string; title: string; company: string; url: string };
		created: boolean;
		state: string;
		already_tracked: boolean;
	};
	message?: string;
}

const importUrl = (body: unknown, qs = '') =>
	h.json<Imported>(`${BASE}/jobs/import${qs}`, {
		method: 'POST',
		tier: 'friend',
		userId: ALICE,
		body: JSON.stringify(body),
	});

async function timeline(jobId: string) {
	return (
		await h.db
			.prepare('SELECT kind, from_state, to_state FROM job_events WHERE job_id = ? AND user_id = ?')
			.bind(jobId, ALICE)
			.all<{ kind: string; from_state: string | null; to_state: string }>()
	).results;
}

describe('POST /jobs/import', () => {
	it('403s an unauthenticated caller', async () => {
		const res = await h.fetch(`${BASE}/jobs/import`, {
			method: 'POST',
			body: JSON.stringify({ url: PASTED }),
		});
		assert.equal(res.status, 403);
	});

	it('stores a new posting the way /ingest would, and saves it to the pipeline', async () => {
		const res = await importUrl({ url: PASTED });
		assert.equal(res.status, 200);
		assert.deepEqual(
			{
				id: res.body.data.job.id,
				created: res.body.data.created,
				state: res.body.data.state,
				already: res.body.data.already_tracked,
			},
			{ id: 'greenhouse_9001', created: true, state: 'saved', already: false }
		);
		// Asked as the worker's service identity.
		assert.equal(scraper.calls[0].key, 'test-service-key');

		const row = await h.db
			.prepare(
				'SELECT url, ats, slug, slug_source, role_track, role_level, salary_min, salary_max, geo_keys FROM jobs WHERE id = ?'
			)
			.bind('greenhouse_9001')
			.first<Record<string, unknown>>();
		assert.deepEqual(row, {
			// Under the board's canonical URL, not the pasted one.
			url: 'https://job-boards.greenhouse.io/globex/jobs/9001',
			ats: 'greenhouse',
			slug: 'globex',
			slug_source: 'scraped',
			role_track: 'ic',
			role_level: 'senior',
			// Mined from the prose, as ingest does when the ATS sends no salary.
			salary_min: 180000,
			salary_max: 220000,
			geo_keys: '|seattle-wa|',
		});
		assert.deepEqual(await timeline('greenhouse_9001'), [
			{ kind: 'state', from_state: null, to_state: 'saved' },
		]);
	});

	it("extends every current ranking to cover it, so the feed's fast path can show it", async () => {
		await seedProfile(h.db, { id: 'rank-p', user_id: ALICE, keywords: ['engineer'] });
		await seedJob(h.db, { id: 'older', title: 'Engineer' });
		const built = await h.fetch(`${BASE}/ingest/rebuild-rank?profile_id=rank-p`, {
			method: 'POST',
			tier: 'friend',
		});
		assert.equal(built.status, 200);
		await importUrl({ url: PASTED });
		const ranked = await h.db
			.prepare('SELECT COUNT(*) AS n FROM job_profile_rank WHERE profile_id = ? AND job_id = ?')
			.bind('rank-p', 'greenhouse_9001')
			.first<{ n: number }>();
		assert.equal(ranked?.n, 1);
		await h.db.prepare('DELETE FROM job_profile_rank').run();
		await h.db.prepare('DELETE FROM job_profile_rank_state').run();
		await h.db.prepare('DELETE FROM profiles').run();
	});

	it('shows up on GET /pipeline', async () => {
		await importUrl({ url: PASTED, state: 'interested' });
		const res = await h.json<{ data: { items: { job_id: string; state: string }[] } }>(
			`${BASE}/pipeline`,
			{ tier: 'friend', userId: ALICE }
		);
		assert.deepEqual(
			res.body.data.items.map((i) => [i.job_id, i.state]),
			[['greenhouse_9001', 'interested']]
		);
	});

	it('does not scrape a URL the corpus already holds', async () => {
		await seedJob(h.db, { id: 'have', url: 'https://jobs.lever.co/acme/abc' });
		const res = await importUrl({ url: 'https://jobs.lever.co/acme/abc' });
		assert.equal(res.body.data.job.id, 'have');
		assert.equal(res.body.data.created, false);
		assert.equal(scraper.calls.length, 0);
	});

	it('lands on the existing row when the board names a posting already stored', async () => {
		await seedJob(h.db, {
			id: 'known-id',
			url: 'https://job-boards.greenhouse.io/acme/jobs/known',
		});
		const res = await importUrl({ url: 'https://boards.greenhouse.io/acme/jobs/known?utm=x' });
		assert.equal(res.status, 200);
		assert.equal(res.body.data.job.id, 'known-id');
		assert.equal(res.body.data.created, false);
		const n = await h.db.prepare('SELECT COUNT(*) AS n FROM jobs').first<{ n: number }>();
		assert.equal(n?.n, 1);
	});

	it('never moves a tracked application backwards', async () => {
		await seedJob(h.db, { id: 'sent', url: 'https://jobs.lever.co/acme/sent' });
		await seedJobState(h.db, { job_id: 'sent', user_id: ALICE, state: 'applied' });
		const res = await importUrl({ url: 'https://jobs.lever.co/acme/sent' });
		assert.equal(res.body.data.state, 'applied');
		assert.equal(res.body.data.already_tracked, true);
		assert.deepEqual(await timeline('sent'), []);
	});

	it("hints the board behind an employer-hosted gh_jid page from the host's other postings", async () => {
		await seedJob(h.db, {
			id: 'greenhouse_1',
			url: 'https://careers.acme.example/jobs?gh_jid=1',
			ats: 'greenhouse',
			slug: 'acme',
		});
		await h.db.prepare("UPDATE jobs SET slug_source = 'scraped'").run();
		await importUrl({ url: 'https://careers.acme.example/jobs?gh_jid=2' });
		assert.equal(scraper.calls[0].greenhouse_slug, 'acme');
	});

	it('sends no hint for a host it has never seen', async () => {
		await importUrl({ url: PASTED });
		assert.equal(scraper.calls[0].greenhouse_slug, undefined);
	});

	it("passes the scraper's own words through: 422, 404, 502", async () => {
		const linkedin = await importUrl({ url: 'https://www.linkedin.com/jobs/view/1' });
		assert.equal(linkedin.status, 422);
		assert.match(linkedin.body.message ?? '', /employer's own site/);
		assert.equal(
			(await importUrl({ url: 'https://job-boards.greenhouse.io/globex/jobs/404' })).status,
			404
		);
		const down = await importUrl({ url: 'https://down.example/job' });
		assert.equal(down.status, 502);
		assert.match(down.body.message ?? '', /down\.example answered 503/);
		const n = await h.db.prepare('SELECT COUNT(*) AS n FROM jobs').first<{ n: number }>();
		assert.equal(n?.n, 0);
	});

	it('refuses to store a posting missing the fields ingest requires', async () => {
		const res = await importUrl({ url: 'https://odd.example/job' });
		assert.equal(res.status, 502);
	});

	it('400s a non-URL and a dismissed import', async () => {
		assert.equal((await importUrl({ url: 'not a url' })).status, 400);
		assert.equal((await importUrl({ url: PASTED, state: 'dismissed' })).status, 400);
	});

	it('refuses a friend naming an owner', async () => {
		assert.equal((await importUrl({ url: PASTED }, '?ownerName=Hadoku')).status, 403);
	});
});

describe('POST /jobs/import with manual', () => {
	// A careers page with nothing machine-readable on it: the scraper is never
	// asked, so it has no answer for this URL at all.
	const WALLED = 'https://careers.walled.example/roles/42';
	const manual = {
		title: 'Staff Engineer, Payments',
		company: 'Walled Co',
		location: 'Seattle, WA',
		description: 'Recruiter says <b>remote OK</b> & equity.\n\nSecond round:\nsystem design',
	};

	interface Feed {
		data: { jobs: { id: string }[] };
	}
	const feedIds = async (opts: { userId?: string; qs?: string } = {}) =>
		(
			await h.json<Feed>(`${BASE}/jobs${opts.qs ?? ''}`, {
				...(opts.userId ? { tier: 'friend', userId: opts.userId } : {}),
			})
		).body.data.jobs.map((j) => j.id);

	it('stores what was typed without asking the scraper, and adds it to the pipeline', async () => {
		const res = await importUrl({ url: WALLED, state: 'applied', manual });
		assert.equal(res.status, 200);
		assert.equal(scraper.calls.length, 0);
		assert.equal(res.body.data.created, true);
		assert.equal(res.body.data.state, 'applied');
		assert.match(res.body.data.job.id, /^manual_[0-9a-f]{16}$/);

		const row = await h.db
			.prepare(
				'SELECT source_site, title, company, location, url, description, role_level, geo_keys FROM jobs WHERE id = ?'
			)
			.bind(res.body.data.job.id)
			.first<Record<string, unknown>>();
		assert.deepEqual(row, {
			source_site: 'manual',
			title: 'Staff Engineer, Payments',
			company: 'Walled Co',
			location: 'Seattle, WA',
			url: WALLED,
			// Their words, escaped: no markup of theirs survives as markup.
			description:
				'<p>Recruiter says &lt;b&gt;remote OK&lt;/b&gt; &amp; equity.</p><p>Second round:<br>system design</p>',
			role_level: 'staff',
			geo_keys: '|seattle-wa|',
		});
		assert.deepEqual(await timeline(res.body.data.job.id), [
			{ kind: 'state', from_state: null, to_state: 'applied' },
		]);
	});

	it('lands on one row when the same URL is typed in twice', async () => {
		const first = await importUrl({ url: WALLED, manual });
		const again = await importUrl({ url: WALLED, manual: { ...manual, title: 'Typo fixed' } });
		assert.equal(again.body.data.job.id, first.body.data.job.id);
		assert.equal(again.body.data.created, false);
		assert.equal(again.body.data.already_tracked, true);
		const n = await h.db.prepare('SELECT COUNT(*) AS n FROM jobs').first<{ n: number }>();
		assert.equal(n?.n, 1);
	});

	it('is in the feed of the person tracking it, and no one else’s', async () => {
		await seedJob(h.db, { id: 'scraped', title: 'Engineer' });
		const res = await importUrl({ url: WALLED, state: 'interested', manual });
		const id = res.body.data.job.id;

		assert.ok((await feedIds({ userId: ALICE })).includes(id));
		assert.ok((await feedIds({ userId: ALICE, qs: '?state=interested' })).includes(id));
		assert.deepEqual(await feedIds({ userId: BOB }), ['scraped']);
		assert.deepEqual(await feedIds(), ['scraped']);
	});

	it('400s a manual entry with no title or company', async () => {
		assert.equal(
			(await importUrl({ url: WALLED, manual: { ...manual, title: '  ' } })).status,
			400
		);
		assert.equal((await importUrl({ url: WALLED, manual: { title: 'x' } })).status, 400);
		assert.equal(scraper.calls.length, 0);
	});
});
