/**
 * Tailoring is for the person asking, never the site owner by default.
 *
 * resume-api keeps résumé content per user and builds from the user named in
 * `on_behalf_of_user_id`. These tests pin that every tailoring route names the
 * right person (the caller, or the owner the runner names), that a person with
 * no content yet is seeded once from their own applicant profile, and that a
 * person with nothing to seed from is told so instead of getting a résumé.
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BASE, createHarness, type Harness } from '../helpers/harness.ts';
import { seedJob } from '../helpers/seed.ts';

let h: Harness;

before(async () => {
	h = await createHarness();
	await seedJob(h.db, {
		id: 'pu-1',
		title: 'Delivery Manager',
		company: 'Initech',
		description: 'Lead delivery.',
		location: 'Berlin, DE',
		workplace_type: 'hybrid',
	});
});

beforeEach(async () => {
	h.resume.reset();
	await h.db.prepare('DELETE FROM applicant_profiles').run();
	await h.db.prepare('DELETE FROM job_states').run();
});

after(async () => {
	await h.dispose();
});

const NO_BLOCKS = { error: 'No resume blocks for this user.', code: 'NO_RESUME_BLOCKS' };
const NO_CONTACT = { error: 'Contact profile not configured.', code: 'NO_CONTACT_PROFILE' };

async function saveProfile(userId: string, profile: Record<string, unknown>) {
	await h.db
		.prepare('INSERT INTO applicant_profiles (user_id, profile, updated_at) VALUES (?, ?, ?)')
		.bind(userId, JSON.stringify(profile), '2026-11-27T00:00:00.000Z')
		.run();
}

function post(path: string, userId: string, body: Record<string, unknown> = {}) {
	return h.json<{
		success: boolean;
		code?: string;
		message?: string;
		data?: Record<string, unknown>;
	}>(`${BASE}${path}`, { method: 'POST', tier: 'friend', userId, body: JSON.stringify(body) });
}

describe('every tailoring call names the person it is for', () => {
	for (const [route, upstream, body] of [
		['/jobs/pu-1/resume', '/resume/api/tailored-resume', {}],
		['/jobs/pu-1/cover-letter', '/resume/api/cover-letter', {}],
		['/jobs/pu-1/application-extras', '/resume/api/application-extras', { resume_markdown: '# R' }],
		['/jobs/pu-1/packet-link', '/resume/api/variants', { resume_markdown: '# R' }],
	] as const) {
		it(`${route} sends the caller's user id`, async () => {
			const a = await post(route, 'user-a', body);
			const b = await post(route, 'user-b', body);
			assert.equal(a.status, 200);
			assert.equal(b.status, 200);
			const sent = h.resume.calls
				.filter((c) => c.path === upstream)
				.map((c) => c.body.on_behalf_of_user_id);
			assert.deepEqual(sent, ['user-a', 'user-b']);
		});
	}

	it("the apply runner naming the owner tailors the owner's résumé", async () => {
		const res = await h.json(`${BASE}/jobs/pu-1/resume`, {
			method: 'POST',
			tier: 'service',
			userId: 'the-service',
			body: JSON.stringify({ ownerName: 'Hadoku' }),
		});
		assert.equal(res.status, 200);
		assert.equal(h.resume.calls.at(-1)?.body.on_behalf_of_user_id, 'user-hadoku');
	});

	it('a friend naming someone else is refused before resume-api is called', async () => {
		const res = await post('/jobs/pu-1/resume', 'user-a', { ownerName: 'Hadoku' });
		assert.equal(res.status, 403);
		assert.equal(h.resume.calls.length, 0);
	});
});

describe('seeding a person resume-api has no content for', () => {
	it('imports their master résumé text, then retries', async () => {
		await saveProfile('user-a', {
			name: 'Robin Quillfeather',
			email: 'robin.q@example.org',
			phone: '+49 30 5550 1234',
			location: 'Leipzig, Germany',
			work_authorization: 'EU citizen',
			desired_salary: '70k EUR',
			master_resume_text:
				'# Robin Quillfeather\n\n## Experience\n\n### Delivery Lead - 2022 - present',
		});
		h.resume.enqueue('/resume/api/tailored-resume', 409, NO_BLOCKS);

		const res = await post('/jobs/pu-1/resume', 'user-a');
		assert.equal(res.status, 200);
		assert.deepEqual(
			h.resume.calls.map((c) => c.path),
			['/resume/api/tailored-resume', '/resume/api/blocks/import', '/resume/api/tailored-resume']
		);
		const seed = h.resume.calls[1].body;
		assert.equal(seed.on_behalf_of_user_id, 'user-a');
		assert.match(String(seed.resume_text), /^# Robin Quillfeather/);
		assert.deepEqual(seed.contact, {
			name: 'Robin Quillfeather',
			email: 'robin.q@example.org',
			phone: '+49 30 5550 1234',
			linkedin: '',
			github: '',
			location: 'Leipzig, Germany',
			work_auth: 'EU citizen',
			relocation: '',
			salary_line: '70k EUR',
		});
		assert.equal(h.resume.calls[2].body.on_behalf_of_user_id, 'user-a');
	});

	it('composes a résumé from the structured fields when there is no master text', async () => {
		await saveProfile('user-a', {
			name: 'Robin Quillfeather',
			email: 'robin.q@example.org',
			summary: 'Delivery lead.',
			work_experience: [
				{
					company: 'Nimbus Lanterns',
					title: 'Delivery Lead',
					start_month: 3,
					start_year: 2022,
					current: true,
				},
			],
			education: [
				{ school: 'Example University', degree: 'MA', discipline: 'Media Studies', end_year: 2018 },
			],
		});
		h.resume.enqueue('/resume/api/cover-letter', 409, NO_BLOCKS);

		const res = await post('/jobs/pu-1/cover-letter', 'user-a');
		assert.equal(res.status, 200);
		const text = String(h.resume.calls[1].body.resume_text);
		assert.match(text, /^# Robin Quillfeather\n\nrobin\.q@example\.org/);
		assert.match(text, /### Delivery Lead - 03\/2022 - present\n\*\*Nimbus Lanterns\*\*/);
		assert.match(text, /- MA, Media Studies, Example University, 2018/);
	});

	it("without an applicant profile the UI gets a clear 409, never anyone else's résumé", async () => {
		h.resume.enqueue('/resume/api/tailored-resume', 409, NO_BLOCKS);
		const res = await post('/jobs/pu-1/resume', 'user-a');
		assert.equal(res.status, 409);
		assert.equal(res.body.success, false);
		assert.equal(res.body.code, 'NO_RESUME_BLOCKS');
		assert.match(res.body.message ?? '', /Résumé box on the Profile page/);
		assert.deepEqual(
			h.resume.calls.map((c) => c.path),
			['/resume/api/tailored-resume']
		);
	});

	it('a profile with only a name and email is not enough to seed', async () => {
		await saveProfile('user-a', { name: 'Robin', email: 'robin.q@example.org' });
		h.resume.enqueue('/resume/api/tailored-resume', 409, NO_BLOCKS);
		const res = await post('/jobs/pu-1/resume', 'user-a');
		assert.equal(res.status, 409);
		assert.equal(h.resume.calls.length, 1);
	});

	it('stops after one seed when resume-api still reports nothing', async () => {
		await saveProfile('user-a', {
			name: 'Robin',
			email: 'r@example.org',
			master_resume_text: 'Robin\n\nDid things.',
		});
		h.resume.enqueue('/resume/api/tailored-resume', 409, NO_BLOCKS);
		h.resume.enqueue('/resume/api/tailored-resume', 409, NO_BLOCKS);
		const res = await post('/jobs/pu-1/resume', 'user-a');
		assert.equal(res.status, 409);
		assert.equal(res.body.code, 'NO_RESUME_BLOCKS');
		assert.equal(h.resume.calls.length, 3);
	});

	it('stores the contact profile when the kit needs one', async () => {
		await saveProfile('user-a', { name: 'Robin Quillfeather', email: 'robin.q@example.org' });
		h.resume.enqueue('/resume/api/application-extras', 409, NO_CONTACT);
		const res = await post('/jobs/pu-1/application-extras', 'user-a', { resume_markdown: '# R' });
		assert.equal(res.status, 200);
		const put = h.resume.calls[1];
		assert.equal(put.path, '/resume/api/contact-profile');
		assert.equal(put.method, 'PUT');
		assert.equal(put.body.on_behalf_of_user_id, 'user-a');
		assert.equal((put.body.contact as { name: string }).name, 'Robin Quillfeather');
	});

	it("seeds from the caller's own profile, not another user's", async () => {
		await saveProfile('user-b', {
			name: 'Sam',
			email: 's@example.org',
			master_resume_text: 'Sam\n\nB things.',
		});
		h.resume.enqueue('/resume/api/tailored-resume', 409, NO_BLOCKS);
		const res = await post('/jobs/pu-1/resume', 'user-a');
		assert.equal(res.status, 409, 'user-a has no profile, so nothing is seeded');
		assert.equal(h.resume.calls.length, 1);
	});

	it('an unrelated upstream 409 passes through as an upstream error, without seeding', async () => {
		h.resume.enqueue('/resume/api/variants', 409, { error: "Variant slug 'x' is already taken" });
		const res = await post('/jobs/pu-1/packet-link', 'user-a', { resume_markdown: '# R' });
		assert.equal(res.status, 502);
		assert.equal(h.resume.calls.length, 1);
	});
});
