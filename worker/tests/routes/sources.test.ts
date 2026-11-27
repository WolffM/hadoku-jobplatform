/**
 * GET / POST /ingest/sources and the /directives split, through the whole
 * worker against a real database, with every source answered by a loopback
 * stand-in serving recorded responses (tests/helpers/jobSources.ts).
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BASE, createHarness, type Harness } from '../helpers/harness.ts';
import { fixtureJson, startJobSources } from '../helpers/jobSources.ts';
import { seedProfile, seedProfileCompany } from '../helpers/seed.ts';
import { STARTER_BOARDS } from '../../src/sources/boards.ts';
import { DETAIL_CAP } from '../../src/sources/run.ts';

interface Task {
	source: string;
	label: string;
	keyword?: string;
	where?: string;
	radius_km?: number;
	slug?: string;
	company?: string;
	country?: string | null;
}
interface RunData {
	task: number;
	tasks_total: number;
	label: string | null;
	listed: number;
	accepted: number;
	already_known: number;
	details_fetched: number;
	details_failed: number;
	deferred: number;
	error: string | null;
	next_task: number | null;
}

let h: Harness;
let sources: Awaited<ReturnType<typeof startJobSources>>;

before(async () => {
	sources = await startJobSources();
	h = await createHarness({ jobSourcesUrl: sources.url });
});

after(async () => {
	await h.dispose();
	await sources.stop();
});

beforeEach(async () => {
	for (const t of [
		'job_profile_rank',
		'job_profile_rank_state',
		'jobs',
		'profile_companies',
		'profiles',
	])
		await h.db.prepare(`DELETE FROM ${t}`).run();
	sources.reset();
});

async function profileAt(id: string, location: string | null, keywords: string[], radius = 25) {
	await seedProfile(h.db, { id, keywords });
	await h.db
		.prepare('UPDATE profiles SET location = ?, radius_miles = ? WHERE id = ?')
		.bind(location, radius, id)
		.run();
}

async function plan(): Promise<Task[]> {
	const res = await h.json<{ data: { tasks: Task[] } }>(`${BASE}/ingest/sources`, {
		tier: 'service',
	});
	assert.equal(res.status, 200);
	return res.body.data.tasks;
}

async function run(task: number): Promise<RunData> {
	const res = await h.json<{ success: boolean; data: RunData }>(
		`${BASE}/ingest/sources?task=${task}`,
		{ method: 'POST', tier: 'service' }
	);
	assert.equal(res.status, 200, JSON.stringify(res.body));
	return res.body.data;
}

const jobsFrom = (site: string) =>
	h.db
		.prepare(
			'SELECT id, title, location, geo_keys, description, ats, slug, source_site FROM jobs WHERE source_site = ? ORDER BY id'
		)
		.bind(site)
		.all<{
			id: string;
			title: string;
			location: string;
			geo_keys: string;
			description: string;
			ats: string | null;
			slug: string | null;
			source_site: string;
		}>()
		.then((r) => r.results);

describe('GET /ingest/sources (the plan)', () => {
	it('searches each keyword once per German place, at the widest radius asked', async () => {
		await profileAt('p-berlin', 'berlin-de', ['project manager', 'Projektmanager']);
		await profileAt('p-berlin-2', 'berlin-de', ['Project Manager'], 40);
		await profileAt('p-seattle', 'seattle-wa', ['staff engineer']);
		await profileAt('p-nowhere', null, ['chief of staff']);
		await profileAt('p-frankfurt', 'frankfurt-de', ['program manager']);

		const searches = (await plan()).filter((t) => t.source === 'arbeitsagentur');
		assert.deepEqual(
			searches.map((t) => [t.keyword, t.where, t.radius_km]),
			[
				['project manager', 'Berlin', 64],
				['Projektmanager', 'Berlin', 40],
				['program manager', 'Frankfurt am Main', 40],
			]
		);
	});

	it('lists the starter boards, plus profile boards on the pulled ATSes only', async () => {
		await profileAt('p1', 'berlin-de', []);
		await seedProfileCompany(h.db, {
			id: 'c1',
			profile_id: 'p1',
			ats: 'personio',
			slug: 'acme-gmbh',
			display_name: 'Acme',
		});
		await seedProfileCompany(h.db, {
			id: 'c2',
			profile_id: 'p1',
			ats: 'greenhouse',
			slug: 'globex',
		});
		await seedProfileCompany(h.db, {
			id: 'c3',
			profile_id: 'p1',
			ats: 'smartrecruiters',
			slug: 'Vattenfall',
		});

		const boards = (await plan()).filter((t) => t.source !== 'arbeitsagentur');
		assert.equal(boards.length, STARTER_BOARDS.length + 1, 'acme added; Vattenfall already listed');
		assert.ok(boards.some((t) => t.slug === 'acme-gmbh' && t.company === 'Acme'));
		assert.ok(!boards.some((t) => t.slug === 'globex' || t.company === 'globex'));
		const vattenfall = boards.filter((t) => t.company?.toLowerCase() === 'vattenfall');
		assert.equal(vattenfall.length, 1);
		assert.equal(
			vattenfall[0].country,
			null,
			"a profile's whole-board ask widens the starter's filter"
		);
	});

	it('is closed to the public', async () => {
		const res = await h.fetch(`${BASE}/ingest/sources`);
		assert.ok(res.status === 401 || res.status === 403, String(res.status));
		const post = await h.fetch(`${BASE}/ingest/sources?task=0`, { method: 'POST' });
		assert.ok(post.status === 401 || post.status === 403, String(post.status));
	});
});

describe('POST /ingest/sources (one task)', () => {
	it('stores Jobsuche results with their text, placed so near=berlin-de finds them', async () => {
		await profileAt('p-berlin', 'berlin-de', ['project manager']);
		const r = await run(0);
		assert.equal(r.label, 'arbeitsagentur: "project manager" within 40 km of Berlin');
		assert.equal(r.listed, 3);
		assert.equal(r.accepted, 3);
		assert.equal(r.details_fetched, 3);
		assert.equal(r.error, null);
		assert.equal(r.next_task, 1);

		const searchCall = sources.calls.find((c) => c.path === '/arbeitsagentur/pc/v6/jobs');
		assert.ok(searchCall);
		assert.equal(searchCall.headers['x-api-key'], 'jobboerse-jobsuche');
		assert.equal(searchCall.query.get('was'), 'project manager');
		assert.equal(searchCall.query.get('wo'), 'Berlin');
		assert.equal(searchCall.query.get('umkreis'), '40');

		const rows = await jobsFrom('arbeitsagentur.de');
		assert.equal(rows.length, 3);
		for (const row of rows) {
			assert.equal(row.geo_keys, '|berlin-de|');
			assert.ok(row.description.length > 100, 'description fetched from the detail');
			assert.equal(row.ats, null, 'not an ATS board');
		}

		const feed = await h.json<{ data: { jobs: { id: string }[] } }>(
			`${BASE}/jobs?near=berlin-de&radius_miles=25&limit=50`
		);
		assert.equal(feed.status, 200);
		const ids = feed.body.data.jobs.map((j) => j.id).sort();
		assert.deepEqual(ids, rows.map((r) => r.id).sort());
	});

	it('a repeat run marks known postings seen and fetches no detail twice', async () => {
		await profileAt('p-berlin', 'berlin-de', ['project manager']);
		await run(0);
		sources.reset();
		const again = await run(0);
		assert.equal(again.accepted, 0);
		assert.equal(again.already_known, 3);
		assert.equal(again.details_fetched, 0);
		assert.deepEqual(
			sources.calls.map((c) => c.path),
			['/arbeitsagentur/pc/v6/jobs']
		);
	});

	it('does not store a posting whose detail failed, and stores the rest', async () => {
		await profileAt('p-berlin', 'berlin-de', ['project manager']);
		const failing = `/arbeitsagentur/pc/v4/jobdetails/${Buffer.from('16444-220253562-S').toString('base64')}`;
		sources.override(failing, { status: 500, body: '' });
		const r = await run(0);
		assert.equal(r.accepted, 2);
		assert.equal(r.details_failed, 1);
		const ids = (await jobsFrom('arbeitsagentur.de')).map((j) => j.id);
		assert.ok(!ids.includes('arbeitsagentur_16444-220253562-S'));
	});

	it('caps detail requests per call and asks for the same task again', async () => {
		await profileAt('p-berlin', 'berlin-de', ['project manager']);
		const row = fixtureJson<{ ergebnisliste: Record<string, unknown>[] }>(
			'arbeitsagentur-search.json'
		).ergebnisliste[0];
		const total = DETAIL_CAP + 5;
		sources.override('/arbeitsagentur/pc/v6/jobs', {
			status: 200,
			body: JSON.stringify({
				maxErgebnisse: total,
				ergebnisliste: Array.from({ length: total }, (_, i) => ({
					...row,
					referenznummer: `10000-${String(i).padStart(4, '0')}-S`,
				})),
			}),
		});
		const first = await run(0);
		assert.equal(first.accepted, DETAIL_CAP);
		assert.equal(first.deferred, 5);
		assert.equal(first.next_task, 0, 'the same task, for the deferred postings');
		const second = await run(0);
		assert.equal(second.accepted, 5);
		assert.equal(second.already_known, DETAIL_CAP);
		assert.equal(second.deferred, 0);
		assert.equal(second.next_task, 1);
	});

	it('a source that is down answers its error and lets the sweep move on', async () => {
		await profileAt('p-berlin', 'berlin-de', ['project manager']);
		sources.override('/arbeitsagentur/pc/v6/jobs', { status: 503, body: 'maintenance' });
		const r = await run(0);
		assert.match(r.error ?? '', /answered 503/);
		assert.equal(r.accepted, 0);
		assert.equal(r.next_task, 1);
		assert.equal((await jobsFrom('arbeitsagentur.de')).length, 0);
	});

	it('stores a Personio board under its ats and slug, without the talent-pool entry', async () => {
		const tasks = await plan();
		const i = tasks.findIndex((t) => t.source === 'personio' && t.slug === 'merantix');
		assert.ok(i >= 0);
		const r = await run(i);
		assert.equal(r.listed, 3);
		assert.equal(r.accepted, 3);
		assert.equal(r.details_fetched, 0);
		assert.ok(sources.calls.some((c) => c.path === '/personio/merantix/xml'));
		const rows = await jobsFrom('jobs.personio.de');
		assert.equal(rows.length, 3);
		assert.ok(rows.every((row) => row.ats === 'personio' && row.slug === 'merantix'));
		assert.ok(
			rows.every((row) => row.description !== ''),
			'English-only postings got their text from the second read'
		);
		assert.ok(rows.some((row) => row.geo_keys === '|berlin-de|'));
	});

	it('stores a SmartRecruiters board with descriptions from the job ad', async () => {
		const tasks = await plan();
		const i = tasks.findIndex((t) => t.source === 'smartrecruiters' && t.company === 'Vattenfall');
		const r = await run(i);
		assert.equal(r.accepted, 2);
		assert.equal(r.details_fetched, 2);
		const list = sources.calls.find(
			(c) => c.path === '/smartrecruiters/v1/companies/Vattenfall/postings'
		);
		assert.equal(list?.query.get('country'), 'de');
		const rows = await jobsFrom('smartrecruiters.com');
		assert.equal(rows.length, 2);
		assert.ok(rows.every((row) => row.description.includes('<h3>Stellenbeschreibung</h3>')));
		assert.ok(rows.every((row) => row.ats === 'smartrecruiters' && row.slug === 'vattenfall'));
	});

	it('past the last task, does nothing and says the sweep is done', async () => {
		const total = (await plan()).length;
		const r = await run(total);
		assert.equal(r.label, null);
		assert.equal(r.next_task, null);
		assert.equal(sources.calls.length, 0);
		const last = await run(total - 1);
		assert.equal(last.next_task, null);
	});
});

describe('GET /directives', () => {
	it('withholds the boards this worker pulls from the scraper', async () => {
		await profileAt('p1', 'berlin-de', ['project manager']);
		await seedProfileCompany(h.db, {
			id: 'c1',
			profile_id: 'p1',
			ats: 'personio',
			slug: 'acme-gmbh',
		});
		await seedProfileCompany(h.db, {
			id: 'c2',
			profile_id: 'p1',
			ats: 'smartrecruiters',
			slug: 'Vattenfall',
		});
		await seedProfileCompany(h.db, {
			id: 'c3',
			profile_id: 'p1',
			ats: 'greenhouse',
			slug: 'globex',
		});
		const res = await h.json<{
			data: { companies: { ats: string; slug: string }[]; keywords: string[] };
		}>(`${BASE}/directives`, { tier: 'service' });
		assert.equal(res.status, 200);
		assert.deepEqual(res.body.data.companies, [{ ats: 'greenhouse', slug: 'globex' }]);
		assert.deepEqual(res.body.data.keywords, ['project manager']);
	});
});
