/**
 * A service caller acting as a named person.
 *
 * This exists because the PC-side form runner authenticates as a SERVICE while
 * the queue is keyed to a PERSON. Without it the two can never see the same
 * rows — the runner drained its own service-owned queue for a day while the
 * owner's dashboard showed nothing at all.
 *
 * The gate is the entire security of the feature: a friend-tier caller is a
 * signed-in human in a browser, and letting one pass `ownerName=SomeoneElse` would
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
			body: JSON.stringify({ ownerName: 'Hadoku' }),
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

		const theirs = await req<{ data: { applications: unknown[] } }>(
			'/applications?ownerName=Hadoku',
			{
				method: 'GET',
				tier: 'service',
				userId: SERVICE,
			}
		);
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
			body: JSON.stringify({ status: 'filled', ownerName: 'Hadoku' }),
		});
		assert.equal(status, 200);
	});

	it('takes ownerName from the QUERY on a POST, not only from the body', async () => {
		// The bug this holds shut: the POSTs read the body and the GETs read the
		// query, so `POST /jobs/j1/apply?ownerName=Hadoku` was accepted, ignored,
		// and the row queued onto the CALLER. Nothing in the response says so —
		// it is a 200 with a valid-looking application belonging to the wrong
		// person, and it is only visible when the owner's dashboard stays empty.
		await seedJobState(h.db, {
			job_id: 'j1',
			user_id: HADOKU,
			state: 'interested',
			variant_slug: 'packet-1',
		});
		const { status } = await req('/jobs/j1/apply?ownerName=Hadoku', {
			method: 'POST',
			tier: 'service',
			userId: SERVICE,
			body: JSON.stringify({}),
		});
		assert.equal(status, 200);
		const row = await h.db
			.prepare('SELECT user_id FROM applications WHERE job_id = ?')
			.bind('j1')
			.first<{ user_id: string }>();
		assert.equal(row?.user_id, HADOKU, 'the query form must reach the same person as the body');
	});

	it('rejects an unknown owner name given in the query, rather than silently using the caller', async () => {
		// The tell that the parameter was being dropped: a name that resolves to
		// nobody came back 200 instead of 404.
		await seedJobState(h.db, {
			job_id: 'j1',
			user_id: HADOKU,
			state: 'interested',
			variant_slug: 'packet-1',
		});
		const { status, body } = await req('/jobs/j1/apply?ownerName=Nobody', {
			method: 'POST',
			tier: 'service',
			userId: SERVICE,
			body: JSON.stringify({}),
		});
		assert.equal(status, 404);
		assert.equal(body.code, 'NAME_NOT_FOUND');
	});

	it('lets the body win when both name it', async () => {
		await seedJobState(h.db, {
			job_id: 'j1',
			user_id: HADOKU,
			state: 'interested',
			variant_slug: 'packet-1',
		});
		const { status } = await req('/jobs/j1/apply?ownerName=Nobody', {
			method: 'POST',
			tier: 'service',
			userId: SERVICE,
			body: JSON.stringify({ ownerName: 'Hadoku' }),
		});
		assert.equal(status, 200, 'the body is the explicit one and outranks the query');
	});

	it('transitions a row using the query form too', async () => {
		const now = new Date().toISOString();
		await h.db
			.prepare(
				`INSERT INTO applications (id, user_id, job_id, variant_slug, mode, status, created_at, updated_at)
				 VALUES ('a3', ?, 'j1', 'v', 'review', 'queued', ?, ?)`
			)
			.bind(HADOKU, now, now)
			.run();
		const { status } = await req('/applications/a3/status?ownerName=Hadoku', {
			method: 'POST',
			tier: 'service',
			userId: SERVICE,
			body: JSON.stringify({ status: 'filled' }),
		});
		assert.equal(status, 200);
	});

	it("reads the owner's question queue", async () => {
		// The queue is derived from the owner's applications, so it has to be
		// scoped the same way. Missing this left the reassignment looking like
		// it had lost the questions: the rows moved and the queue read zero.
		const now = new Date().toISOString();
		await h.db
			.prepare(
				`INSERT INTO applications (id, user_id, job_id, variant_slug, mode, status, evidence, created_at, updated_at)
				 VALUES ('q1', ?, 'j1', 'v', 'review', 'needs_manual', ?, ?, ?)`
			)
			.bind(HADOKU, JSON.stringify({ unmatched: ['Are you 18?'], options: {} }), now, now)
			.run();

		const asService = await req<{ data: { questions: { companies: string[] }[] } }>(
			'/unanswered-questions',
			{ method: 'GET', tier: 'service', userId: SERVICE }
		);
		assert.equal(
			asService.body.data.questions.filter((q) => q.companies.length).length,
			0,
			'the service owns no applications, so it has no real questions'
		);

		const asOwner = await req<{ data: { questions: { companies: string[] }[] } }>(
			'/unanswered-questions?ownerName=Hadoku',
			{ method: 'GET', tier: 'service', userId: SERVICE }
		);
		assert.equal(asOwner.body.data.questions.filter((q) => q.companies.length).length, 1);
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
			'/application-answers?ownerName=Hadoku',
			{ method: 'GET', tier: 'service', userId: SERVICE }
		);
		assert.equal(body.data.answers.length, 1);
	});
});

describe('only a service or admin may act as someone else', () => {
	it('refuses a friend-tier caller — this is the whole gate', async () => {
		// A signed-in human in a browser. If this passed, every per-user route
		// would become a way to read and mutate another person's queue.
		const { status, body } = await req('/applications?ownerName=Hadoku', {
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
			body: JSON.stringify({ ownerName: 'Hadoku' }),
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
		const { status, body } = await req('/applications?ownerName=Nobody', {
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
				`${BASE}/applications?ownerName=Hadoku`,
				{ method: 'GET', tier: 'service', userId: SERVICE }
			);
			assert.equal(status, 503);
			assert.equal(body.code, 'NO_REGISTRY');
		} finally {
			await solo.dispose();
		}
	});
});

/**
 * Standing answers, written on the owner's behalf.
 *
 * The GET here has always taken `ownerName`; the PUT and DELETE did not, so a
 * service could read the owner's answers but never store one — which meant the
 * runner could be blocked on six screening questions it had no way to resolve
 * except by a human opening the dashboard.
 *
 * The asymmetry with `POST /applications/:id/approve` is deliberate and stays:
 * approval is CONSENT to send a specific filled form, so it is owner-only. An
 * answer is a fact about the owner that writing does not send anywhere.
 */
