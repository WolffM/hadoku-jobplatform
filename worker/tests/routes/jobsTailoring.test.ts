/**
 * POST /jobs/{id}/{resume,cover-letter,application-extras,packet-link} — V3.
 *
 * These proxy to resume-api over the RESUME service binding. The harness binds a
 * real HTTP server in resume-api's place, so the request genuinely leaves the
 * worker and the assertions are on the payload that actually went over the
 * wire — including the X-Edge-Auth / X-Hadoku-Tier stamping the far side's gate
 * depends on.
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BASE, EDGE_SECRET, createHarness, type Harness } from '../helpers/harness.ts';
import { seedJob } from '../helpers/seed.ts';

let h: Harness;

before(async () => {
	h = await createHarness();
	await seedJob(h.db, {
		id: 'tailor-1',
		title: 'Senior Software Engineer',
		company: 'Acme',
		description: 'Distributed systems in Go.',
		location: 'Berlin, DE',
		workplace_type: 'hybrid',
	});
});

beforeEach(() => {
	h.resume.reset();
});

after(async () => {
	await h.dispose();
});

const AUTH = { tier: 'friend' as const };

describe('POST /jobs/{id}/resume', () => {
	it('403s without auth', async () => {
		const res = await h.fetch(`${BASE}/jobs/tailor-1/resume`, { method: 'POST' });
		assert.equal(res.status, 403);
	});

	it('404s before calling resume-api when the job is unknown', async () => {
		const before = h.resume.calls.length;
		const { status } = await h.json(`${BASE}/jobs/ghost/resume`, { method: 'POST', ...AUTH });
		assert.equal(status, 404);
		assert.equal(h.resume.calls.length, before, 'no upstream call for a missing job');
	});

	it('proxies the job fields and returns the upstream payload', async () => {
		const { status, body } = await h.json<{ success: boolean; data: { resume_markdown: string } }>(
			`${BASE}/jobs/tailor-1/resume`,
			{ method: 'POST', ...AUTH, body: JSON.stringify({}) }
		);
		assert.equal(status, 200);
		assert.equal(body.data.resume_markdown, '# Test Resume');

		const call = h.resume.calls.at(-1);
		assert.ok(call);
		assert.equal(call.path, '/resume/api/tailored-resume');
		assert.equal(call.body.job_title, 'Senior Software Engineer');
		assert.equal(call.body.company, 'Acme');
		assert.equal(call.body.description, 'Distributed systems in Go.');
	});

	it('stamps the service-tier provenance headers the far-side gate needs', async () => {
		await h.json(`${BASE}/jobs/tailor-1/resume`, { method: 'POST', ...AUTH });
		const call = h.resume.calls.at(-1);
		assert.equal(call?.headers['x-edge-auth'], EDGE_SECRET);
		assert.equal(call?.headers['x-hadoku-tier'], 'service');
	});

	it('tolerates an absent body — every option is optional', async () => {
		const { status } = await h.json(`${BASE}/jobs/tailor-1/resume`, { method: 'POST', ...AUTH });
		assert.equal(status, 200);
	});

	it('forwards only well-typed options and drops the rest', async () => {
		await h.json(`${BASE}/jobs/tailor-1/resume`, {
			method: 'POST',
			...AUTH,
			body: JSON.stringify({ profile_type: 'ml', tailor: false, nonsense: 'x', tailor2: 1 }),
		});
		const call = h.resume.calls.at(-1);
		assert.equal(call?.body.profile_type, 'ml');
		assert.equal(call?.body.tailor, false);
		assert.ok(!('nonsense' in (call?.body ?? {})));

		await h.json(`${BASE}/jobs/tailor-1/resume`, {
			method: 'POST',
			...AUTH,
			body: JSON.stringify({ profile_type: 42, tailor: 'yes' }),
		});
		const wrongTypes = h.resume.calls.at(-1);
		assert.ok(
			!('profile_type' in (wrongTypes?.body ?? {})),
			'a non-string profile_type is dropped'
		);
		assert.ok(!('tailor' in (wrongTypes?.body ?? {})), 'a non-boolean tailor is dropped');
	});
});

describe('POST /jobs/{id}/cover-letter', () => {
	it('403s without auth', async () => {
		const res = await h.fetch(`${BASE}/jobs/tailor-1/cover-letter`, { method: 'POST' });
		assert.equal(res.status, 403);
	});

	it('proxies to the cover-letter path and returns its payload', async () => {
		const { status, body } = await h.json<{
			success: boolean;
			data: { cover_letter_markdown: string };
		}>(`${BASE}/jobs/tailor-1/cover-letter`, { method: 'POST', ...AUTH });
		assert.equal(status, 200);
		assert.equal(body.data.cover_letter_markdown, '# Test Cover Letter');
		assert.equal(h.resume.calls.at(-1)?.path, '/resume/api/cover-letter');
	});

	it('forwards only a recognised tone', async () => {
		await h.json(`${BASE}/jobs/tailor-1/cover-letter`, {
			method: 'POST',
			...AUTH,
			body: JSON.stringify({ tone: 'formal' }),
		});
		assert.equal(h.resume.calls.at(-1)?.body.tone, 'formal');

		await h.json(`${BASE}/jobs/tailor-1/cover-letter`, {
			method: 'POST',
			...AUTH,
			body: JSON.stringify({ tone: 'sarcastic' }),
		});
		assert.ok(!('tone' in (h.resume.calls.at(-1)?.body ?? {})));
	});

	it('404s a missing job', async () => {
		const { status } = await h.json(`${BASE}/jobs/ghost/cover-letter`, { method: 'POST', ...AUTH });
		assert.equal(status, 404);
	});
});

describe('POST /jobs/{id}/application-extras', () => {
	it('403s without auth', async () => {
		const res = await h.fetch(`${BASE}/jobs/tailor-1/application-extras`, { method: 'POST' });
		assert.equal(res.status, 403);
	});

	it('400s without resume_markdown', async () => {
		const { status, body } = await h.json<{ success: boolean; message: string }>(
			`${BASE}/jobs/tailor-1/application-extras`,
			{ method: 'POST', ...AUTH, body: JSON.stringify({}) }
		);
		assert.equal(status, 400);
		assert.match(body.message, /resume_markdown/);
	});

	it("sends this job's location and workplace type, not a candidate default", async () => {
		const { status } = await h.json(`${BASE}/jobs/tailor-1/application-extras`, {
			method: 'POST',
			...AUTH,
			body: JSON.stringify({ resume_markdown: '# R' }),
		});
		assert.equal(status, 200);
		const call = h.resume.calls.at(-1);
		assert.equal(call?.path, '/resume/api/application-extras');
		assert.equal(call?.body.resume_markdown, '# R');
		assert.equal(call?.body.job_location, 'Berlin, DE');
		assert.equal(call?.body.workplace_type, 'hybrid');
	});

	it('404s a missing job', async () => {
		const { status } = await h.json(`${BASE}/jobs/ghost/application-extras`, {
			method: 'POST',
			...AUTH,
			body: JSON.stringify({ resume_markdown: '# R' }),
		});
		assert.equal(status, 404);
	});
});

describe('POST /jobs/{id}/packet-link', () => {
	it('403s without auth', async () => {
		const res = await h.fetch(`${BASE}/jobs/tailor-1/packet-link`, { method: 'POST' });
		assert.equal(res.status, 403);
	});

	it('400s without resume_markdown', async () => {
		const { status } = await h.json(`${BASE}/jobs/tailor-1/packet-link`, {
			method: 'POST',
			...AUTH,
			body: JSON.stringify({}),
		});
		assert.equal(status, 400);
	});

	it('mints a variant from pre-rendered markdown and returns the public link', async () => {
		const { status, body } = await h.json<{
			success: boolean;
			data: { slug: string; url: string };
		}>(`${BASE}/jobs/tailor-1/packet-link`, {
			method: 'POST',
			...AUTH,
			body: JSON.stringify({ resume_markdown: '# R', cover_letter_markdown: '# CL' }),
		});
		assert.equal(status, 200);
		assert.equal(body.data.slug, 'abc123');
		assert.equal(body.data.url, 'https://hadoku.me/resume?v=abc123');

		const call = h.resume.calls.at(-1);
		assert.equal(call?.path, '/resume/api/variants');
		assert.equal(call?.body.label, 'Acme — Senior Software Engineer');
		assert.equal(call?.body.markdown, '# R');
		assert.equal(call?.body.cover_letter_markdown, '# CL');
		assert.equal(call?.body.ttl_days, 365, 'default retention');
	});

	it('records the slug on job_states at mint — the Packets view must find it', async () => {
		await h.json(`${BASE}/jobs/tailor-1/packet-link`, {
			method: 'POST',
			...AUTH,
			body: JSON.stringify({ resume_markdown: '# R' }),
		});
		const row = await h.db
			.prepare('SELECT state, variant_slug FROM job_states WHERE job_id = ?')
			.bind('tailor-1')
			.first<{ state: string; variant_slug: string | null }>();
		assert.equal(row?.variant_slug, 'abc123', 'mint persists the slug without a state click');
		assert.equal(row?.state, 'saved', 'fresh row lands as saved');
	});

	it('honours an explicit ttl_days', async () => {
		await h.json(`${BASE}/jobs/tailor-1/packet-link`, {
			method: 'POST',
			...AUTH,
			body: JSON.stringify({ resume_markdown: '# R', ttl_days: 7 }),
		});
		assert.equal(h.resume.calls.at(-1)?.body.ttl_days, 7);
	});

	it('omits cover_letter_markdown when none is supplied', async () => {
		await h.json(`${BASE}/jobs/tailor-1/packet-link`, {
			method: 'POST',
			...AUTH,
			body: JSON.stringify({ resume_markdown: '# R' }),
		});
		assert.ok(!('cover_letter_markdown' in (h.resume.calls.at(-1)?.body ?? {})));
	});

	it('percent-encodes the slug into the link', async () => {
		h.resume.respondWith(200, { slug: 'a b/c' });
		const { body } = await h.json<{ data: { url: string } }>(`${BASE}/jobs/tailor-1/packet-link`, {
			method: 'POST',
			...AUTH,
			body: JSON.stringify({ resume_markdown: '# R' }),
		});
		assert.equal(body.data.url, 'https://hadoku.me/resume?v=a%20b%2Fc');
	});

	it('502s when resume-api returns no slug', async () => {
		h.resume.respondWith(200, { not_a_slug: true });
		const { status, body } = await h.json<{ success: boolean; message: string }>(
			`${BASE}/jobs/tailor-1/packet-link`,
			{ method: 'POST', ...AUTH, body: JSON.stringify({ resume_markdown: '# R' }) }
		);
		assert.equal(status, 502);
		assert.match(body.message, /no slug/);
	});
});

describe('resume-api failures surface as 502, not 500', () => {
	for (const [label, path, body] of [
		['resume', 'resume', {}],
		['cover-letter', 'cover-letter', {}],
		['application-extras', 'application-extras', { resume_markdown: '# R' }],
		['packet-link', 'packet-link', { resume_markdown: '# R' }],
	] as const) {
		it(`maps an upstream error on ${label}`, async () => {
			h.resume.respondWith(503, 'upstream exploded');
			const res = await h.json<{ success: boolean; error: string; message: string }>(
				`${BASE}/jobs/tailor-1/${path}`,
				{ method: 'POST', ...AUTH, body: JSON.stringify(body) }
			);
			assert.equal(res.status, 502);
			assert.equal(res.body.success, false);
			assert.equal(res.body.error, 'Upstream error');
			assert.match(res.body.message, /resume-api 503/);
		});
	}
});

describe('the binding being unconfigured is an error, not a silent skip', () => {
	it('fails loudly when RESUME is missing', async () => {
		const bare = await createHarness({ withoutResumeBinding: true });
		try {
			await seedJob(bare.db, { id: 'no-binding' });
			const res = await bare.fetch(`${BASE}/jobs/no-binding/resume`, {
				method: 'POST',
				tier: 'friend',
			});
			assert.equal(res.status, 500, 'an unconfigured binding must not look like success');
		} finally {
			await bare.dispose();
		}
	});
});
