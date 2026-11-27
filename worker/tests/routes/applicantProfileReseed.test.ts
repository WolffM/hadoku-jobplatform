/**
 * Saving new résumé text on the applicant profile replaces that person's
 * résumé at resume-api (blocks/import with replace), behind the response, so
 * the next tailored résumé reads what they just saved.
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

	it('changed text is imported again; unchanged text and other edits are not', async () => {
		await put({ ...base, master_resume_text: 'v1 text' });
		await h.settle();
		await put({ ...base, phone: '+49 30 5550 1234', master_resume_text: 'v1 text' });
		await h.settle();
		assert.equal(imports().length, 1, 'same text, no import');
		await put({ ...base, master_resume_text: 'v2 text' });
		await h.settle();
		assert.equal(imports().length, 2);
		assert.equal(imports()[1].body.resume_text, 'v2 text');
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
