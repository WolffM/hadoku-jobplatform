/**
 * GET/PUT /applicant-profile carry the form facts JobPulse's profile had:
 * work authorization, desired salary, notice period and the résumé as text.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BASE, createHarness, type Harness } from '../helpers/harness.ts';

const ALICE = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
let h: Harness;

before(async () => {
	h = await createHarness();
});
after(async () => {
	await h.dispose();
});

const put = (profile: unknown) =>
	h.json<{ message?: string }>(`${BASE}/applicant-profile`, {
		method: 'PUT',
		tier: 'friend',
		userId: ALICE,
		body: JSON.stringify({ profile }),
	});

const base = { name: 'Alice Example', email: 'alice@example.com' };

describe('/applicant-profile form facts', () => {
	it('round-trips work_authorization, desired_salary, notice_period and master_resume_text', async () => {
		const facts = {
			work_authorization: 'US citizen; no sponsorship needed',
			desired_salary: '$180,000',
			notice_period: '2 weeks',
			master_resume_text: 'Alice Example\nStaff engineer…',
		};
		assert.equal((await put({ ...base, ...facts })).status, 200);
		const got = await h.json<{ data: { profile: Record<string, unknown> } }>(
			`${BASE}/applicant-profile`,
			{
				tier: 'friend',
				userId: ALICE,
			}
		);
		assert.deepEqual(got.body.data.profile, { ...base, ...facts });
	});

	it('400s a fact that is not text, or too long', async () => {
		const bad = await put({ ...base, notice_period: 14 });
		assert.equal(bad.status, 400);
		assert.match(bad.body.message ?? '', /notice_period must be a string/);
		const long = await put({ ...base, desired_salary: 'x'.repeat(101) });
		assert.equal(long.status, 400);
		assert.match(long.body.message ?? '', /desired_salary is longer than 100/);
	});

	it('still takes a profile without them', async () => {
		assert.equal((await put(base)).status, 200);
	});
});
