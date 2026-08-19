/**
 * GET /jobs/{id} and GET /jobs/preflight.
 *
 * The two live in the same file for a reason worth locking down: preflight is a
 * static path that must be registered BEFORE the /jobs/{id} param route, or the
 * param route swallows "preflight" as an id. That ordering is a property of the
 * assembled app, so it belongs in a test, not a comment.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BASE, createHarness, type Harness } from '../helpers/harness.ts';
import { seedJob, seedProfile, seedJobState } from '../helpers/seed.ts';

interface DetailBody {
	success: boolean;
	data: {
		job: {
			id: string;
			title: string;
			description: string;
			job_type: string;
			department: string | null;
			application_url: string | null;
			run_id: string | null;
			scraper_used: string | null;
			role_track: string;
			role_level: string | null;
			score: number;
			score_breakdown: Record<string, number>;
			state: string | null;
			state_updated_at: string | null;
		};
	};
}

interface PreflightBody {
	success: boolean;
	data: { count: number };
}

let h: Harness;

before(async () => {
	h = await createHarness();

	await seedJob(h.db, {
		id: 'detail-1',
		title: 'Senior Software Engineer',
		company: 'Acme',
		description: 'Distributed systems in Go. Kubernetes everywhere.',
		job_type: 'full_time',
		department: 'Platform',
		application_url: 'https://apply.example/1',
		scraper_used: 'greenhouse-v2',
		run_id: 'run-42',
		role_track: 'ic',
		role_level: 'senior',
		workplace_type: 'remote',
	});
	await seedJob(h.db, {
		id: 'detail-2',
		title: 'Engineering Manager',
		company: 'Globex',
		description: 'Lead the team.',
		role_track: 'manager',
		role_level: 'manager',
		workplace_type: 'onsite',
	});
	// A row that predates the 0009 classifier: role_track defaults to 'unknown'
	// and role_level is NULL.
	await seedJob(h.db, {
		id: 'detail-legacy',
		title: 'Mystery Role',
		description: 'Unclassified.',
		role_track: 'unknown',
		role_level: null,
	});
	// A row carrying a level the current classifier does not know about.
	await seedJob(h.db, {
		id: 'detail-bogus-level',
		title: 'Future Role',
		description: 'From a later classifier.',
		role_track: 'ic',
		role_level: 'archmage',
	});

	await seedProfile(h.db, {
		id: 'p-detail',
		keywords: ['Go', 'Kubernetes'],
		track: 'either',
		levels: ['senior'],
		remote_pref: 'remote',
	});
});

after(async () => {
	await h.dispose();
});

describe('GET /jobs/{id}', () => {
	it('returns the full row including detail-only columns', async () => {
		const { status, body } = await h.json<DetailBody>(`${BASE}/jobs/detail-1`);
		assert.equal(status, 200);
		const job = body.data.job;
		assert.equal(job.id, 'detail-1');
		assert.equal(job.description, 'Distributed systems in Go. Kubernetes everywhere.');
		assert.equal(job.job_type, 'full_time');
		assert.equal(job.department, 'Platform');
		assert.equal(job.application_url, 'https://apply.example/1');
		assert.equal(job.scraper_used, 'greenhouse-v2');
		assert.equal(job.run_id, 'run-42');
	});

	it('404s on an unknown id', async () => {
		const { status, body } = await h.json<{ success: boolean; error: string; message: string }>(
			`${BASE}/jobs/nope`
		);
		assert.equal(status, 404);
		assert.equal(body.success, false);
		assert.match(body.message, /nope/);
	});

	it('reports a neutral score with no profile_id', async () => {
		const { body } = await h.json<DetailBody>(`${BASE}/jobs/detail-1`);
		assert.equal(body.data.job.score, 0);
		assert.deepEqual(body.data.job.score_breakdown, {
			relevance: 0,
			level_match: 0,
			geo_fit: 0,
			comp_fit: 0,
			stack_fit: 0,
			domain_interest: 0,
			discipline_factor: 0,
		});
	});

	it('scores against a profile when one is named', async () => {
		const { body } = await h.json<DetailBody>(`${BASE}/jobs/detail-1?profile_id=p-detail`);
		assert.ok(body.data.job.score > 0);
		assert.equal(body.data.job.score_breakdown.level_match, 1.0, 'exact rung');
		assert.ok(body.data.job.score_breakdown.geo_fit >= 0.85, 'remote profile, remote job');
	});

	it('degrades an unknown profile_id to neutral criteria', async () => {
		const { status, body } = await h.json<DetailBody>(`${BASE}/jobs/detail-1?profile_id=ghost`);
		assert.equal(status, 200);
		assert.equal(body.data.job.score_breakdown.relevance, 0.5, 'no keywords ⇒ neutral');
	});

	it('normalises an unclassified row instead of leaking a bogus enum value', async () => {
		const legacy = await h.json<DetailBody>(`${BASE}/jobs/detail-legacy`);
		assert.equal(legacy.body.data.job.role_track, 'unknown');
		assert.equal(legacy.body.data.job.role_level, null);

		const bogus = await h.json<DetailBody>(`${BASE}/jobs/detail-bogus-level`);
		assert.equal(
			bogus.body.data.job.role_level,
			null,
			'a level the classifier does not know must degrade to null'
		);
	});

	it('omits state when unauthenticated and reports it when authed', async () => {
		const anon = await h.json<DetailBody>(`${BASE}/jobs/detail-1`);
		assert.equal(anon.body.data.job.state, null);
		assert.equal(anon.body.data.job.state_updated_at, null);

		const fresh = await h.json<DetailBody>(`${BASE}/jobs/detail-1`, {
			tier: 'friend',
			userId: 'detail-reader',
		});
		assert.equal(fresh.body.data.job.state, 'new', 'no row means implicit "new"');
		assert.equal(fresh.body.data.job.state_updated_at, null);

		await seedJobState(h.db, {
			job_id: 'detail-1',
			user_id: 'detail-reader',
			state: 'interested',
		});
		const withState = await h.json<DetailBody>(`${BASE}/jobs/detail-1`, {
			tier: 'friend',
			userId: 'detail-reader',
		});
		assert.equal(withState.body.data.job.state, 'interested');
		assert.equal(withState.body.data.job.state_updated_at, '2026-08-01T00:00:00.000Z');
	});
});

describe('GET /jobs/preflight', () => {
	it('resolves ahead of the /jobs/{id} param route', async () => {
		const { status, body } = await h.json<PreflightBody>(`${BASE}/jobs/preflight`);
		assert.equal(status, 200, 'a 404 here means /jobs/{id} captured "preflight" as an id');
		assert.equal(typeof body.data.count, 'number');
	});

	it('counts the whole corpus with no filters', async () => {
		const { body } = await h.json<PreflightBody>(`${BASE}/jobs/preflight`);
		assert.equal(body.data.count, 4);
	});

	it('matches a keyword case-insensitively across title and description', async () => {
		const byTitle = await h.json<PreflightBody>(`${BASE}/jobs/preflight?keyword=MANAGER`);
		assert.equal(byTitle.body.data.count, 1);

		const byDescription = await h.json<PreflightBody>(`${BASE}/jobs/preflight?keyword=kubernetes`);
		assert.equal(byDescription.body.data.count, 1);
	});

	it('counts by track and by level', async () => {
		// detail-1 and detail-bogus-level; detail-2 is manager, detail-legacy unknown.
		const ic = await h.json<PreflightBody>(`${BASE}/jobs/preflight?track=ic`);
		assert.equal(ic.body.data.count, 2);

		const senior = await h.json<PreflightBody>(`${BASE}/jobs/preflight?level=senior`);
		assert.equal(senior.body.data.count, 1);
	});

	it('ignores a level the classifier does not know rather than counting zero', async () => {
		const bogus = await h.json<PreflightBody>(`${BASE}/jobs/preflight?level=archmage`);
		assert.equal(bogus.body.data.count, 4, 'an unrecognised rung adds no clause');
	});

	it('ANDs its filters together', async () => {
		const { body } = await h.json<PreflightBody>(
			`${BASE}/jobs/preflight?keyword=engineer&track=manager`
		);
		assert.equal(body.data.count, 1);

		const none = await h.json<PreflightBody>(
			`${BASE}/jobs/preflight?keyword=kubernetes&track=manager`
		);
		assert.equal(none.body.data.count, 0);
	});

	it('rejects a track outside the enum', async () => {
		const res = await h.fetch(`${BASE}/jobs/preflight?track=wizard`);
		assert.equal(res.status, 400);
	});

	it('is open — no auth required', async () => {
		const res = await h.fetch(`${BASE}/jobs/preflight?keyword=go`);
		assert.equal(res.status, 200);
	});
});