describe('standing answers on behalf of a named owner', () => {
	const put = (body: Record<string, unknown>, init: Record<string, unknown>) =>
		req<{ data: { answer: { question_key: string } } }>('/application-answers', {
			method: 'PUT',
			body: JSON.stringify(body),
			...init,
		});

	const storedFor = async (userId: string) =>
		(
			await h.db
				.prepare('SELECT question, answer FROM application_answers WHERE user_id = ?')
				.bind(userId)
				.all<{ question: string; answer: string }>()
		).results;

	it('stores the answer under the OWNER, not the service', async () => {
		const { status } = await put(
			{
				question: 'What U.S State do you currently reside in?',
				answer: 'Washington',
				ownerName: 'Hadoku',
			},
			{ tier: 'service', userId: SERVICE }
		);
		assert.equal(status, 200);

		assert.deepEqual(
			(await storedFor(HADOKU)).map((r) => r.answer),
			['Washington'],
			'the answer must land on the person the runner is acting for'
		);
		assert.deepEqual(await storedFor(SERVICE), [], 'and nothing on the service itself');
	});

	it('lets the service delete one on the owner’s behalf, by query', async () => {
		await put(
			{ question: 'Website', answer: 'https://hadoku.me', ownerName: 'Hadoku' },
			{ tier: 'service', userId: SERVICE }
		);
		const key = (await storedFor(HADOKU)).length;
		assert.equal(key, 1, 'seeded');

		// DELETE carries no body, so the query string is the only channel.
		const { status } = await req('/application-answers/website?ownerName=Hadoku', {
			method: 'DELETE',
			tier: 'service',
			userId: SERVICE,
		});
		assert.equal(status, 200);
		assert.deepEqual(await storedFor(HADOKU), [], 'the owner’s answer is gone');
	});

	it('refuses a friend-tier caller naming someone else', async () => {
		const { status, body } = await put(
			{ question: 'Website', answer: 'https://evil.example', ownerName: 'Hadoku' },
			{ tier: 'friend', userId: 'some-human' }
		);
		assert.equal(status, 403, 'a signed-in human must not write to another person’s answers');
		assert.match(body.message, /service or admin/i);
		assert.deepEqual(await storedFor(HADOKU), []);
	});

	it('still writes to the caller when no owner is named', async () => {
		const { status } = await put(
			{ question: 'Website', answer: 'https://mine.example' },
			{ tier: 'friend', userId: 'some-human' }
		);
		assert.equal(status, 200);
		assert.deepEqual(
			(await storedFor('some-human')).map((r) => r.answer),
			['https://mine.example']
		);
	});

	it('404s on a name that cannot be resolved, rather than writing to the caller', async () => {
		const { status } = await put(
			{ question: 'Website', answer: 'https://nope.example', ownerName: 'Nobody' },
			{ tier: 'service', userId: SERVICE }
		);
		assert.equal(status, 404, 'the one-request test: an unresolvable name must never 200');
		assert.deepEqual(await storedFor(SERVICE), [], 'and must not fall back to the caller');
	});
});
