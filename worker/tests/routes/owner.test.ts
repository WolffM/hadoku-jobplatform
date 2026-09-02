/**
 * Handing an application to someone else, by display NAME.
 *
 * Two properties are load-bearing and both have incident history behind them:
 * a userId in a request body is never trusted (R5 — `{"userId": "hadoku"}` was
 * accepted by hadoku-study on 2026-08-25 and a set belonged to nobody for two
 * days), and the three identity failures mean different things and must not
 * collapse into one status.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, type Harness } from '../helpers/harness.ts';
import { seedJob, seedJobState } from '../helpers/seed.ts';

const BASE = '/jobplatform/api';
const OWNER = 'user-owner';

let h: Harness;

function reassign(id: string, body: unknown, userId = OWNER, tier = 'friend') {
	return h.json<{ success: boolean; data: unknown; message: string; code?: string }>(
		`${BASE}/applications/${id}/owner`,
		{ method: 'POST', tier, userId, body: JSON.stringify(body) }
	);
}

async function seedApplication(id: string, userId = OWNER) {
	await seedJob(h.db, { id: `job-${id}` });
	await seedJobState(h.db, {
		job_id: `job-${id}`,
		user_id: userId,
		state: 'interested',
		variant_slug: 'packet-abc',
	});
	const now = new Date().toISOString();
	await h.db
		.prepare(
			`INSERT INTO applications (id, user_id, job_id, variant_slug, mode, status, created_at, updated_at)
			 VALUES (?, ?, ?, 'packet-abc', 'review', 'filled', ?, ?)`
		)
		.bind(id, userId, `job-${id}`, now, now)
		.run();
}

before(async () => {
	h = await createHarness();
});
after(async () => {
	await h.dispose();
});
beforeEach(async () => {
	for (const t of ['applications', 'job_states', 'jobs', 'application_answers']) {
		await h.db.prepare(`DELETE FROM ${t}`).run();
	}
});

describe('POST /applications/:id/owner', () => {
	it('hands the application over and echoes who got it', async () => {
		await seedApplication('a1');
		const { status, body } = await reassign('a1', { name: 'Hadoku' });
		assert.equal(status, 200);
		// The echo is the point: this is the one change the previous owner
		// cannot undo alone, so they get to see which identity they hit.
		assert.deepEqual(body.data, {
			application_id: 'a1',
			grantedTo: { name: 'Hadoku', tier: 'admin' },
		});
		const row = await h.db
			.prepare('SELECT user_id FROM applications WHERE id = ?')
			.bind('a1')
			.first<{ user_id: string }>();
		assert.equal(row?.user_id, 'user-hadoku');
	});

	it('takes the packet with it', async () => {
		// job_states carries variant_slug — the packet the runner fetches the
		// résumé PDF by. Without it the recipient holds an application that
		// cannot be re-filled or submitted.
		await seedApplication('a2');
		await reassign('a2', { name: 'Hadoku' });
		const state = await h.db
			.prepare('SELECT variant_slug FROM job_states WHERE job_id = ? AND user_id = ?')
			.bind('job-a2', 'user-hadoku')
			.first<{ variant_slug: string }>();
		assert.equal(state?.variant_slug, 'packet-abc');
	});

	it("leaves the previous owner's standing answers alone", async () => {
		// Handing someone a job must not hand them the previous owner's
		// demographic answers. This is a refusal, not an omission.
		await seedApplication('a3');
		const now = new Date().toISOString();
		await h.db
			.prepare(
				`INSERT INTO application_answers (user_id, question_key, question, answer, created_at, updated_at)
				 VALUES (?, 'gender', 'Gender', 'Decline To Self Identify', ?, ?)`
			)
			.bind(OWNER, now, now)
			.run();

		await reassign('a3', { name: 'Hadoku' });

		const moved = await h.db
			.prepare('SELECT COUNT(*) AS n FROM application_answers WHERE user_id = ?')
			.bind('user-hadoku')
			.first<{ n: number }>();
		const kept = await h.db
			.prepare('SELECT COUNT(*) AS n FROM application_answers WHERE user_id = ?')
			.bind(OWNER)
			.first<{ n: number }>();
		assert.equal(moved?.n, 0, 'the recipient must not inherit private answers');
		assert.equal(kept?.n, 1, 'and the owner must not lose them');
	});

	it('you can give one away but not take one', async () => {
		await seedApplication('a4', 'someone-else');
		const { status } = await reassign('a4', { name: 'Hadoku' });
		// Same answer as a row that does not exist, so probing reveals nothing.
		assert.equal(status, 404);
	});

	it('an admin can move a row owned by someone else', async () => {
		// The escape hatch for an application owned by a userId nobody holds a
		// key for any more.
		await seedApplication('a5', 'orphan-user');
		const { status } = await reassign('a5', { name: 'Hadoku' }, 'an-admin', 'admin');
		assert.equal(status, 200);
	});

	it('refuses a userId in the body instead of silently self-claiming', async () => {
		// zod strips unknown keys by default, which would turn an old client's
		// {"userId": …} into an empty body. Strict makes it a 400 that names
		// itself rather than a request that quietly means something else.
		await seedApplication('a6');
		const { status } = await reassign('a6', { userId: 'user-hadoku' });
		assert.equal(status, 400);
	});
});

describe('identity failures stay distinguishable', () => {
	it('a name nobody holds is 404', async () => {
		await seedApplication('b1');
		const { status, body } = await reassign('b1', { name: 'Nobody' });
		assert.equal(status, 404);
		assert.equal(body.code, 'NAME_NOT_FOUND');
	});

	it('a real name that never signed in is 409, not 404', async () => {
		// The name is correct; there is simply no userId to own rows yet.
		// Reporting it as "no such user" sends someone hunting a typo.
		await seedApplication('b2');
		const { status, body } = await reassign('b2', { name: 'Ghost' });
		assert.equal(status, 409);
		assert.equal(body.code, 'NO_USER_ID');
	});

	it('an unreachable resolver is 503 — our fault, and retryable', async () => {
		// The one that must NEVER read as "no such user": it is a deployment
		// failure, the input was fine, and the caller should retry.
		const solo = await createHarness({ edge: null });
		try {
			await seedJob(solo.db, { id: 'job-b3' });
			const now = new Date().toISOString();
			await solo.db
				.prepare(
					`INSERT INTO applications (id, user_id, job_id, variant_slug, mode, status, created_at, updated_at)
					 VALUES ('b3', ?, 'job-b3', 'v', 'review', 'filled', ?, ?)`
				)
				.bind(OWNER, now, now)
				.run();
			const { status, body } = await solo.json<{ code?: string }>(`${BASE}/applications/b3/owner`, {
				method: 'POST',
				tier: 'friend',
				userId: OWNER,
				body: JSON.stringify({ name: 'Hadoku' }),
			});
			assert.equal(status, 503);
			assert.equal(body.code, 'NO_REGISTRY');
		} finally {
			await solo.dispose();
		}
	});
});
