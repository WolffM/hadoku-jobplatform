/**
 * A service caller acting as a named person.
 *
 * This exists because the PC-side form runner authenticates as a SERVICE while
 * the queue is keyed to a PERSON. Without it the two can never see the same
 * rows — the runner drained its own service-owned queue for a day while the
 * owner's dashboard showed nothing at all.
 *
 * The gate is the entire security of the feature: a friend-tier caller is a
 * signed-in human in a browser, and letting one pass `owner=SomeoneElse` would
 * turn every per-user route into a way to read and mutate another person's
 * queue.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness, type Harness } from '../helpers/harness.ts';
import { seedJob, seedJobState } from '../helpers/seed.ts';

const BASE = '/jobplatform/api';
const HADOKU = 'user-hadoku'; // what the edge stub resolves "Hadoku" to
const SERVICE = 'the-service';

let h: Harness;

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
	await seedJob(h.db, { id: 'j1' });
});

function req<T>(path: string, init: Record<string, unknown>) {
	return h.json<T & { message: string; code?: string }>(`${BASE}${path}`, init as never);
}

describe('acting on behalf of a named owner', () => {
	it('queues the application under the OWNER, not the service', async () => {
		await seedJobState(h.db, {
			job_id: 'j1',
			user_id: HADOKU,
			state: 'interested',
			variant_slug: 'packet-1',
		});
		const { status } = await req(`/jobs/j1/apply`, {
			method: 'POST',
			tier: 'service',
			userId: SERVICE,
			body: JSON.stringify({ owner: 'Hadoku' }),
		});
		assert.equal(status, 200);
		const row = await h.db
			.prepare('SELECT user_id FROM applications WHERE job_id = ?')
			.bind('j1')
			.first<{ user_id: string }>();
		assert.equal(row?.user_id, HADOKU, 'the row must belong to the person, not the runner');
	});

	it("reads the owner's queue rather than its own", async () => {
		const now = new Date().toISOString();
		await h.db
			.prepare(
				`INSERT INTO applications (id, user_id, job_id, variant_slug, mode, status, created_at, updated_at)
				 VALUES ('a1', ?, 'j1', 'v', 'review', 'queued', ?, ?)`
			)
			.bind(HADOKU, now, now)
			.run();

		const mine = await req<{ data: { applications: unknown[] } }>('/applications', {
			method: 'GET',
			tier: 'service',
			userId: SERVICE,
		});
		assert.equal(mine.body.data.applications.length, 0, 'the service owns nothing');

		const theirs = await req<{ data: { applications: unknown[] } }>('/applications?owner=Hadoku', {
			method: 'GET',
			tier: 'service',
			userId: SERVICE,
		});
		assert.equal(theirs.body.data.applications.length, 1);
	});

	it('transitions a row it does not own, when acting as the owner', async () => {
		const now = new Date().toISOString();
		await h.db
			.prepare(
				`INSERT INTO applications (id, user_id, job_id, variant_slug, mode, status, created_at, updated_at)
				 VALUES ('a2', ?, 'j1', 'v', 'review', 'queued', ?, ?)`
			)
			.bind(HADOKU, now, now)
			.run();
		const { status } = await req('/applications/a2/status', {
			method: 'POST',
			tier: 'service',
			userId: SERVICE,
			body: JSON.stringify({ status: 'filled', owner: 'Hadoku' }),
		});
		assert.equal(status, 200);
	});

	it("reads the owner's standing answers", async () => {
		const now = new Date().toISOString();
		await h.db
			.prepare(
				`INSERT INTO application_answers (user_id, question_key, question, answer, created_at, updated_at)
				 VALUES (?, 'gender', 'Gender', 'Decline To Self Identify', ?, ?)`
			)
			.bind(HADOKU, now, now)
			.run();
		const { body } = await req<{ data: { answers: unknown[] } }>(
			'/application-answers?owner=Hadoku',
			{ method: 'GET', tier: 'service', userId: SERVICE }
		);
		assert.equal(body.data.answers.length, 1);
	});
});

describe('only a service or admin may act as someone else', () => {
	it('refuses a friend-tier caller — this is the whole gate', async () => {
		// A signed-in human in a browser. If this passed, every per-user route
		// would become a way to read and mutate another person's queue.
		const { status, body } = await req('/applications?owner=Hadoku', {
			method: 'GET',
			tier: 'friend',
			userId: 'some-human',
		});
		assert.equal(status, 403);
		assert.match(body.message, /service or admin/i);
	});

	it('refuses a friend-tier caller on the write path too', async () => {
		await seedJobState(h.db, {
			job_id: 'j1',
			user_id: HADOKU,
			state: 'interested',
			variant_slug: 'p',
		});
		const { status } = await req('/jobs/j1/apply', {
			method: 'POST',
			tier: 'friend',
			userId: 'some-human',
			body: JSON.stringify({ owner: 'Hadoku' }),
		});
		assert.equal(status, 403);
	});

	it('still serves a friend their OWN rows', async () => {
		// The gate is on impersonation, not on the routes themselves.
		const { status } = await req('/applications', {
			method: 'GET',
			tier: 'friend',
			userId: 'some-human',
		});
		assert.equal(status, 200);
	});

	it('an unknown owner name is 404, not a silent self-claim', async () => {
		// The dangerous failure would be falling back to the CALLER: the runner
		// would queue onto its own service identity and look like it worked.
		const { status, body } = await req('/applications?owner=Nobody', {
			method: 'GET',
			tier: 'service',
			userId: SERVICE,
		});
		assert.equal(status, 404);
		assert.equal(body.code, 'NAME_NOT_FOUND');
	});

	it("an unreachable resolver is 503, never someone else's data", async () => {
		const solo = await createHarness({ edge: null });
		try {
			const { status, body } = await solo.json<{ code?: string }>(
				`${BASE}/applications?owner=Hadoku`,
				{ method: 'GET', tier: 'service', userId: SERVICE }
			);
			assert.equal(status, 503);
			assert.equal(body.code, 'NO_REGISTRY');
		} finally {
			await solo.dispose();
		}
	});
});
