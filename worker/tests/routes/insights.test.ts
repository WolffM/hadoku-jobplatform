/**
 * GET /insights — counted from the timeline, the apply queue and the state, so
 * these seed all three and check that each one is heard from.
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BASE, createHarness, type Harness } from '../helpers/harness.ts';
import { seedJob, seedJobState, seedProfile } from '../helpers/seed.ts';
import { weekOf } from '../../src/routes/jobs/insights.ts';

const ALICE = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const BOB = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

interface Insights {
	states: Record<string, number>;
	reached: { applied: number; responded: number; interviewed: number; offered: number };
	rates: { response: number | null; interview: number | null; offer: number | null };
	weekly_applied: { week: string; count: number }[];
	workplace: { workplace_type: string; count: number }[];
	skills: { skill: string; postings: number; in_stack: boolean }[];
	skill_postings: number;
}

let h: Harness;

before(async () => {
	h = await createHarness();
	await seedJob(h.db, {
		id: 'i-1',
		workplace_type: 'remote',
		description: 'Python and Kubernetes',
	});
	await seedJob(h.db, {
		id: 'i-2',
		workplace_type: 'hybrid',
		description: '<p>Python, Go, AWS</p>',
	});
	await seedJob(h.db, { id: 'i-3', workplace_type: 'remote', description: 'React' });
	await seedJob(h.db, { id: 'i-4', workplace_type: 'onsite', description: 'Rust everywhere' });
	await seedJob(h.db, { id: 'i-5', workplace_type: 'remote', description: 'Python' });
	await seedProfile(h.db, { id: 'ip', user_id: ALICE });
	await h.db.prepare(`UPDATE profiles SET stack = '["Python", "k8s"]' WHERE id = 'ip'`).run();
});

beforeEach(async () => {
	for (const t of ['job_events', 'job_states', 'applications']) {
		await h.db.prepare(`DELETE FROM ${t}`).run();
	}
});

after(async () => {
	await h.dispose();
});

const insights = (userId = ALICE) =>
	h.json<{ data: Insights }>(`${BASE}/insights`, { tier: 'friend', userId });
const setState = (id: string, state: string, userId = ALICE) =>
	h.json(`${BASE}/jobs/${id}/state`, {
		method: 'PUT',
		tier: 'friend',
		userId,
		body: JSON.stringify({ state }),
	});

describe('GET /insights', () => {
	it('403s an unauthenticated caller', async () => {
		assert.equal((await h.fetch(`${BASE}/insights`)).status, 403);
	});

	it('answers zeros and null rates for someone who has applied to nothing', async () => {
		const { status, body } = await insights();
		assert.equal(status, 200);
		assert.deepEqual(body.data.reached, { applied: 0, responded: 0, interviewed: 0, offered: 0 });
		assert.deepEqual(body.data.rates, { response: null, interview: null, offer: null });
		assert.equal(body.data.weekly_applied.length, 12);
		assert.ok(body.data.weekly_applied.every((w) => w.count === 0));
	});

	it('counts a stage reached even after the posting moved on, from the timeline', async () => {
		await setState('i-1', 'applied');
		await setState('i-1', 'interviewing');
		await setState('i-1', 'rejected'); // interviewed, then turned down
		await setState('i-2', 'applied');
		await setState('i-3', 'saved');
		const { body } = await insights();
		assert.deepEqual(body.data.reached, { applied: 2, responded: 1, interviewed: 1, offered: 0 });
		assert.deepEqual(body.data.rates, { response: 0.5, interview: 0.5, offer: 0 });
		assert.deepEqual(body.data.states, { rejected: 1, applied: 1, saved: 1 });
	});

	it("counts the runner's submitted applications, which never write a state", async () => {
		await seedJobState(h.db, { job_id: 'i-4', user_id: ALICE, state: 'saved' });
		const now = new Date().toISOString();
		await h.db
			.prepare(
				`INSERT INTO applications (id, user_id, job_id, variant_slug, mode, status, created_at, updated_at)
				 VALUES ('ia', ?, 'i-4', 's', 'review', 'submitted', ?, ?)`
			)
			.bind(ALICE, now, now)
			.run();
		const { body } = await insights();
		assert.equal(body.data.reached.applied, 1);
		assert.deepEqual(body.data.workplace, [{ workplace_type: 'onsite', count: 1 }]);
		assert.equal(body.data.weekly_applied.at(-1)?.count, 1, 'dated by the submission');
	});

	it('counts a pre-timeline state by the state itself, dated by its own timestamp', async () => {
		// Marked 'interviewing' before migration 0028: no event says when.
		await seedJobState(h.db, { job_id: 'i-5', user_id: ALICE, state: 'interviewing' });
		const { body } = await insights();
		assert.equal(body.data.reached.interviewed, 1);
		assert.equal(body.data.reached.applied, 1);
	});

	it("puts this week's applications in the last bucket", async () => {
		await setState('i-1', 'applied');
		await setState('i-2', 'applied');
		const { body } = await insights();
		const last = body.data.weekly_applied.at(-1)!;
		assert.equal(last.week, weekOf(new Date().toISOString()));
		assert.equal(last.count, 2);
	});

	it("ranks skill demand over the pipeline, flags the caller's stack, and skips dismissed postings", async () => {
		await setState('i-1', 'applied');
		await setState('i-2', 'saved');
		await setState('i-4', 'dismissed');
		const { body } = await insights();
		assert.equal(body.data.skill_postings, 2);
		assert.deepEqual(body.data.skills, [
			{ skill: 'python', postings: 2, in_stack: true },
			{ skill: 'aws', postings: 1, in_stack: false },
			{ skill: 'go', postings: 1, in_stack: false },
			{ skill: 'kubernetes', postings: 1, in_stack: true },
		]);
		assert.equal(body.data.states.dismissed, 1, 'still counted as a state');
	});

	it('is per person', async () => {
		await setState('i-1', 'applied', BOB);
		assert.equal((await insights()).body.data.reached.applied, 0);
	});
});

describe('weekOf', () => {
	it('is the Monday of the UTC week', () => {
		assert.equal(weekOf('2026-11-06T12:00:00Z'), '2026-11-02'); // a Friday
		assert.equal(weekOf('2026-11-02T00:00:00Z'), '2026-11-02'); // Monday itself
		assert.equal(weekOf('2026-11-08T23:59:59Z'), '2026-11-02'); // Sunday
	});
});
