/**
 * Saving a changed résumé (pasted text or the work history it is composed
 * from) or changed contact details on the applicant profile replaces that
 * person's résumé at resume-api (blocks/import with replace), behind the
 * response, so the next tailored résumé reads what they just saved.
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BASE, createHarness, type Harness } from '../helpers/harness.ts';

const ROBIN = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
let h: Harness;

before(async () => {
	h = await createHarness();
});
beforeEach(async () => {
	h.resume.reset();
	await h.db.prepare('DELETE FROM applicant_profiles').run();
	await h.settle();
	h.telemetry.length = 0;
});
after(async () => {
	await h.dispose();
});

const put = (profile: unknown, userId = ROBIN) =>
	h.json(`${BASE}/applicant-profile`, {
		method: 'PUT',
		tier: 'friend',
		userId,
		body: JSON.stringify({ profile }),
	});

const base = { name: 'Robin Quillfeather', email: 'robin.q@example.org' };
const imports = () => h.resume.calls.filter((c) => c.path === '/resume/api/blocks/import');

describe('PUT /applicant-profile and resume-api', () => {
	it('new résumé text is imported for that person, replacing what was there', async () => {
		assert.equal((await put({ ...base, master_resume_text: '# Robin\n\nv1' })).status, 200);
		assert.ok((await h.settle()) >= 1, 'the reseed ran behind the response');
		assert.equal(imports().length, 1);
		const body = imports()[0].body;
		assert.equal(body.on_behalf_of_user_id, ROBIN);
		assert.equal(body.resume_text, '# Robin\n\nv1');
		assert.equal(body.replace, true);
		assert.equal((body.contact as { name: string }).name, 'Robin Quillfeather');
	});

	it('changed text is imported again; an unchanged save and unrelated edits are not', async () => {
		await put({ ...base, master_resume_text: 'v1 text' });
		await h.settle();
		await put({ ...base, master_resume_text: 'v1 text' });
		await h.settle();
		assert.equal(imports().length, 1, 'same profile, no import');
		await put({ ...base, portfolio: 'https://robin.example.org', master_resume_text: 'v1 text' });
		await h.settle();
		assert.equal(imports().length, 1, 'a field that is neither résumé nor contact, no import');
		await put({ ...base, portfolio: 'https://robin.example.org', master_resume_text: 'v2 text' });
		await h.settle();
		assert.equal(imports().length, 2);
		assert.equal(imports()[1].body.resume_text, 'v2 text');
	});

	it('changed contact details are imported, so packets stop carrying the old ones', async () => {
		await put({ ...base, master_resume_text: 'v1 text' });
		await h.settle();
		await put({ ...base, phone: '+49 30 5550 1234', master_resume_text: 'v1 text' });
		await h.settle();
		assert.equal(imports().length, 2);
		const body = imports()[1].body;
		assert.equal(body.resume_text, 'v1 text');
		assert.equal(body.replace, true);
		assert.equal((body.contact as { phone: string }).phone, '+49 30 5550 1234');
	});

	it('edits to the work history a résumé is composed from are imported', async () => {
		const job = (title: string) => ({
			work_experience: [{ company: 'Initech', title, start_year: '2020' }],
		});
		await put({ ...base, ...job('Analyst') });
		await h.settle();
		assert.equal(imports().length, 1, 'a composed résumé is seeded on save');
		await put({ ...base, ...job('Senior Analyst') });
		await h.settle();
		assert.equal(imports().length, 2);
		assert.match(String(imports()[1].body.resume_text), /Senior Analyst/);
	});

	it('clearing the pasted text falls back to the composed résumé', async () => {
		const job = { work_experience: [{ company: 'Initech', title: 'Analyst', start_year: '2020' }] };
		await put({ ...base, ...job, master_resume_text: 'pasted text' });
		await h.settle();
		await put({ ...base, ...job });
		await h.settle();
		assert.equal(imports().length, 2);
		assert.match(String(imports()[1].body.resume_text), /Initech/);
		assert.doesNotMatch(String(imports()[1].body.resume_text), /pasted text/);
	});

	it('a profile without résumé text sends nothing', async () => {
		await put(base);
		await h.settle();
		assert.equal(imports().length, 0);
	});

	it("the owner's curated résumé (OWNER_SET) is not a failure", async () => {
		h.resume.enqueue('/resume/api/blocks/import', 403, {
			error: "The owner's blocks are edited through /builder, not /blocks.",
			code: 'OWNER_SET',
		});
		await put({ ...base, master_resume_text: 'owner text' });
		await h.settle();
		const failures = h.telemetry.filter((t) => JSON.stringify(t).includes('background_failed'));
		assert.deepEqual(failures, []);
	});

	it('a resume-api without per-user résumés yet (404) is not reported as a failure', async () => {
		h.resume.enqueue('/resume/api/blocks/import', 404, { error: 'Not found' });
		const res = await put({ ...base, master_resume_text: 'text' });
		assert.equal(res.status, 200);
		await h.settle();
		const failures = h.telemetry.filter((t) => JSON.stringify(t).includes('background_failed'));
		assert.deepEqual(failures, []);
	});

	it('a 403 that is not OWNER_SET is reported', async () => {
		h.resume.enqueue('/resume/api/blocks/import', 403, { error: 'Forbidden', hint: 'OWNER_SET' });
		await put({ ...base, master_resume_text: 'text' });
		await h.settle();
		const failures = h.telemetry.filter((t) => JSON.stringify(t).includes('background_failed'));
		assert.equal(failures.length, 1);
	});

	it('any other resume-api failure is reported, and the save still succeeded', async () => {
		h.resume.enqueue('/resume/api/blocks/import', 500, { error: 'boom' });
		const res = await put({ ...base, master_resume_text: 'text' });
		assert.equal(res.status, 200);
		await h.settle();
		const failures = h.telemetry.filter((t) => JSON.stringify(t).includes('background_failed'));
		assert.equal(failures.length, 1);
		assert.match(JSON.stringify(failures[0]), /resume-api reseed 500/);
	});
});
