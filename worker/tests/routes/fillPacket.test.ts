import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, type Harness } from '../helpers/harness.ts';
import { seedJob, seedJobState } from '../helpers/seed.ts';

/**
 * The material a form-filler in the owner's own browser needs (2026-10-04):
 * every board flags or code-checks the runner at submit, so the owner submits
 * from their own Chrome and an extension fills the form from these.
 */

const BASE = '/jobplatform/api';
const HADOKU = 'user-hadoku';
const SERVICE = 'the-service';

const PROFILE = {
	name: 'Matthaeus Wolff',
	email: 'matthaeus@hadoku.me',
	phone: '+1 408-372-7884',
	location: 'Bothell, Washington',
	linkedin: 'https://linkedin.com/in/x',
	education: [{ school: 'University of Massachusetts - Amherst', degree: "Bachelor's Degree" }],
	work_experience: [{ company: 'Microsoft', title: 'Software Engineer', current: true }],
	canned: {},
};

let h: Harness;
before(async () => {
	h = await createHarness();
});
after(async () => {
	await h.dispose();
});
beforeEach(async () => {
	for (const t of [
		'applications',
		'job_states',
		'jobs',
		'application_answers',
		'applicant_profiles',
	]) {
		await h.db.prepare(`DELETE FROM ${t}`).run();
	}
});

function req<T>(path: string, init: Record<string, unknown> = {}) {
	return h.json<T & { message: string }>(`${BASE}${path}`, init as never);
}

describe('applicant profile', () => {
	it('round-trips for the signed-in person', async () => {
		const put = await req('/applicant-profile', {
			method: 'PUT',
			tier: 'admin',
			userId: HADOKU,
			body: JSON.stringify({ profile: PROFILE }),
		});
		assert.equal(put.status, 200);
		const got = await req<{ data: { profile: typeof PROFILE } }>('/applicant-profile', {
			tier: 'admin',
			userId: HADOKU,
		});
		assert.deepEqual(got.body.data.profile, PROFILE);
	});

	it("the runner writes the OWNER's profile, not its own", async () => {
		await req('/applicant-profile', {
			method: 'PUT',
			tier: 'service',
			userId: SERVICE,
			body: JSON.stringify({ profile: PROFILE, ownerName: 'Hadoku' }),
		});
		const row = await h.db
			.prepare('SELECT user_id FROM applicant_profiles')
			.first<{ user_id: string }>();
		assert.equal(row?.user_id, HADOKU);
	});

	it('refuses a profile with no name or email', async () => {
		const { status } = await req('/applicant-profile', {
			method: 'PUT',
			tier: 'admin',
			userId: HADOKU,
			body: JSON.stringify({ profile: { name: '' } }),
		});
		assert.equal(status, 400);
	});
});

describe('GET /jobs/:id/fill-packet', () => {
	it('carries the approved answers, the résumé, saved answers and the profile', async () => {
		await seedJob(h.db, { id: 'gh-1', company: 'Instacart', title: 'Senior SWE' });
		await seedJobState(h.db, {
			job_id: 'gh-1',
			user_id: HADOKU,
			state: 'saved',
			variant_slug: 'v-1',
		});
		const now = new Date().toISOString();
		await h.db
			.prepare(
				`INSERT INTO applications (id, user_id, job_id, variant_slug, mode, status, evidence, created_at, updated_at)
				 VALUES ('a1', ?, 'gh-1', 'v-1', 'review', 'approved', ?, ?, ?)`
			)
			.bind(
				HADOKU,
				JSON.stringify({
					answers: { 'are you hispanic latino': 'No' },
					options: { 'are you hispanic latino': ['Yes', 'No'] },
					multi: ['location preference'],
				}),
				now,
				now
			)
			.run();
		await h.db
			.prepare(
				`INSERT INTO application_answers (user_id, question_key, question, answer, created_at, updated_at)
				 VALUES (?, 'what year did you graduate', 'What year did you graduate?', '2016', ?, ?)`
			)
			.bind(HADOKU, now, now)
			.run();
		await req('/applicant-profile', {
			method: 'PUT',
			tier: 'admin',
			userId: HADOKU,
			body: JSON.stringify({ profile: PROFILE }),
		});

		const { status, body } = await req<{
			data: {
				application: { id: string; status: string; variant_slug: string };
				answers: Record<string, string>;
				multi: string[];
				standing: Record<string, string>;
				profile: typeof PROFILE;
				resume_pdf_url: string;
			};
		}>('/jobs/gh-1/fill-packet', { tier: 'admin', userId: HADOKU });
		assert.equal(status, 200);
		const d = body.data;
		assert.deepEqual(d.application, { id: 'a1', status: 'approved', variant_slug: 'v-1' });
		assert.deepEqual(d.answers, { 'are you hispanic latino': 'No' });
		assert.deepEqual(d.multi, ['location preference']);
		assert.equal(d.standing['What year did you graduate?'], '2016');
		assert.equal(d.profile.email, PROFILE.email);
		assert.equal(d.resume_pdf_url, 'https://hadoku.me/resume/api/resume.pdf?v=v-1');
	});

	it("does not hand one person another's application", async () => {
		await seedJob(h.db, { id: 'gh-2', company: 'Toast', title: 'SWE' });
		const now = new Date().toISOString();
		await h.db
			.prepare(
				`INSERT INTO applications (id, user_id, job_id, variant_slug, mode, status, evidence, created_at, updated_at)
				 VALUES ('a2', ?, 'gh-2', 'v-2', 'review', 'approved', '{"answers":{"q":"secret"}}', ?, ?)`
			)
			.bind(HADOKU, now, now)
			.run();
		const { body } = await req<{
			data: { application: unknown; answers: Record<string, string>; resume_pdf_url: unknown };
		}>('/jobs/gh-2/fill-packet', { tier: 'friend', userId: 'someone-else' });
		assert.equal(body.data.application, null);
		assert.deepEqual(body.data.answers, {});
		assert.equal(body.data.resume_pdf_url, null);
	});

	it('404s an unknown job', async () => {
		const { status } = await req('/jobs/nope/fill-packet', { tier: 'admin', userId: HADOKU });
		assert.equal(status, 404);
	});
});
